package ops

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ErrLocked is returned when another dillad holds the data directory in a mode
// that excludes the one asked for.
var ErrLocked = errors.New("ops: the data directory is in use by another dillad")

// LockFile is the advisory lock's file inside the data directory.
const LockFile = "dilla.lock"

// Lock is an advisory flock on <dir>/dilla.lock. syscall.Flock is stdlib, so no
// dependency is added; the lock belongs to the open file description and is
// released by Release or by the process exiting.
//
// Plan 2 task 13 owns the exclusive half (`restore`, and `serve` beside it);
// task 12's `backup` is the first caller and takes the shared half, so the
// file lands with it.
type Lock struct{ f *os.File }

// AcquireLock takes LOCK_EX|LOCK_NB: it fails with ErrLocked while any other
// holder, shared or exclusive, has the directory.
func AcquireLock(dir string) (*Lock, error) { return acquire(dir, syscall.LOCK_EX) }

// AcquireSharedLock takes LOCK_SH|LOCK_NB. Several shared holders coexist; an
// exclusive holder excludes them all and is excluded by any of them.
func AcquireSharedLock(dir string) (*Lock, error) { return acquire(dir, syscall.LOCK_SH) }

func acquire(dir string, how int) (*Lock, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, LockFile), os.O_RDWR|os.O_CREATE, 0o600) //nolint:gosec // G304: the operator's configured data directory
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), how|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("%w: %s", ErrLocked, dir)
		}
		return nil, fmt.Errorf("ops: lock %s: %w", dir, err)
	}
	return &Lock{f: f}, nil
}

// Release drops the lock. Releasing twice, or a nil lock, is not an error.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
	if cerr := l.f.Close(); err == nil {
		err = cerr
	}
	l.f = nil
	return err
}
