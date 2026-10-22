package mlswasi

import (
	"context"
	"testing"
)

func TestExtractAuthenticatedRosterReturnsVerifiedDescriptors(t *testing.T) {
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{CacheDir: sharedCacheDir(t), PoolSize: 1})
	ctx := context.Background()
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Release()
	got, err := inst.ExtractAuthenticatedRoster(ctx, f.ratchetTree, f.groupInfo)
	if err != nil {
		t.Fatalf("ExtractAuthenticatedRoster: %v", err)
	}
	if len(got) != f.manifest.Leaves || len(got) != 1500 {
		t.Fatalf("roster leaves = %d, want %d", len(got), f.manifest.Leaves)
	}
	for n, leaf := range got {
		if len(leaf.UserID) != 16 || len(leaf.DeviceID) != 16 || len(leaf.DSKPub) != 32 || leaf.Tier > 1 || leaf.Kind > 1 {
			t.Fatalf("leaf %d has invalid descriptor: %+v", n, leaf)
		}
	}

	tampered := append([]byte(nil), f.groupInfo...)
	tampered[len(tampered)-1] ^= 1
	if _, err := inst.ExtractAuthenticatedRoster(ctx, f.ratchetTree, tampered); err == nil {
		t.Fatal("tampered GroupInfo produced a roster")
	}
}

func TestExtractAuthenticatedRosterRejectsOversizedInputsBeforeWasm(t *testing.T) {
	r := newTestRuntime(t, Options{CacheDir: sharedCacheDir(t), PoolSize: 1})
	ctx := context.Background()
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Release()
	if _, err := inst.ExtractAuthenticatedRoster(ctx, make([]byte, 4*1024*1024+1), []byte{1}); err == nil {
		t.Fatal("oversized tree was accepted")
	}
}
