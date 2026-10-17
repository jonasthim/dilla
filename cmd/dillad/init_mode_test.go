package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/jonasthim/dilla/internal/exit"
)

func initArgs(cfg, data string, extra ...string) []string {
	return append([]string{"init", "--config=" + cfg, "--data-dir=" + data, "--agree-tos",
		"--domain=chat.example", "--public-ip=203.0.113.7"}, extra...)
}

func wantCantCreate(t *testing.T, err error, substr string) {
	t.Helper()
	var code exit.Code
	if !errors.As(err, &code) || code != exit.CantCreate {
		t.Fatalf("err = %v, want exit.CantCreate (73)", err)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("err = %q, want it to contain %q", err, substr)
	}
}

// R16 (9a): init writes the config where --config says, and nowhere in the data directory.
func TestInitWritesTheConfigPath(t *testing.T) {
	tmp := t.TempDir()
	cfg := filepath.Join(tmp, "etc", "dilla.toml")
	data := filepath.Join(tmp, "data")
	out, _, err := run(t, initArgs(cfg, data)...)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if _, err := os.Stat(cfg); err != nil {
		t.Fatalf("no config at --config: %v", err)
	}
	if _, err := os.Stat(filepath.Join(data, "dilla.toml")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("init left a dilla.toml in the data directory (stat err %v)", err)
	}
	if !strings.Contains(out, "dillad init: wrote "+cfg) {
		t.Fatalf("stdout does not name the config path: %q", out)
	}
}

func TestInitRefusesAnExistingConfig(t *testing.T) {
	tmp := t.TempDir()
	cfg := filepath.Join(tmp, "dilla.toml")
	if err := os.WriteFile(cfg, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(tmp, "data")
	_, _, err := run(t, initArgs(cfg, data)...)
	wantCantCreate(t, err, cfg+" already exists; pass --overwrite-config to replace it")
	if got, _ := os.ReadFile(cfg); string(got) != "precious" {
		t.Fatalf("the refused config was changed: %q", got)
	}

	// Control: the same call with the flag replaces it.
	if _, _, err := run(t, initArgs(cfg, data, "--overwrite-config")...); err != nil {
		t.Fatalf("init --overwrite-config: %v", err)
	}
	got, _ := os.ReadFile(cfg)
	if string(got) == "precious" || !strings.Contains(string(got), "chat.example") {
		t.Fatalf("the config was not replaced: %q", got)
	}
	if _, err := os.Stat(cfg + ".new"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("PATH.new was left behind (stat err %v)", err)
	}

	// An initialised data directory is refused with the flag too.
	_, _, err = run(t, initArgs(cfg, data, "--overwrite-config")...)
	wantCantCreate(t, err, data+" already holds an instance (dilla.db); refusing to initialise it again")
}

func TestInitRefusesALegacyDataDirectory(t *testing.T) {
	tmp := t.TempDir()
	data := filepath.Join(tmp, "data")
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(data, "dilla.toml"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := run(t, initArgs(filepath.Join(tmp, "etc.toml"), data, "--overwrite-config")...)
	wantCantCreate(t, err, "already holds an instance (dilla.toml)")
}

// R17 (9b): whatever the caller's umask, every file init leaves is 0600 and every directory 0700.
// Not parallel: the umask is per process.
func TestInitFilesAreOwnerOnlyUnderUmask022(t *testing.T) {
	old := syscall.Umask(0o022)
	t.Cleanup(func() { syscall.Umask(old) })

	tmp := t.TempDir()
	cfg := filepath.Join(tmp, "etc", "dilla.toml")
	data := filepath.Join(tmp, "data")
	// A data directory that already exists at the umask's mode is tightened too.
	if err := os.Mkdir(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(data, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := run(t, initArgs(cfg, data)...); err != nil {
		t.Fatalf("init: %v", err)
	}
	seen := map[string]bool{}
	err := filepath.WalkDir(data, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		seen[filepath.Base(p)] = true
		want := os.FileMode(0o600)
		if d.IsDir() {
			want = 0o700
		}
		if perm := info.Mode().Perm(); perm != want {
			t.Errorf("%s has mode %04o, want %04o", p, perm, want)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"dilla.db", "turn.secret", "livekit.secret"} {
		if !seen[name] {
			t.Errorf("init left no %s in the data directory", name)
		}
	}
	for _, c := range []struct {
		path string
		want os.FileMode
	}{{cfg, 0o600}, {filepath.Dir(cfg), 0o755}} {
		info, err := os.Stat(c.path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != c.want {
			t.Errorf("%s has mode %04o, want %04o", c.path, perm, c.want)
		}
	}
}
