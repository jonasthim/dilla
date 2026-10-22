package service

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const spotifyAccountGuardFile = "spotify-account"

var spotifyAccountGuardMu sync.Mutex

var ErrSpotifyAccountMismatch = errors.New("Spotify account does not match the service account")

// SpotifyAccountGuard binds every installation under one state directory to
// the same Spotify account. The account ID is stored in a private file.
type SpotifyAccountGuard struct{ path string }

func NewSpotifyAccountGuard(stateDir string) (*SpotifyAccountGuard, error) {
	if !filepath.IsAbs(stateDir) {
		return nil, ErrSpotifyCredentials
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, ErrSpotifyCredentials
	}
	info, err := os.Lstat(stateDir)
	st, ok := func() (*syscall.Stat_t, bool) {
		if err != nil {
			return nil, false
		}
		v, ok := info.Sys().(*syscall.Stat_t)
		return v, ok
	}()
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !ok || int64(st.Uid) != int64(os.Geteuid()) {
		return nil, ErrSpotifyCredentials
	}
	if info.Mode().Perm() != 0o700 {
		if err := os.Chmod(stateDir, 0o700); err != nil {
			return nil, ErrSpotifyCredentials
		}
	}
	return &SpotifyAccountGuard{path: filepath.Join(stateDir, spotifyAccountGuardFile)}, nil
}

// Bind atomically establishes the first account ID and accepts only that ID
// thereafter. It is safe when multiple processes start at the same time.
func (g *SpotifyAccountGuard) Bind(accountID string) error {
	if g == nil || !validSpotifyAccountID(accountID) {
		return ErrSpotifyCredentials
	}
	spotifyAccountGuardMu.Lock()
	defer spotifyAccountGuardMu.Unlock()
	if existing, err := g.read(); err == nil {
		if existing == accountID {
			return nil
		}
		return ErrSpotifyAccountMismatch
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrSpotifyCredentials
	}
	dir := filepath.Dir(g.path)
	temp, err := os.CreateTemp(dir, ".spotify-account-*")
	if err != nil {
		return ErrSpotifyCredentials
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err = temp.Chmod(0o600); err == nil {
		_, err = temp.WriteString(accountID + "\n")
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return ErrSpotifyCredentials
	}
	if err = os.Link(tempPath, g.path); err != nil {
		if errors.Is(err, os.ErrExist) {
			existing, readErr := g.read()
			if readErr == nil && existing == accountID {
				return nil
			}
			if readErr == nil {
				return ErrSpotifyAccountMismatch
			}
		}
		return ErrSpotifyCredentials
	}
	if d, err := os.Open(dir); err == nil {
		err = d.Sync()
		_ = d.Close()
		if err != nil {
			return ErrSpotifyCredentials
		}
	} else {
		return ErrSpotifyCredentials
	}
	return nil
}

// lockInstallation serializes credential reads and token rotation across all
// processes using the shared state directory.
func (g *SpotifyAccountGuard) lockInstallation(ctx context.Context, installationID string) (func(), error) {
	if g == nil || ctx == nil || len(installationID) != 32 {
		return nil, ErrSpotifyCredentials
	}
	for _, c := range installationID {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return nil, ErrSpotifyCredentials
		}
	}
	path := filepath.Join(filepath.Dir(g.path), "spotify-credential-"+installationID+".lock")
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, ErrSpotifyCredentials
	}
	f := os.NewFile(uintptr(fd), "spotify-credential-lock")
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, ErrSpotifyCredentials
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm() != 0o600 {
		_ = f.Close()
		return nil, ErrSpotifyCredentials
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() { _ = syscall.Flock(fd, syscall.LOCK_UN); _ = f.Close() }, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			_ = f.Close()
			return nil, ErrSpotifyCredentials
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ErrSpotifyCredentials
		case <-ticker.C:
		}
	}
}

func (g *SpotifyAccountGuard) read() (string, error) {
	fd, err := syscall.Open(g.path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), "spotify-account")
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", ErrSpotifyCredentials
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || !ok || int64(st.Uid) != int64(os.Geteuid()) || info.Mode().Perm() != 0o600 {
		return "", ErrSpotifyCredentials
	}
	buf, err := io.ReadAll(io.LimitReader(f, 130))
	if err != nil {
		return "", ErrSpotifyCredentials
	}
	if len(buf) >= 130 {
		return "", ErrSpotifyCredentials
	}
	value := string(buf)
	if len(value) < 2 || value[len(value)-1] != '\n' {
		return "", ErrSpotifyCredentials
	}
	value = value[:len(value)-1]
	if !validSpotifyAccountID(value) {
		return "", ErrSpotifyCredentials
	}
	return value, nil
}

func validSpotifyAccountID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}
