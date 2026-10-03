package sframe

import (
	"errors"
	"testing"
	"time"
)

var (
	devA = [16]byte{0xaa}
	devB = [16]byte{0xbb}
	devC = [16]byte{0xcc}
)

// clock is a hand-moved time source for one ring.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newRing() (*KeyRing, *clock) {
	c := &clock{t: time.Unix(1_790_000_000, 0)}
	return NewKeyRing(c.now), c
}

// sealed is one Opus frame from leaf in epoch at (slot, seq), as a sender would emit it.
func sealed(t *testing.T, leaf uint16, epoch uint64, slot Slot, seq uint64) []byte {
	t.Helper()
	kid := KID(leaf, epoch)
	ctr, err := CTR(slot, 0, seq)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Protect(DeriveKeys(testBase, kid), kid, ctr, Opus, []byte{0xfc, byte(seq), 0x55})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

var roster = []RosterEntry{{Leaf: 0, Device: devA}, {Leaf: 1, Device: devB}, {Leaf: 2, Device: devC}}

func TestNonCanonicalKIDIsRejectedBeforeKeyDerivationAndCacheStaysRosterBound(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(5, testBase, roster, 2)
	for high := uint64(1); high <= 200; high++ {
		kid := KID(1, 5) | high<<24
		ctr, err := CTR(Mic, 0, high)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := Protect(DeriveKeys(testBase, kid), kid, ctr, Opus, []byte{0xfc, 1})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Decrypt(Opus, frame, &devB, Mic); !errors.Is(err, ErrNonCanonicalKID) {
			t.Fatalf("KID with high bits %d: %v, want %v", high, err, ErrNonCanonicalKID)
		}
	}
	if n := len(r.epochs[0].keys); n != 0 {
		t.Fatalf("rejected KIDs cached %d keys, want 0", n)
	}
	for seq := uint64(0); seq < 200; seq++ {
		if _, err := r.Decrypt(Opus, sealed(t, 1, 5, Mic, seq), &devB, Mic); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Decrypt(Opus, sealed(t, 0, 5, Mic, seq), &devA, Mic); err != nil {
			t.Fatal(err)
		}
		if n := len(r.epochs[0].keys); n != 2 {
			t.Fatalf("after seq %d cached %d keys, want one per remote leaf", seq, n)
		}
	}
}

func TestAnEpochSupersededLessThanTenSecondsAgoStillDecryptsAndThenIsStale(t *testing.T) {
	r, c := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	r.InstallEpoch(2, testBase, roster, 2)
	c.advance(9 * time.Second)
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 0), &devA, Mic); err != nil {
		t.Fatalf("epoch 1 nine seconds after it was superseded: %v", err)
	}
	c.advance(time.Second)
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 1), &devA, Mic); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("epoch 1 ten seconds after: %v, want %v", err, ErrStaleEpoch)
	}
	if _, err := r.Decrypt(Opus, sealed(t, 0, 2, Mic, 0), &devA, Mic); err != nil {
		t.Fatalf("the current epoch: %v", err)
	}
}

func TestEveryEpochInsideTheWindowIsKeptNotJustThePreviousOne(t *testing.T) {
	r, c := newRing()
	for e := uint64(1); e <= 4; e++ {
		r.InstallEpoch(e, testBase, roster, 2)
		c.advance(2 * time.Second)
	}
	for e := uint64(1); e <= 4; e++ {
		if _, err := r.Decrypt(Opus, sealed(t, 1, e, Mic, 0), &devB, Mic); err != nil {
			t.Errorf("epoch %d: %v", e, err)
		}
	}
}

// RFC 9605 §5.2: a new epoch evicts the held one with the same low byte, and a KID with that byte
// now names the new epoch, so an old frame fails authentication under the new key.
func TestAnEpochWithTheSameLowByteEvictsTheHeldOne(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	other := testBase
	other[0] = 0x0b
	r.InstallEpoch(257, other, roster, 2)
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 0), &devA, Mic); !errors.Is(err, ErrAuth) {
		t.Fatalf("an epoch-1 frame after epoch 257 arrived: %v, want %v", err, ErrAuth)
	}
}

