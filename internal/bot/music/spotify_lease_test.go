package music

import (
	"errors"
	"os"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

func TestSpotifyLeaseAllowsOnlyOneSessionAcrossManagers(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	a, err := NewSpotifyLeaseManager(dir)
	if err != nil {
		info, _ := os.Stat(dir)
		t.Fatalf("%v; mode=%v", err, info.Mode())
	}
	b, err := NewSpotifyLeaseManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := a.Acquire(id.New(), id.New())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Acquire(id.New(), id.New()); !errors.Is(err, ErrSpotifyBusy) {
		t.Fatalf("same manager second session: %v", err)
	}
	if _, err := b.Acquire(id.New(), id.New()); !errors.Is(err, ErrSpotifyBusy) {
		t.Fatalf("second manager session: %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := b.Acquire(id.New(), id.New())
	if err != nil {
		t.Fatalf("lease after release: %v", err)
	}
	defer second.Release()
	if _, err := a.Acquire(id.New(), id.New()); !errors.Is(err, ErrSpotifyBusy) {
		t.Fatalf("stale release freed second lease: %v", err)
	}
}

func TestSpotifyLeaseRejectsInvalidOwner(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	m, err := NewSpotifyLeaseManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.Acquire(id.ID{}, id.New()); err == nil {
		t.Fatal("zero community accepted")
	}
	if _, err := m.Acquire(id.New(), id.ID{}); err == nil {
		t.Fatal("zero channel accepted")
	}
}
