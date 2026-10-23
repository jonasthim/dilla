//go:build linux

package spotify

import (
	"encoding/json"
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// NewAccessTokenFile puts the current OAuth access token in an unnamed sealed
// memory file for the helper's inherited FD 3. Refresh tokens stay with the
// runtime and never enter the playback process.
func NewAccessTokenFile(token string) (*os.File, error) {
	if len(token) < 1 || len(token) > 8192 {
		return nil, ErrInvalidConfig
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7e {
			return nil, ErrInvalidConfig
		}
	}
	fd, err := unix.MemfdCreate("dilla-spotify-token", unix.MFD_CLOEXEC|unix.MFD_ALLOW_SEALING)
	if err != nil {
		return nil, errors.New("spotify: credential descriptor unavailable")
	}
	f := os.NewFile(uintptr(fd), "dilla-spotify-token")
	body, err := json.Marshal(struct { // #nosec G117 -- this access token is deliberately serialized only into a sealed memfd for descriptor 3.
		AccessToken string `json:"access_token"`
	}{AccessToken: token})
	if err != nil {
		_ = f.Close()
		return nil, ErrInvalidConfig
	}
	defer clear(body)
	if n, writeErr := f.Write(body); writeErr != nil || n != len(body) {
		_ = f.Close()
		return nil, errors.New("spotify: credential descriptor unavailable")
	}
	if _, err = unix.FcntlInt(f.Fd(), unix.F_ADD_SEALS, unix.F_SEAL_WRITE|unix.F_SEAL_SHRINK|unix.F_SEAL_GROW|unix.F_SEAL_SEAL); err != nil {
		_ = f.Close()
		return nil, errors.New("spotify: credential descriptor unavailable")
	}
	if _, err = f.Seek(0, 0); err != nil {
		_ = f.Close()
		return nil, errors.New("spotify: credential descriptor unavailable")
	}
	return f, nil
}