func TestReinstallingAHeldEpochKeepsItsReplayWindow(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	f := sealed(t, 0, 1, Mic, 0)
	if _, err := r.Decrypt(Opus, f, &devA, Mic); err != nil {
		t.Fatal(err)
	}
	r.InstallEpoch(1, testBase, roster, 2)
	if _, err := r.Decrypt(Opus, f, &devA, Mic); !errors.Is(err, ErrReplay) {
		t.Fatalf("the same frame after a re-install: %v, want %v", err, ErrReplay)
	}
}

func TestAReplayedCounterIsRefusedAndTheWindowSlides(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	for _, c := range []struct {
		seq  uint64
		want error
	}{{0, nil}, {1, nil}, {1, ErrReplay}, {200, nil}, {50, ErrReplay}, {150, nil}, {150, ErrReplay}} {
		_, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, c.seq), &devA, Mic)
		if !errors.Is(err, c.want) {
			t.Errorf("seq %d: %v, want %v", c.seq, err, c.want)
		}
	}
	// The window is per (leaf, slot, layer): the same seq on another slot is fresh.
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, ScreenAudio, 1), &devA, ScreenAudio); err != nil {
		t.Errorf("seq 1 on screen audio: %v", err)
	}
}

func TestOwnKIDSlotSenderAndRosterBindingsAreRefused(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	if _, err := r.Decrypt(Opus, sealed(t, 2, 1, Mic, 0), &devC, Mic); !errors.Is(err, ErrOwnKID) {
		t.Errorf("own leaf: %v, want %v", err, ErrOwnKID)
	}
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 0), &devA, Camera); !errors.Is(err, ErrSlotMismatch) {
		t.Errorf("a microphone frame on a camera track: %v, want %v", err, ErrSlotMismatch)
	}
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 1), &devB, Mic); !errors.Is(err, ErrSenderMismatch) {
		t.Errorf("leaf 0's frame on device B's track: %v, want %v", err, ErrSenderMismatch)
	}
	if _, err := r.Decrypt(Opus, sealed(t, 7, 1, Mic, 0), &devA, Mic); !errors.Is(err, ErrLeafNotInEpoch) {
		t.Errorf("leaf 7: %v, want %v", err, ErrLeafNotInEpoch)
	}
}

func TestADeviceHoldingTwoLeavesInOneEpochIsRefused(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, []RosterEntry{{0, devA}, {1, devA}, {2, devC}}, 2)
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 0), &devA, Mic); !errors.Is(err, ErrSenderMismatch) {
		t.Fatalf("a device on two leaves: %v, want %v", err, ErrSenderMismatch)
	}
}

func TestAnEpochNotYetInstalledIsUnknownAndATamperedFrameFailsAuth(t *testing.T) {
	r, _ := newRing()
	r.InstallEpoch(1, testBase, roster, 2)
	if _, err := r.Decrypt(Opus, sealed(t, 0, 5, Mic, 0), &devA, Mic); !errors.Is(err, ErrUnknownKID) {
		t.Errorf("epoch 5: %v, want %v", err, ErrUnknownKID)
	}
	f := sealed(t, 0, 1, Mic, 0)
	f[len(f)-1] ^= 1
	if _, err := r.Decrypt(Opus, f, &devA, Mic); !errors.Is(err, ErrAuth) {
		t.Errorf("a flipped tag bit: %v, want %v", err, ErrAuth)
	}
	// A failed AEAD commits nothing: the honest frame with the same counter still decrypts.
	if _, err := r.Decrypt(Opus, sealed(t, 0, 1, Mic, 0), &devA, Mic); err != nil {
		t.Errorf("the untampered frame after the tampered one: %v", err)
	}
}
