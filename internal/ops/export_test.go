package ops

import "testing"

// SetAfterSwapHook runs fn right after Restore has moved the restored directory
// into place, with the lock Restore then holds, for the rest of the test.
func SetAfterSwapHook(t *testing.T, fn func(dataDir string)) {
	t.Helper()
	prev := afterSwap
	afterSwap = fn
	t.Cleanup(func() { afterSwap = prev })
}

// SetBeforeHealCommit runs fn as the restore's heal transaction's last
// statement, for the rest of the test; an error rolls the transaction back.
func SetBeforeHealCommit(t *testing.T, fn func() error) {
	t.Helper()
	prev := beforeHealCommit
	beforeHealCommit = fn
	t.Cleanup(func() { beforeHealCommit = prev })
}

// SetSwapRename replaces the rename the swap and its undo make, for the rest of
// the test.
func SetSwapRename(t *testing.T, fn func(from, to string) error) {
	t.Helper()
	prev := swapRename
	swapRename = fn
	t.Cleanup(func() { swapRename = prev })
}
