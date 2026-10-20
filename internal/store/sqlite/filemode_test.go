package sqlite

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// R17 (9b): OpenWrite pre-creates the database at 0600, and SQLite's unix VFS gives -wal and -shm
// the database file's own mode, so nothing under the data directory depends on the caller's umask.
// Not parallel: the umask is per process.
func TestOpenWriteFilesAreOwnerOnly(t *testing.T) {
	old := syscall.Umask(0o022)
	t.Cleanup(func() { syscall.Umask(old) })

	path := filepath.Join(t.TempDir(), "dilla.db")
	db, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(t.Context(), `CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := db.ExecContext(t.Context(), `INSERT INTO t (x) VALUES (1)`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s has mode %04o, want 0600", p, perm)
		}
	}
}

// A chmod that is refused (a root-owned dilla.db that dillad reaches through the group: EPERM) must not stop
// OpenWrite: serve warns about it through SecureFiles and starts, as it already does for the -wal and -shm.
// Not parallel: it swaps the package's chmod.
func TestOpenWriteSurvivesARefusedChmod(t *testing.T) {
	old := chmodFile
	chmodFile = func(string, os.FileMode) error { return &os.PathError{Op: "chmod", Path: "dilla.db", Err: syscall.EPERM} }
	t.Cleanup(func() { chmodFile = old })

	path := filepath.Join(t.TempDir(), "dilla.db")
	db, err := OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite with a refused chmod: %v", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(t.Context(), `CREATE TABLE t (x INTEGER)`); err != nil {
		t.Fatalf("the database must still work: %v", err)
	}
}

func TestSecureFilesChmodsTheThreeAndIgnoresAMissingOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dilla.db")
	for _, p := range []string{path, path + "-wal"} { // no -shm
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := SecureFiles(path); err != nil {
		t.Fatalf("SecureFiles: %v", err)
	}
	for _, p := range []string{path, path + "-wal"} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s has mode %04o, want 0600", p, perm)
		}
	}
}
