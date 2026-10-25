// Package session composes the installation-wide Spotify slot with one
// per-call Spotify, encoder, and LiveKit playback lifecycle.
package session

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/id"
)

var ErrInvalid = errors.New("music session: invalid configuration")

type Lease interface{ Release() error }
type LeaseAcquire func(id.ID, id.ID) (Lease, error)
type PCMStarter interface {
	Start(context.Context, string) (io.ReadCloser, error)
}
type Encoder interface {
	Done() <-chan struct{}
	Wait() error
	Close() error
}
type EncoderStarter interface {
	Start(context.Context, io.ReadCloser) (Encoder, error)
}
type Publisher interface {
	Done() <-chan struct{}
	Wait() error
	Close() error
}
type PublisherStarter interface {
	Start(context.Context, client.Call, id.ID, livekit.EpochSource, Encoder) (Publisher, error)
}

type Options struct {
	Community, Channel id.ID
	Provider           music.Provider
	Track              string
	Call               client.Call
	Group              id.ID
	Acquire            LeaseAcquire
	PCM                PCMStarter
	Encoder            EncoderStarter
	Publisher          PublisherStarter
	Epochs             livekit.EpochSource
}

// OptionsForTrack supplies call credentials, provider PCM and epoch-bound
// publisher dependencies for a queue track. Spotify options include Acquire;
// YouTube options may omit the installation-wide lease.
type OptionsForTrack func(context.Context, music.Track) (Options, error)

type QueueStarter struct {
	OptionsFor OptionsForTrack
	// ResetConnection is reserved for an explicit playback action. Automatic EOF
	// advancement cannot clear a disconnected room's terminal state.
	ResetConnection func() error
	CloseConnection func() error
}

func (s QueueStarter) StartExplicit(ctx context.Context, track music.Track) (music.Playback, error) {
	if ctx == nil || s.OptionsFor == nil {
		return nil, ErrInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.ResetConnection != nil {
		if err := s.ResetConnection(); err != nil {
			return nil, err
		}
	}
	playback, err := s.Start(ctx, track)
	if !errors.Is(err, livekit.ErrBinding) || ctx.Err() != nil || s.ResetConnection == nil {
		return playback, err
	}
	// A fresh authorized call can replace a retained room before its delayed
	// disconnect callback arrives. acquireRoom marks that old binding dead.
	// Only an explicit action may tear it down and reacquire current options.
	if resetErr := s.ResetConnection(); resetErr != nil {
		return nil, resetErr
	}
	return s.Start(ctx, track)
}

// Close releases the retained connection when its queue owner is closed.
func (s QueueStarter) Close() error {
	if s.CloseConnection != nil {
		return s.CloseConnection()
	}
	return nil
}

func (s QueueStarter) Start(ctx context.Context, track music.Track) (music.Playback, error) {
	if ctx == nil || s.OptionsFor == nil {
		return nil, ErrInvalid
	}
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		playback, err := s.startOnce(ctx, track)
		// A previous publisher's departure can remove the replacement during
		// its handshake. No source was published successfully: close resources
		// and re-read membership, call credentials and epoch on a bounded retry.
		if err == nil || ctx.Err() != nil || attempt >= 2 ||
			(!errors.Is(err, context.Canceled) && !errors.Is(err, livekit.ErrEpochChanged) && !errors.Is(err, livekit.ErrRoomConnection)) {
			return playback, err
		}
		timer := time.NewTimer(time.Duration(attempt+1) * 500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s QueueStarter) startOnce(ctx context.Context, track music.Track) (music.Playback, error) {
	if s.OptionsFor == nil {
		return nil, ErrInvalid
	}
	o, err := s.OptionsFor(ctx, track)
	if err != nil {
		return nil, err
	}
	if (track.Provider != music.ProviderSpotify && track.Provider != music.ProviderYouTube) ||
		(o.Provider != "" && o.Provider != track.Provider) {
		return nil, ErrInvalid
	}
	o.Provider = track.Provider
	o.Track = track.CanonicalID
	return Start(ctx, o)
}

// Start acquires the global lease before starting any Spotify audio. The
// returned session owns every resource through publisher completion.
func Start(ctx context.Context, o Options) (*Session, error) {
	if ctx == nil || o.Community.IsZero() || o.Channel.IsZero() || o.Track == "" || o.PCM == nil || o.Encoder == nil || o.Publisher == nil || o.Epochs == nil || o.Call.CallID.IsZero() || o.Group.IsZero() || o.Call.GroupID != o.Group {
		return nil, ErrInvalid
	}
	provider := o.Provider
	if provider == "" {
		provider = music.ProviderSpotify
	}
	var lease Lease
	var err error
	if provider == music.ProviderSpotify {
		if o.Acquire == nil {
			return nil, ErrInvalid
		}
		lease, err = o.Acquire(o.Community, o.Channel)
		if err != nil {
			return nil, err
		}
	} else if provider != music.ProviderYouTube {
		return nil, ErrInvalid
	}
	if provider == music.ProviderSpotify && lease == nil {
		return nil, ErrInvalid
	}
	failed := true
	defer func() {
		if failed {
			if lease != nil {
				_ = lease.Release()
			}
		}
	}()
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	pcm, err := o.PCM.Start(ctx, o.Track)
	if err != nil {
		return nil, err
	}
	encoder, err := o.Encoder.Start(ctx, pcm)
	if err != nil {
		_ = pcm.Close()
		return nil, err
	}
	pub, err := o.Publisher.Start(ctx, o.Call, o.Group, o.Epochs, encoder)
	if err != nil {
		_ = encoder.Close()
		return nil, err
	}
	s := &Session{lease: lease, encoder: encoder, publisher: pub, done: make(chan struct{}), stop: make(chan struct{})}
	failed = false
	go s.monitor(ctx)
	return s, nil
}

type Session struct {
	lease     Lease
	encoder   Encoder
	publisher Publisher
	done      chan struct{}
	stop      chan struct{}
	once      sync.Once
	mu        sync.RWMutex
	err       error
}

func (s *Session) monitor(ctx context.Context) {
	select {
	case <-ctx.Done():
		s.finish(ctx.Err())
	case <-s.publisher.Done():
		s.finish(s.publisher.Wait())
	case <-s.encoder.Done():
		s.finish(s.encoder.Wait())
	case <-s.stop:
	}
	close(s.done)
}
func (s *Session) finish(err error) {
	s.once.Do(func() {
		s.mu.Lock()
		s.err = err
		s.mu.Unlock()
		_ = s.publisher.Close()
		_ = s.encoder.Close()
		if s.lease != nil {
			_ = s.lease.Release()
		}
		close(s.stop)
	})
}
func (s *Session) Done() <-chan struct{} { return s.done }
func (s *Session) Wait() error           { <-s.done; s.mu.RLock(); defer s.mu.RUnlock(); return s.err }
func (s *Session) Close() error {
	s.finish(context.Canceled)
	<-s.done
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

// AcquireSpotify adapts the concrete global lease manager for Options.
func AcquireSpotify(m *music.SpotifyLeaseManager) LeaseAcquire {
	return func(c, ch id.ID) (Lease, error) { return m.Acquire(c, ch) }
}
