package music

import (
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/ops"
)

var ErrSpotifyBusy = errors.New("spotify playback is active in another voice channel")

// SpotifyLeaseManager holds one installation-wide advisory file lock. All
// communities served by an installation must use the same state directory.
// The lock also excludes a second dillabot process using that directory.
type SpotifyLeaseManager struct {
	mu     sync.Mutex
	dir    string
	active *SpotifyLease
}

type SpotifyLease struct {
	manager            *SpotifyLeaseManager
	lock               *ops.Lock
	Community, Channel id.ID
}

func NewSpotifyLeaseManager(stateDir string) (*SpotifyLeaseManager, error) {
	if !filepath.IsAbs(stateDir) {
		return nil, errors.New("invalid Spotify state directory")
	}
	info, err := os.Stat(stateDir)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("spotify state directory must be private")
	}
	return &SpotifyLeaseManager{dir: filepath.Join(stateDir, "spotify-slot")}, nil
}

func (m *SpotifyLeaseManager) Acquire(community, channel id.ID) (*SpotifyLease, error) {
	if m == nil || community.IsZero() || channel.IsZero() {
		return nil, errors.New("invalid Spotify lease owner")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active != nil {
		return nil, ErrSpotifyBusy
	}
	lock, err := ops.AcquireLock(m.dir)
	if errors.Is(err, ops.ErrLocked) {
		return nil, ErrSpotifyBusy
	}
	if err != nil {
		return nil, err
	}
	lease := &SpotifyLease{manager: m, lock: lock, Community: community, Channel: channel}
	m.active = lease
	return lease, nil
}

// Release is idempotent. A stale lease cannot release a newer session's slot.
func (l *SpotifyLease) Release() error {
	if l == nil || l.manager == nil {
		return nil
	}
	m := l.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active != l {
		return nil
	}
	m.active = nil
	return l.lock.Release()
}
