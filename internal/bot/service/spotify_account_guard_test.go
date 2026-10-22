package service

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSpotifyAccountGuardBindsOneAccountAcrossInstallations(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	first, err := NewSpotifyAccountGuard(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Bind("acct_one"); err != nil {
		t.Fatal("first bind", err)
	}
	second, err := NewSpotifyAccountGuard(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Bind("acct_one"); err != nil {
		t.Fatal("same account", err)
	}
	if err := second.Bind("acct_two"); err == nil {
		t.Fatal("different account accepted")
	}
}

func TestSpotifyAccountGuardRejectsUnsafeFile(t *testing.T) {
	for _, mode := range []string{"symlink", "permissions"} {
		t.Run(mode, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "state")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(root, spotifyAccountGuardFile)
			if mode == "symlink" {
				other := filepath.Join(t.TempDir(), "account")
				if err := os.WriteFile(other, []byte("acct_one\n"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(other, path); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(path, []byte("acct_one\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			guard, err := NewSpotifyAccountGuard(root)
			if err != nil {
				t.Fatal(err)
			}
			if err := guard.Bind("acct_one"); err == nil {
				t.Fatal("unsafe account guard file accepted")
			}
		})
	}
}

func TestSpotifyAccountGuardPersistenceFailureDoesNotBind(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, spotifyAccountGuardFile), 0o700); err != nil {
		t.Fatal(err)
	}
	guard, err := NewSpotifyAccountGuard(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Bind("acct_one"); err == nil {
		t.Fatal("directory accepted as guard file")
	}
	if err := os.Remove(filepath.Join(root, spotifyAccountGuardFile)); err != nil {
		t.Fatal(err)
	}
	if err := guard.Bind("acct_two"); err != nil {
		t.Fatalf("failed persistence left a binding: %v", err)
	}
}
