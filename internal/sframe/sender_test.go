package sframe

import (
	"errors"
	"testing"
)

func ctrOf(t *testing.T, frame []byte, prefix int) uint64 {
	t.Helper()
	_, ctr, _, err := DecodeHeader(frame[prefix:])
	if err != nil {
		t.Fatalf("DecodeHeader: %v", err)
	}
	return ctr
}

// N3: one counter per (epoch, slot, layer), never reset by a rekey.
func TestTheSenderPartitionsItsCounters(t *testing.T) {
	s, err := NewSender(testBase, 3, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	opus := []byte{0xfc, 1, 2}
	seq := func(slot Slot, layer uint8) uint64 {
		t.Helper()
		out, err := s.Encrypt(Opus, slot, layer, opus)
		if err != nil {
			t.Fatalf("Encrypt: %v", err)
		}
		return ctrOf(t, out, 0) & MaxSeq
	}
	if a, b, c := seq(Mic, 0), seq(Mic, 0), seq(Mic, 1); a != 0 || b != 1 || c != 0 {
		t.Fatalf("mic/0 twice then mic/1 = %d %d %d, want 0 1 0", a, b, c)
	}
	s.Rekey(testBase, 3, 6)
	if got := seq(Mic, 0); got != 0 {
		t.Fatalf("epoch 6 mic/0 = %d, want 0", got)
	}
	s.Rekey(testBase, 3, 5)
	if got := seq(Mic, 0); got != 2 {
		t.Fatalf("back in epoch 5, mic/0 = %d, want 2: a rekey must not reset a counter", got)
	}
}

// N1: a sender made after its device committed epoch min_epoch never encrypts below it.
func TestTheSenderRefusesEpochsBelowItsFloor(t *testing.T) {
	if _, err := NewSender(testBase, 1, 4, 5); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("NewSender below the floor: %v, want %v", err, ErrStaleEpoch)
	}
	s, err := NewSender(testBase, 1, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	s.Rekey(testBase, 1, 4)
	if _, err := s.Encrypt(Opus, Mic, 0, []byte{1}); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("Encrypt below the floor: %v, want %v", err, ErrStaleEpoch)
	}
}

func TestTheSenderRefusesOnWrapAndOutOfRangeLayers(t *testing.T) {
	s, err := NewSender(testBase, 1, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	s.next[counterKey{epoch: 5, slot: Mic, layer: 0}] = MaxSeq
	if _, err := s.Encrypt(Opus, Mic, 0, []byte{1}); err != nil {
		t.Fatalf("the last sequence number: %v", err)
	}
	if _, err := s.Encrypt(Opus, Mic, 0, []byte{1}); !errors.Is(err, ErrCounterExhausted) {
		t.Fatalf("past MaxSeq: %v, want %v", err, ErrCounterExhausted)
	}
	if !s.Exhausted() {
		t.Fatal("Exhausted() is false after a refusal")
	}
	if _, err := s.Encrypt(Opus, Mic, 16, []byte{1}); !errors.Is(err, ErrLayerRange) {
		t.Fatalf("layer 16: %v, want %v", err, ErrLayerRange)
	}
}

// An H.264 frame whose SPS a libwebrtc receiver would rewrite is refused before a counter is spent.
func TestTheSenderRefusesANonCanonicalSPSWithoutSpendingACounter(t *testing.T) {
	s, err := NewSender(testBase, 1, 5, 5)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Encrypt(H264, Camera, 0, unhex(t, vectorH264)); !errors.Is(err, ErrNonCanonicalSPS) {
		t.Fatalf("synthetic SPS: %v, want %v", err, ErrNonCanonicalSPS)
	}
	good := unhex(t, "00000001"+stableSPS+"0000000168ce3c800000000165888421ff00000312345a5a5a5a")
	out, err := s.Encrypt(H264, Camera, 0, good)
	if err != nil {
		t.Fatalf("stable SPS: %v", err)
	}
	x, n, err := UnescapeProtected(H264, out)
	if err != nil {
		t.Fatal(err)
	}
	if seq := ctrOf(t, x, n) & MaxSeq; seq != 0 {
		t.Fatalf("first accepted frame has seq %d, want 0: the refused one spent a counter", seq)
	}
}
