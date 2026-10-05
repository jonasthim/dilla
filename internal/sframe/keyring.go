package sframe

import (
	"slices"
	"sync"
	"time"
)

// RosterEntry is one leaf of an epoch and the device that holds it.
type RosterEntry struct {
	Leaf   uint16
	Device [16]byte
}

// Decrypted is a frame the ring authenticated: who sent it, under which epoch, and P || plaintext.
type Decrypted struct {
	KID, CTR, Epoch uint64
	Leaf            uint16
	Frame           []byte
}

type replayKey struct {
	leaf        uint16
	slot, layer uint8
}

// replayWindow is RFC 3711 §3.3.2 over 128 bits: bit i of bits is highest - i.
type replayWindow struct {
	highest uint64
	bits    [2]uint64
}

func (w *replayWindow) empty() bool       { return w.bits == [2]uint64{} }
func (w *replayWindow) has(i uint64) bool { return w.bits[i/64]>>(i%64)&1 == 1 }
func (w *replayWindow) set(i uint64)      { w.bits[i/64] |= 1 << (i % 64) }
func (w *replayWindow) shift(n uint64) {
	switch {
	case n >= 128:
		w.bits = [2]uint64{}
	case n >= 64:
		w.bits = [2]uint64{0, w.bits[0] << (n - 64)}
	case n > 0:
		w.bits = [2]uint64{w.bits[0] << n, w.bits[1]<<n | w.bits[0]>>(64-n)}
	}
}

func (w *replayWindow) check(seq uint64) error {
	if w.empty() || seq > w.highest {
		return nil
	}
	if behind := w.highest - seq; behind >= ReplayWindow || w.has(behind) {
		return ErrReplay
	}
	return nil
}

func (w *replayWindow) commit(seq uint64) {
	switch {
	case w.empty():
		w.highest = seq
		w.set(0)
	case seq > w.highest:
		w.shift(seq - w.highest)
		w.set(0)
		w.highest = seq
	default:
		if behind := w.highest - seq; behind < ReplayWindow {
			w.set(behind)
		}
	}
}

type epochEntry struct {
	epoch        uint64
	baseKey      [16]byte
	ownLeaf      int
	roster       []RosterEntry
	superseded   bool
	supersededAt time.Time
	keys         map[uint16]Keys
	replay       map[replayKey]*replayWindow
}

type retiredEpoch struct {
	epoch uint64
	at    time.Time
}

// KeyRing holds every epoch superseded less than OldEpochRetention ago, newest first, each with
// the roster current in it — the Rust KeyRing of task 5, rule for rule. A frame's KID resolves to
// exactly one held epoch (installing an epoch evicts a held one with the same epoch mod 256) and is
// bound, in that epoch, to the device the track belongs to. Safe for concurrent use: one ring
// serves every DecryptLoop of a participant.
type KeyRing struct {
	mu              sync.Mutex
	now             func() time.Time
	epochs          []*epochEntry
	retired         []retiredEpoch
	droppedFloor    uint64 // highest epoch ever dropped; older installs can never revive it
	hasDroppedFloor bool
}

// NewKeyRing reads time from now (time.Now when nil).
func NewKeyRing(now func() time.Time) *KeyRing {
	if now == nil {
		now = time.Now
	}
	return &KeyRing{now: now}
}

// InstallEpoch installs epoch with its base key, its roster and this device's own leaf in it (-1:
// none). Installing a held epoch is a no-op, so a repeat never resets a replay window. Otherwise it
// drops every epoch superseded OldEpochRetention ago; ignores an epoch older than the newest held
// one that this ring dropped, or that is more than KIDEpochWindow (255) commits behind it, so a late
// install can neither evict the current epoch nor revive a dropped one; evicts a held epoch with the
// same epoch mod 256 (RFC 9605 §5.2); and, when epoch is the newest, marks the previous current
// epoch superseded now and drops every held epoch more than 255 commits behind it.
func (r *KeyRing) InstallEpoch(epoch uint64, baseKey [16]byte, roster []RosterEntry, ownLeaf int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.expireLocked(now)
	for _, e := range r.epochs {
		if e.epoch == epoch {
			return
		}
	}
	if len(r.epochs) > 0 && epoch < r.epochs[0].epoch {
		if r.epochs[0].epoch-epoch > KIDEpochWindow || (r.hasDroppedFloor && epoch <= r.droppedFloor) {
			return
		}
	}
	low := epoch % 256
	r.epochs = r.dropLocked(func(e *epochEntry) bool { return e.epoch%256 == low })
	r.retired = slices.DeleteFunc(r.retired, func(x retiredEpoch) bool { return x.epoch%256 == low })
	newest := len(r.epochs) == 0 || epoch > r.epochs[0].epoch
	if newest {
		for _, e := range r.epochs {
			if !e.superseded {
				e.superseded, e.supersededAt = true, now
			}
		}
		// protocol/05 "Rotation": a KID never resolves against an epoch more than 255 commits behind
		// the newest; such an epoch is dropped (and so ErrStaleEpoch).
		r.epochs = r.dropLocked(func(e *epochEntry) bool {
			if epoch-e.epoch <= KIDEpochWindow {
				return false
			}
			r.retired = append(r.retired, retiredEpoch{epoch: e.epoch, at: now})
			return true
		})
	}
	entry := &epochEntry{
		epoch: epoch, baseKey: baseKey, ownLeaf: ownLeaf, roster: slices.Clone(roster),
		keys: map[uint16]Keys{}, replay: map[replayKey]*replayWindow{},
	}
	if !newest {
		entry.superseded, entry.supersededAt = true, now
	}
	at := len(r.epochs)
	for i, e := range r.epochs {
		if e.epoch < epoch {
			at = i
			break
		}
	}
	r.epochs = slices.Insert(r.epochs, at, entry)
}

