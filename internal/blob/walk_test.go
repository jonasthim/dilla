package blob_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWalkVisitsEveryFinishedObjectAndSkipsTempFiles(t *testing.T) {
	s, dir := newStore(t)
	want := map[string]int64{}
	for _, p := range []string{"one", "two, longer"} {
		sum := sha256.Sum256([]byte(p))
		if _, _, err := s.Put(t.Context(), sum[:], strings.NewReader(p), 1<<20); err != nil {
			t.Fatalf("Put: %v", err)
		}
		want[hex.EncodeToString(sum[:])] = int64(len(p))
	}
	shard := filepath.Join(dir, "att", "aa", "bb")
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(shard, "aabb00.tmp-deadbeef"), []byte("half"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	got := map[string]int64{}
	if err := s.Walk(func(name string, size int64) error { got[name] = size; return nil }); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("Walk saw %v, want %v", got, want)
	}
	for name, size := range want {
		if got[name] != size {
			t.Fatalf("Walk saw %v, want %v", got, want)
		}
	}
}

func TestWalkOfAnEmptyStoreIsNotAnError(t *testing.T) {
	s, _ := newStore(t)
	if err := s.Walk(func(string, int64) error {
		t.Fatal("visited a file in an empty store")
		return nil
	}); err != nil {
		t.Fatalf("Walk: %v", err)
	}
}
