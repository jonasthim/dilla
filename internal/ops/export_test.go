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