// expireLocked drops every epoch superseded OldEpochRetention ago or more, remembering it for two
// retention periods so a late frame of it is ErrStaleEpoch (dropped) rather than ErrUnknownKID (held).
// After that a frame of it is ErrUnknownKID (protocol/05 "Rotation" states the bound).
func (r *KeyRing) expireLocked(now time.Time) {
	r.epochs = r.dropLocked(func(e *epochEntry) bool {
		if !e.superseded || now.Sub(e.supersededAt) < OldEpochRetention {
			return false
		}
		r.retired = append(r.retired, retiredEpoch{epoch: e.epoch, at: now})
		return true
	})
	r.retired = slices.DeleteFunc(r.retired, func(x retiredEpoch) bool { return now.Sub(x.at) >= 2*OldEpochRetention })
}

// dropLocked removes every held epoch gone reports true for, zeroing its base key and derived keys
// first and clearing the tail of the backing array, so no dropped entry stays reachable from it.
// Zeroing is best effort: this ring is test, rig and bot tooling (the browser's ring is the Rust
// core's), and Go may have copied a key elsewhere (a stack, a register spill) before this runs.
func (r *KeyRing) dropLocked(gone func(*epochEntry) bool) []*epochEntry {
	keep := r.epochs[:0]
	n := len(r.epochs)
	for _, e := range r.epochs {
		if gone(e) {
			if !r.hasDroppedFloor || e.epoch > r.droppedFloor {
				r.droppedFloor, r.hasDroppedFloor = e.epoch, true
			}
			e.wipe()
			continue
		}
		keep = append(keep, e)
	}
	clear(r.epochs[len(keep):n])
	return keep
}

// wipe zeroes the entry's base key and every key derived from it.
func (e *epochEntry) wipe() {
	clear(e.baseKey[:])
	for leaf, k := range e.keys {
		clear(k.Key[:])
		clear(k.Salt[:])
		e.keys[leaf] = k
	}
	clear(e.keys)
}

// Decrypt authenticates one received frame for the track whose participant is expectedDevice (nil:
// no binding) and whose LiveKit source maps to expectedSlot. protocol/05's order: parse; resolve the
// KID to its exact epoch (ErrUnknownKID — the only error a caller may hold a frame for — or
// ErrStaleEpoch); the leaf in that epoch's roster (ErrLeafNotInEpoch); the roster's device against
// the track's, refusing a device on two leaves and a superseded epoch's frame whose device is not in
// the newest held roster, a removed member (ErrSenderMismatch); own KID (ErrOwnKID); replay
// (ErrReplay); AEAD (ErrAuth); the authenticated slot (ErrSlotMismatch); only then the replay window
// is committed.
func (r *KeyRing) Decrypt(c Codec, frame []byte, expectedDevice *[16]byte, expectedSlot Slot) (Decrypted, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.expireLocked(r.now())
	x, p, err := UnescapeProtected(c, frame)
	if err != nil {
		return Decrypted{}, err
	}
	kid, ctr, _, err := peekKIDCTR(p, x)
	if err != nil {
		return Decrypted{}, err
	}
	low := kid & 0xff
	var e *epochEntry
	at := -1
	for i, cand := range r.epochs {
		if cand.epoch%256 == low {
			e, at = cand, i
			break
		}
	}
	if e == nil {
		for _, gone := range r.retired {
			if gone.epoch%256 == low {
				return Decrypted{}, ErrStaleEpoch
			}
		}
		return Decrypted{}, ErrUnknownKID
	}
	leaf := uint16(kid >> 8) //nolint:gosec // G115: the KID's leaf field is 16 bits; the Rust core masks the same way
	var device [16]byte
	found := false
	for _, m := range e.roster {
		if m.Leaf == leaf {
			device, found = m.Device, true
			break
		}
	}
	if !found {
		return Decrypted{}, ErrLeafNotInEpoch
	}
	if expectedDevice != nil {
		held := 0
		for _, m := range e.roster {
			if m.Device == *expectedDevice {
				held++
			}
		}
		if device != *expectedDevice || held != 1 {
			return Decrypted{}, ErrSenderMismatch
		}
	}
	// protocol/05 "Rotation": a superseded epoch is accepted only from a device that is also in the
	// newest held roster. A member the newest epoch removed keeps the old epoch's key for the
	// retention period; without this its frames would still authenticate and render.
	if at != 0 && !slices.ContainsFunc(r.epochs[0].roster, func(m RosterEntry) bool { return m.Device == device }) {
		return Decrypted{}, ErrSenderMismatch
	}
	if e.ownLeaf >= 0 && e.ownLeaf == int(leaf) {
		return Decrypted{}, ErrOwnKID
	}
	rk := replayKey{leaf: leaf, slot: ctrSlot(ctr), layer: ctrLayer(ctr)}
	if w := e.replay[rk]; w != nil {
		if err := w.check(ctrSeq(ctr)); err != nil {
			return Decrypted{}, err
		}
	}
	keys, ok := e.keys[leaf]
	if !ok {
		keys = DeriveKeys(e.baseKey, kid)
		e.keys[leaf] = keys
	}
	_, _, out, err := OpenFrame(keys, p, x)
	if err != nil {
		return Decrypted{}, err
	}
	if ctrSlot(ctr) != uint8(expectedSlot) {
		return Decrypted{}, ErrSlotMismatch
	}
	w := e.replay[rk]
	if w == nil {
		w = &replayWindow{}
		e.replay[rk] = w
	}
	w.commit(ctrSeq(ctr))
	return Decrypted{KID: kid, CTR: ctr, Epoch: e.epoch, Leaf: leaf, Frame: out}, nil
}
