package ops_test

import (
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/ops"
)

// Plan 2 task 13's shared/exclusive rule, landed with its first caller (task
// 12's backup): an exclusive holder excludes every shared one, several shared
// holders coexist, and any shared holder excludes an exclusive acquire — the
// restore-during-backup refusal.
func TestBackupAndServeHoldTheDirectoryTogether(t *testing.T) {
	dir := t.TempDir()
	ex, err := ops.AcquireLock(dir)
	if err != nil {
		t.Fatalf("AcquireLock: %v", err)
	}
	if _, err := ops.AcquireSharedLock(dir); !errors.Is(err, ops.ErrLocked) {
		t.Fatalf("shared acquire under an exclusive holder = %v, want ErrLocked", err)
	}
	if err := ex.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	a, err := ops.AcquireSharedLock(dir)
	if err != nil {
		t.Fatalf("first shared acquire: %v", err)
	}
	b, err := ops.AcquireSharedLock(dir)
	if err != nil {
		t.Fatalf("second shared acquire: %v", err)
	}
	if _, err := ops.AcquireLock(dir); !errors.Is(err, ops.ErrLocked) {
		t.Fatalf("exclusive acquire under shared holders = %v, want ErrLocked", err)
	}
	if err := a.Release(); err != nil {
		t.Fatalf("Release a: %v", err)
	}
	if err := b.Release(); err != nil {
		t.Fatalf("Release b: %v", err)
	}
	ex, err = ops.AcquireLock(dir)
	if err != nil {
		t.Fatalf("AcquireLock after every shared holder released: %v", err)
	}
	if err := ex.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
	// Release is idempotent.
	if err := ex.Release(); err != nil {
		t.Fatalf("second Release: %v", err)
	}
}
