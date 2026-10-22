package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// mediaStateFile is the running SFU's self-description, in the state directory. A web3.12+
// `dillad media` writes it once the SFU accepts RoomService requests, just before READY=1, and
// removes it on a clean stop. The installer, the refresh timer and `dillad doctor` read it to learn
// which build the running SFU is (R-UP3).
const mediaStateFile = "media.json"

// mediaUnit is the systemd unit whose MainPID vouches for a media.json.
const mediaUnit = "dilla-media"

// mediaState is media.json's content: {version, media_level, capabilities, pid, started}.
type mediaState struct {
	Version      string    `json:"version"`
	MediaLevel   int       `json:"media_level"`
	Capabilities []string  `json:"capabilities"`
	PID          int       `json:"pid"`
	Started      time.Time `json:"started"`
}

func mediaStatePath(dataDir string) string { return filepath.Join(dataDir, mediaStateFile) }

// writeMediaState writes media.json at mode 0600, atomically: a reader sees the old file or the
// new one, never half of it.
func writeMediaState(dataDir string, st mediaState) error {
	if st.Capabilities == nil {
		st.Capabilities = []string{}
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".media.json.*")
	if err != nil {
		return fmt.Errorf("media: %w", err)
	}
	name := tmp.Name()
	cleanup := func() { _ = os.Remove(name) }
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("media: %w", err)
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("media: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("media: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("media: %w", err)
	}
	if err := os.Rename(name, mediaStatePath(dataDir)); err != nil {
		cleanup()
		return fmt.Errorf("media: %w", err)
	}
	// The rename is durable only once the directory entry is: a power loss right after READY must
	// not bring back the previous file (or none).
	dir, err := os.Open(dataDir) //nolint:gosec // G304: the state directory derived from dilla.toml
	if err != nil {
		return fmt.Errorf("media: %w", err)
	}
	if err := dir.Sync(); err != nil {
		_ = dir.Close()
		return fmt.Errorf("media: sync %s: %w", dataDir, err)
	}
	return dir.Close()
}

// errNoMediaState means there is no usable media.json: absent, unreadable, malformed, or written by
// a process that is not the unit's current one.
var errNoMediaState = errors.New("no valid media.json")

// maxMediaStateBytes bounds a media.json read; the real one is about 150 bytes.
const maxMediaStateBytes = 4096

// readMediaState reads media.json and applies the staleness rule: a file whose pid is not the
// unit's MainPID was left by an earlier process (a crash or a reboot) and counts as absent.
func readMediaState(ctx context.Context, dataDir string) (mediaState, error) {
	raw, err := readMediaStateFile(mediaStatePath(dataDir))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return mediaState{}, errNoMediaState
		}
		return mediaState{}, fmt.Errorf("%w: %w", errNoMediaState, err)
	}
	var st mediaState
	if err := json.Unmarshal(raw, &st); err != nil || st.PID <= 0 || st.Version == "" {
		return mediaState{}, fmt.Errorf("%w: malformed", errNoMediaState)
	}
	if !mediaPIDIsCurrent(ctx, st.PID) {
		return mediaState{}, fmt.Errorf("%w: pid %d is not the %s unit's MainPID", errNoMediaState, st.PID, mediaUnit)
	}
	return st, nil
}

// readMediaStateFile reads at most maxMediaStateBytes of path, which must be a regular file. The
// directory is dillad's, and the doctor (run by the installer) and serve read it, so a FIFO, a
// device or a link there must never block them or be followed: the open is O_NONBLOCK|O_NOFOLLOW
// and the type is checked on the open file.
func readMediaStateFile(path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0) //nolint:gosec // G304: the state directory derived from dilla.toml
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	if fi, err = f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxMediaStateBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxMediaStateBytes {
		return nil, errors.New("larger than 4096 bytes")
	}
	return raw, nil
}

// mediaMainPID asks systemd for the unit's MainPID (0 when it is not running). A variable so a test
// can stand in for systemctl.
var mediaMainPID = func(ctx context.Context) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "systemctl", "show", "-P", "MainPID", mediaUnit).Output()
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(out)))
}

// mediaPIDIsCurrent is true when pid is the unit's MainPID. Where systemd cannot answer (a
// container, a host without systemctl) the file is vouched for by its process being alive.
func mediaPIDIsCurrent(ctx context.Context, pid int) bool {
	main, err := mediaMainPID(ctx)
	if err != nil {
		// The fallback is weaker than the MainPID check: after a reboot or a crash the kernel may
		// have handed the file's pid to an unrelated process, which makes a stale file look
		// current. It is used only where there is no systemd to ask, which runs no refresh timer
		// and no installer upgrade either; there it can only mislabel the doctor's media_binary leg
		// or serve's TURN plan, and the latter then binds nothing until dilla-media is restarted.
		_, statErr := os.Stat("/proc/" + strconv.Itoa(pid))
		return statErr == nil
	}
	return main == pid
}
