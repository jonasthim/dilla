package sframe

import (
	"bytes"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

// The client-half crypto fixes (branch-review-client-docs.md part B), each mirrored by a Rust test
// in core/dilla-core/src/sframe that names the same property.

// baseFor is a distinct base key per epoch, as a real call has: the Rust tests' base(epoch).
func baseFor(epoch uint64) [16]byte {
	var b [16]byte
	for i := range b {
		b[i] = byte(epoch % 251)
	}
	return b
}

// sealedUnder is one Opus frame from leaf in epoch, sealed under that epoch's own base key.
func sealedUnder(t *testing.T, leaf uint16, epoch uint64, seq uint64) []byte {
	t.Helper()
	kid := KID(leaf, epoch)
	ctr, err := CTR(Mic, 0, seq)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Protect(DeriveKeys(baseFor(epoch), kid), kid, ctr, Opus, []byte{0xfc, byte(seq)})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

var abc = []RosterEntry{{Leaf: 0, Device: devA}, {Leaf: 1, Device: devB}, {Leaf: 2, Device: devC}}
var ab = []RosterEntry{{Leaf: 0, Device: devA}, {Leaf: 1, Device: devB}}

// CRYPTO-1 (Rust: a_member_the_newest_epoch_removed_is_refused_under_the_old_one).
func TestARemovedMembersOldEpochFramesAreRefused(t *testing.T) {
	r, c := newRing()
	r.InstallEpoch(5, baseFor(5), abc, 0)
	r.InstallEpoch(6, baseFor(6), ab, 0)
	c.advance(100 * time.Millisecond)
	if _, err := r.Decrypt(Opus, sealedUnder(t, 2, 5, 0), &devC, Mic); !errors.Is(err, ErrSenderMismatch) {
		t.Fatalf("carol's epoch-5 frame after her removal: %v, want %v", err, ErrSenderMismatch)
	}
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 5, 0), &devB, Mic); err != nil {
		t.Fatalf("bob's epoch-5 frame: %v", err)
	}
	if _, err := r.Decrypt(Opus, sealedUnder(t, 2, 5, 1), nil, Mic); !errors.Is(err, ErrSenderMismatch) {
		t.Fatalf("carol's epoch-5 frame without a track binding: %v, want %v", err, ErrSenderMismatch)
	}
}

// CRYPTO-3 (Rust: a_dropped_epoch_is_stale_for_twenty_seconds_then_unknown).
func TestADroppedEpochIsStaleForTwentySecondsThenUnknown(t *testing.T) {
	r, c := newRing()
	r.InstallEpoch(5, baseFor(5), abc, 0)
	r.InstallEpoch(6, baseFor(6), ab, 0)
	c.advance(10 * time.Second) // epoch 5 is dropped here
	for i, step := range []struct {
		after time.Duration
		want  error
	}{{0, ErrStaleEpoch}, {19999 * time.Millisecond, ErrStaleEpoch}, {5001 * time.Millisecond, ErrUnknownKID}} {
		c.advance(step.after)
		if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 5, uint64(i)), &devB, Mic); !errors.Is(err, step.want) {
			t.Fatalf("step %d: %v, want %v", i, err, step.want)
		}
	}
}

// CRYPTO-4 (Rust: an_install_more_than_255_epochs_old_neither_evicts_nor_installs).
func TestAnInstallMoreThan255EpochsOldNeitherEvictsNorInstalls(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(300, baseFor(300), abc, 0)
	r.InstallEpoch(44, baseFor(44), ab, 0)
	if len(r.epochs) != 1 || r.epochs[0].epoch != 300 {
		t.Fatalf("held %d epochs, newest %d; want only 300", len(r.epochs), r.epochs[0].epoch)
	}
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 300, 0), &devB, Mic); err != nil {
		t.Fatalf("epoch 300: %v", err)
	}
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 44, 1), &devB, Mic); !errors.Is(err, ErrAuth) {
		t.Fatalf("epoch 44 (byte 44 names 300): %v, want %v", err, ErrAuth)
	}
}

// CRYPTO-4 (Rust: a_dropped_epoch_installed_again_stays_dropped).
func TestADroppedEpochInstalledAgainStaysDropped(t *testing.T) {
	r, c := newRing()
	r.InstallEpoch(5, baseFor(5), abc, 0)
	r.InstallEpoch(6, baseFor(6), ab, 0)
	c.advance(10 * time.Second)
	r.mu.Lock()
	r.expireLocked(c.now())
	r.mu.Unlock()
	c.advance(time.Second)
	r.InstallEpoch(5, baseFor(5), ab, 0)
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 5, 0), &devB, Mic); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("re-installed dropped epoch: %v, want %v", err, ErrStaleEpoch)
	}
	if len(r.epochs) != 1 {
		t.Fatalf("held %d epochs, want 1", len(r.epochs))
	}
}

