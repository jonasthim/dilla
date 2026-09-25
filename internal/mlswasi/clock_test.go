package mlswasi

import (
	"context"
	"testing"
	"time"
)

// gap-33 §4.3: wazero calls the walltime closure on every clock_time_get, so a clock advanced
// after instantiation is seen by the guest without rebuilding the pool. That is what makes
// invariant 6's "KeyPackage lifetime not expired" clause testable at all.
func TestAnAdvancedWalltimeExpiresAKeyPackageWithoutRebuildingThePool(t *testing.T) {
	ctx := context.Background()
	now := time.Now()
	r, err := New(ctx, loadWasm(t), Options{
		PoolSize: 1,
		CacheDir: sharedCacheDir(t),
		Now:      func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })

	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	kp := loadKeyPackageFixture(t)
	info, err := inst.ValidateKeyPackage(ctx, kp)
	if err != nil {
		t.Fatalf("ValidateKeyPackage at the fixture's own time: %v", err)
	}
	if len(info.KPRef) != 32 {
		t.Fatalf("KPRef = %d bytes, want 32", len(info.KPRef))
	}

	// One second past not_after, on the same instance.
	now = time.Unix(int64(info.NotAfter)+1, 0)
	if _, err := inst.ValidateKeyPackage(ctx, kp); err == nil {
		t.Fatal("ValidateKeyPackage must refuse a KeyPackage whose lifetime has passed")
	}
}

func TestNowDefaultsToTheSystemWalltime(t *testing.T) {
	ctx := context.Background()
	r, err := New(ctx, loadWasm(t), Options{PoolSize: 1, CacheDir: sharedCacheDir(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })

	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	if _, err := inst.ValidateKeyPackage(ctx, loadKeyPackageFixture(t)); err != nil {
		t.Fatalf("with Options.Now unset the guest must see the real clock: %v", err)
	}
}
