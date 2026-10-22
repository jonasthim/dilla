// Package session composes the installation-wide Spotify slot with one
// per-call Spotify, encoder, and LiveKit playback lifecycle.
package session

import (
	"context"
	"errors"
	"io"
	"sync"

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
	Track              string
	Call               client.Call
	Group              id.ID
	Acquire            LeaseAcquire
	PCM                PCMStarter
	Encoder            EncoderStarter
	Publisher          PublisherStarter
	Epochs             livekit.EpochSource
}

// Start acquires the global lease before starting any Spotify audio. The
// returned session owns every resource through publisher completion.
func Start(ctx context.Context, o Options) (*Session, error) {
	if ctx == nil || o.Community.IsZero() || o.Channel.IsZero() || o.Track == "" || o.Acquire == nil || o.PCM == nil || o.Encoder == nil || o.Publisher == nil || o.Epochs == nil || o.Call.CallID.IsZero() || o.Group.IsZero() || o.Call.GroupID != o.Group {
		return nil, ErrInvalid
	}
	lease, err := o.Acquire(o.Community, o.Channel)
	if err != nil {
		return nil, err
	}
	if lease == nil {
		return nil, ErrInvalid
	}
	failed := true
	defer func() {
		if failed {
			_ = lease.Release()
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
		_ = s.lease.Release()
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