// CRYPTO-4 (Rust: a_new_epoch_drops_held_epochs_more_than_255_behind_it).
func TestANewEpochDropsHeldEpochsMoreThan255BehindIt(t *testing.T) {
	r, c := newRing()
	r.InstallEpoch(10, baseFor(10), abc, 0)
	c.advance(100 * time.Millisecond)
	r.InstallEpoch(300, baseFor(300), ab, 0)
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 10, 0), &devB, Mic); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("epoch 10 under newest 300: %v, want %v", err, ErrStaleEpoch)
	}
	if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 300, 0), &devB, Mic); err != nil {
		t.Fatalf("epoch 300: %v", err)
	}
}

// CRYPTO-8: a dropped epoch's base key and derived keys are zeroed and the backing array no longer
// points at it, for expiry and for the same-mod-256 eviction alike.
func TestADroppedEpochsKeyMaterialIsZeroedAndUnreachable(t *testing.T) {
	for _, tc := range []struct {
		name        string
		setup, drop func(r *KeyRing, c *clock)
	}{
		{"expired", func(r *KeyRing, _ *clock) {
			r.InstallEpoch(6, baseFor(6), ab, 0)
		}, func(r *KeyRing, c *clock) {
			c.advance(10 * time.Second)
			r.InstallEpoch(7, baseFor(7), ab, 0)
		}},
		{"evicted by the same low byte", func(*KeyRing, *clock) {}, func(r *KeyRing, _ *clock) {
			r.InstallEpoch(261, baseFor(261), ab, 0)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, c := newRing()
			r.InstallEpoch(5, baseFor(5), abc, 0)
			if _, err := r.Decrypt(Opus, sealedUnder(t, 1, 5, 0), &devB, Mic); err != nil {
				t.Fatal(err)
			}
			tc.setup(r, c)
			held := r.epochs[len(r.epochs)-1]
			if held.epoch != 5 || len(held.keys) != 1 {
				t.Fatalf("oldest held epoch %d caches %d keys, want epoch 5 with 1", held.epoch, len(held.keys))
			}
			// The array the drop runs over: an install may reallocate afterwards, but only after
			// the drop cleared this one.
			backing := r.epochs[:cap(r.epochs)]
			tc.drop(r, c)
			if held.baseKey != ([16]byte{}) {
				t.Fatalf("the dropped base key is %x, want zeros", held.baseKey)
			}
			if len(held.keys) != 0 {
				t.Fatalf("the dropped epoch still holds %d keys", len(held.keys))
			}
			for i, e := range backing {
				if e == held {
					t.Fatalf("the backing array still points at the dropped epoch at %d", i)
				}
			}
		})
	}
}

// CRYPTO-7 (Rust: ctr_refuses_a_reserved_slot_first): slots 4-255 are reserved.
func TestAReservedSlotIsRefusedAndSpendsNoCounter(t *testing.T) {
	for _, slot := range []Slot{4, 5, 0xff} {
		if _, err := CTR(slot, 0, 0); !errors.Is(err, ErrSlotMismatch) {
			t.Fatalf("CTR(%d, 0, 0) = %v, want %v", slot, err, ErrSlotMismatch)
		}
	}
	if _, err := CTR(4, 16, MaxSeq+1); !errors.Is(err, ErrSlotMismatch) {
		t.Fatalf("CTR(4, 16, MaxSeq+1) = %v, want the slot first", err)
	}
	s, err := NewSender(testBase, 0, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Encrypt(Opus, 4, 0, []byte{0xfc}); !errors.Is(err, ErrSlotMismatch) {
		t.Fatalf("Encrypt on slot 4 = %v, want %v", err, ErrSlotMismatch)
	}
	if len(s.next) != 0 {
		t.Fatalf("a refused slot spent a counter: %v", s.next)
	}
}

// CRYPTO-5 (Rust: aud_and_filler_before_the_first_slice_are_dropped): an AUD-led access unit, as a
// Go publisher that does not use internal/media's builder would hand in, seals with a P that lacks
// the AUD and opens after the round trip pion's packetiser makes (which drops the AUD).
func TestAnAUDLedAccessUnitSealsWithoutTheAUDInItsPrefix(t *testing.T) {
	in, _ := hex.DecodeString("0000000109f0" + "000000010cffff" + "0000000168ce3c80" + "00000001658884aabb" + "000000010cff")
	canonical, p, err := canonicalizeH264(in)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(canonical); got != "0000000168ce3c80"+"00000001658884aabb"+"000000010cff" {
		t.Fatalf("canonical = %s", got)
	}
	if p != 8+4+1+2 {
		t.Fatalf("prefix = %d, want 15", p)
	}
	s, err := NewSender(testBase, 1, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Encrypt(H264, Camera, 0, in)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out[:p], []byte{0, 0, 0, 1, 0x09}) {
		t.Fatalf("the sealed prefix still carries the AUD: %x", out[:p])
	}
	r, _ := newRing()
	r.InstallEpoch(5, testBase, abc, 0)
	dec, err := r.Decrypt(H264, out, &devB, Camera)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(dec.Frame, canonical) {
		t.Fatalf("opened %x, want the canonical frame %x", dec.Frame, canonical)
	}
}
