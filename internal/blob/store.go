// Package blob is dillad's content-addressed store for attachment ciphertext.
// The name of an object is the SHA-256 of its bytes, so the store never has to
// trust a client's claim about what it uploaded: it hashes what it receives.
package blob

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
)

var (
	ErrHashMismatch = errors.New("blob: body does not hash to the requested id")
	ErrTooLarge     = errors.New("blob: over the instance limit")
	ErrNotFound     = errors.New("blob: no such object")
)

// Store writes under one *os.Root, so a path can never leave the blob
// directory: "Methods on Root can only access files and directories beneath a
// root directory" (go doc os.Root, Go 1.27).
type Store struct {
	root    *os.Root
	backend string
}

// New wraps an already open root. backend is the tag StorageRef writes; "fs"
// is the only one this version has.
func New(root *os.Root, backend string) *Store { return &Store{root: root, backend: backend} }

// Open creates dir if it is missing (0700: the directory holds nothing but
// ciphertext, and nothing but dillad reads it) and opens it as the root.
func Open(dir, backend string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return New(root, backend), nil
}

// Close releases the root's directory handle.
func (s *Store) Close() error { return s.root.Close() }

// StorageRef is the value of blobs.storage_ref: a backend tag plus a derived
// locator, never a stored path. gap-47 §9: a stored path can drift from the
// hash, is attacker-influenced, and would have to be rewritten row by row when
// the S3 backend lands.
func StorageRef(backend string, blobID []byte) string {
	return backend + ":" + rel(blobID)
}

// rel is the path inside the root: the two-level 256x256 fan-out of
// facts-storage §5.2, "att/<hex[0:2]>/<hex[2:4]>/<hex>".
func rel(blobID []byte) string {
	h := hex.EncodeToString(blobID)
	return path.Join("att", h[0:2], h[2:4], h)
}

// Put streams r through SHA-256 while writing it, and keeps the bytes only when
// the digest equals want. The sequence is temp file (0600) -> Sync -> Rename ->
// directory Sync, so a crash leaves either nothing or a complete object. At
// most limit bytes are read; one more is ErrTooLarge, and nothing is buffered in
// memory either way.
//
// The body is hashed even when an object of that name is already stored: the
// upload IS the proof of ownership (gap-47 §6.2). Answering "already present"
// before reading the body would hand the object to anyone who has only seen its
// id. created is false when the object already existed, and the fresh copy is
// then discarded.
func (s *Store) Put(ctx context.Context, want []byte, r io.Reader, limit int64) (n int64, created bool, err error) {
	if len(want) != sha256.Size {
		return 0, false, fmt.Errorf("blob: id is %d bytes, want %d", len(want), sha256.Size)
	}
	final := rel(want)
	dir := path.Dir(final)
	if err := s.root.MkdirAll(dir, 0o700); err != nil {
		return 0, false, err
	}
	// os.Root has no CreateTemp, so the name is built by hand and O_EXCL makes
	// the create the lock.
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return 0, false, err
	}
	tmp := final + ".tmp-" + hex.EncodeToString(suffix[:])
	f, err := s.root.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return 0, false, err
	}
	cleanup := func() {
		_ = f.Close()
		_ = s.root.Remove(tmp)
	}
	h := sha256.New()
	n, err = io.Copy(f, io.TeeReader(io.LimitReader(r, limit+1), h))
	if err != nil {
		cleanup()
		return 0, false, err
	}
	if n > limit {
		cleanup()
		return 0, false, ErrTooLarge
	}
	if !hmac.Equal(h.Sum(nil), want) {
		cleanup()
		return 0, false, ErrHashMismatch
	}
	if err := ctx.Err(); err != nil {
		cleanup()
		return 0, false, err
	}
	if _, err := s.root.Stat(final); err == nil {
		// Already stored: the bytes are the same bytes, because the name is
		// their hash. Keep the old file and drop the new copy.
		cleanup()
		return n, false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		cleanup()
		return 0, false, err
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return 0, false, err
	}
	if err := f.Close(); err != nil {
		_ = s.root.Remove(tmp)
		return 0, false, err
	}
	// Two uploads of the same bytes may race to here; the second rename
	// replaces a file with an identical one, which is harmless.
	if err := s.root.Rename(tmp, final); err != nil {
		_ = s.root.Remove(tmp)
		return 0, false, err
	}
	// Sync the directory so the rename itself is durable, not only the bytes.
	if d, err := s.root.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return n, true, nil
}

// Get returns the object as a *os.File, which is documented to satisfy
// io.ReadSeeker, so http.ServeContent can answer Range requests. Do not reach
// for ServeFileFS over root.FS(): Root.FS() promises only StatFS/ReadFileFS/
// ReadDirFS/ReadLinkFS, and ServeFileFS requires io.Seeker.
func (s *Store) Get(blobID []byte) (*os.File, int64, error) {
	if len(blobID) != sha256.Size {
		return nil, 0, ErrNotFound
	}
	f, err := s.root.Open(rel(blobID))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, 0, err
	}
	return f, fi.Size(), nil
}

// Stat returns the stored size of the object, or ErrNotFound.
func (s *Store) Stat(blobID []byte) (int64, error) {
	if len(blobID) != sha256.Size {
		return 0, ErrNotFound
	}
	fi, err := s.root.Stat(rel(blobID))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

// Delete unlinks the object. Deleting an object that is not there is not an
// error: the sweeper and the admin purge may both reach the same id.
func (s *Store) Delete(blobID []byte) error {
	if len(blobID) != sha256.Size {
		return nil
	}
	err := s.root.Remove(rel(blobID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// SweepTemp removes the .tmp-* files a crash between create and rename leaves.
// dillad serve calls it once at start, before the listener accepts an upload.
func (s *Store) SweepTemp() (int, error) {
	var n int
	err := fs.WalkDir(s.root.FS(), "att", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || !strings.Contains(d.Name(), ".tmp-") {
			return nil
		}
		if err := s.root.Remove(p); err != nil {
			return err
		}
		n++
		return nil
	})
	return n, err
}

// writeRelative is unexported and is reached from tests through
// internal/blob/export_test.go. It exists only so a test can assert that os.Root
// refuses a traversal; an exported production method that exists only for a test
// is what the §9.3 linter's unused-export rule is for.
func (s *Store) writeRelative(p string, b []byte) error {
	f, err := s.root.OpenFile(p, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	return errors.Join(err, f.Close())
}
