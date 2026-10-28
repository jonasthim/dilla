package music

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

var ErrSupervisorClosed = errors.New("music supervisor is closed")

// Playback is the owned lifetime of one provider/encoder/LiveKit track.
type Playback interface {
	Done() <-chan struct{}
	Wait() error
	Close() error
}

// TrackStarter composes provider PCM, the bounded Opus encoder, call credentials,
// MLS epoch source and encrypted LiveKit publisher for one track.
type TrackStarter interface {
	Start(context.Context, Track) (Playback, error)
}

type QueueStore interface {
	Load(context.Context, id.ID) (State, uint64, error)
	Save(context.Context, id.ID, uint64, State) (uint64, error)
}

// Supervisor owns the persisted queue and at most one active track for a voice
// channel. Loading restores metadata only; audio begins only on OpResume.
type Supervisor struct {
	mu           sync.Mutex
	ctx          context.Context
	channel      id.ID
	store        QueueStore
	starter      TrackStarter
	state        State
	revision     uint64
	playback     Playback
	closed       bool
	changed      chan struct{}
	emptyTimer   Timer
	grace        time.Duration
	afterFunc    func(time.Duration, func()) Timer
	onEmpty      func()
	stopLifetime func() bool
}

type Timer interface{ Stop() bool }

type SupervisorOption func(*Supervisor)

// WithEmptyRoomGrace schedules onEmpty after grace. onEmpty is only a callback;
// the caller must perform the actual call leave operation.
func WithEmptyRoomGrace(grace time.Duration, afterFunc func(time.Duration, func()) Timer, onEmpty func()) SupervisorOption {
	return func(s *Supervisor) {
		if grace > 0 {
			s.grace = grace
		}
		if afterFunc != nil {
			s.afterFunc = afterFunc
		}
		s.onEmpty = onEmpty
	}
}

func NewSupervisor(ctx context.Context, channel id.ID, store QueueStore, starter TrackStarter, options ...SupervisorOption) (*Supervisor, error) {
	if ctx == nil || channel.IsZero() || store == nil || starter == nil {
		return nil, errors.New("invalid music supervisor configuration")
	}
	state, revision, err := store.Load(ctx, channel)
	if err != nil {
		return nil, err
	}
	s := &Supervisor{ctx: ctx, channel: channel, store: store, starter: starter, state: state, revision: revision, changed: make(chan struct{}), grace: 5 * time.Minute, afterFunc: func(d time.Duration, fn func()) Timer { return time.AfterFunc(d, fn) }}
	for _, option := range options {
		if option != nil {
			option(s)
		}
	}
	// Retained call resources belong to this supervisor even while playback is paused.
	s.mu.Lock()
	s.stopLifetime = context.AfterFunc(ctx, func() { _ = s.Close() })
	s.mu.Unlock()
	return s, nil
}

func (s *Supervisor) State() State { s.mu.Lock(); defer s.mu.Unlock(); return cloneState(s.state) }

// Apply persists a revision-checked operation before starting or stopping
// resources. Resume is the only operation that can start restored state.
func (s *Supervisor) Apply(ctx context.Context, expected uint64, op Operation) (State, error) {
	if ctx == nil {
		return State{}, errors.New("nil music operation context")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return State{}, ErrSupervisorClosed
	}
	if expected != s.state.Revision {
		return cloneState(s.state), ErrRevisionConflict
	}
	if op.NowMS == 0 {
		op.NowMS = time.Now().UnixMilli()
	}
	next, err := Apply(s.state, expected, op)
	if err != nil {
		return cloneState(s.state), err
	}
	revision, err := s.store.Save(ctx, s.channel, s.revision, next)
	if err != nil {
		return cloneState(s.state), err
	}
	s.state, s.revision = next, revision
	if op.Kind == OpPause || op.Kind == OpStop || op.Kind == OpClear || op.Kind == OpSkip {
		s.closePlaybackLocked()
	}
	if !s.state.Paused && s.state.Current != nil && s.playback == nil {
		if err := s.startLocked(ctx, op.Kind == OpResume || op.Kind == OpSkip); err != nil {
			_ = s.pauseLocked(ctx)
			s.signalLocked()
			return cloneState(s.state), err
		}
	}
	s.signalLocked()
	return cloneState(s.state), nil
}

// ApplyPersistedSnapshot adopts a revision committed by another authorized
// component. It never writes that mutation again. startPlayback must be true
// only for a live, explicit Resume or a Skip from an already-playing queue;
// restored or metadata-only snapshots cannot start audio. A failed start is
// durably paused at a new CAS revision so the persisted queue cannot claim
// playback is active. Because the external mutation is already committed, the
// request context does not own runtime adoption; bounded reads and playback
// use the supervisor's lifetime context instead.
func (s *Supervisor) ApplyPersistedSnapshot(ctx context.Context, committed State, expected uint64, startPlayback bool) (uint64, error) {
	if ctx == nil {
		return 0, errors.New("nil persisted music snapshot context")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return s.revision, ErrSupervisorClosed
	}
	if expected <= s.revision || committed.Revision != expected {
		return s.revision, ErrRevisionConflict
	}
	// Persisted interactions can be dispatched under a short-lived event
	// context. Once their mutation has committed, runtime adoption belongs to
	// this supervisor's lifetime, not the request that carried it.
	loadCtx, cancelLoad := context.WithTimeout(s.ctx, 5*time.Second)
	_, revision, err := s.store.Load(loadCtx, s.channel)
	cancelLoad()
	if err != nil {
		return s.revision, err
	}
	if revision != expected {
		return s.revision, ErrRevisionConflict
	}
	state := cloneState(committed)
	if s.playback != nil && (state.Paused || state.Current == nil || s.state.Current == nil || state.Current.ID != s.state.Current.ID) {
		s.closePlaybackLocked()
	}
	s.state, s.revision = cloneState(state), revision
	if startPlayback && !state.Paused && state.Current != nil && s.playback == nil {
		if err := s.startLocked(s.ctx, true); err != nil {
			pauseCtx, cancel := context.WithTimeout(context.WithoutCancel(s.ctx), 5*time.Second)
			_ = s.pauseLocked(pauseCtx)
			cancel()
			s.signalLocked()
			return s.revision, err
		}
	}
	s.signalLocked()
	return s.revision, nil
}

func (s *Supervisor) startLocked(ctx context.Context, explicit bool) error {
	if s.state.Paused || s.state.Current == nil {
		return nil
	}
	var p Playback
	var err error
	// Automatic EOF advancement may reuse a live connection, but must never
	// authorize a replacement after the server removed or expired that connection.
	if starter, ok := s.starter.(interface {
		StartExplicit(context.Context, Track) (Playback, error)
	}); explicit && ok {
		p, err = starter.StartExplicit(ctx, *s.state.Current)
	} else {
		p, err = s.starter.Start(ctx, *s.state.Current)
	}
	if err != nil {
		return err
	}
	if p == nil || p.Done() == nil {
		if p != nil {
			_ = p.Close()
		}
		return errors.New("music track starter returned invalid playback")
	}
	s.playback = p
	// Ruling AI (fix round 2): the provider has just started this track from its beginning, so the playhead is 0 from this
	// moment (a slow provider start would otherwise run the client's playhead ahead of the audio). Same revision: the
	// next commit persists it, and snapshots read this live state (MusicInteractions.CurrentState).
	s.state.PositionMS, s.state.PositionAtMS = 0, time.Now().UnixMilli()
	go s.monitor(p)
	return nil
}

func (s *Supervisor) monitor(p Playback) {
	<-p.Done()
	err := p.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.playback != p {
		return
	}
	s.playback = nil
	if err != nil {
		_ = s.pauseLocked(s.ctx)
		s.signalLocked()
		return
	}
	next, applyErr := Apply(s.state, s.state.Revision, Operation{Kind: OpComplete, NowMS: time.Now().UnixMilli()})
	if applyErr != nil {
		_ = s.pauseLocked(s.ctx)
		s.signalLocked()
		return
	}
	revision, saveErr := s.store.Save(s.ctx, s.channel, s.revision, next)
	if saveErr != nil {
		_ = s.pauseLocked(s.ctx)
		s.signalLocked()
		return
	}
	s.state, s.revision = next, revision
	if !s.state.Paused && s.state.Current != nil {
		if err := s.startLocked(s.ctx, false); err != nil {
			_ = s.pauseLocked(s.ctx)
		}
	}
	s.signalLocked()
}

func (s *Supervisor) pauseLocked(ctx context.Context) error {
	next, err := Apply(s.state, s.state.Revision, Operation{Kind: OpPause, NowMS: time.Now().UnixMilli()})
	if err != nil {
		s.state.Paused = true
		return err
	}
	revision, err := s.store.Save(ctx, s.channel, s.revision, next)
	if err != nil {
		s.state.Paused = true
		return err
	}
	s.state, s.revision = next, revision
	return nil
}

// EmptyRoom pauses the queue, closes the per-track provider, and schedules the
// caller's leave action after the configured grace. Position remains the last
// persisted value; this supervisor is not ready for production until providers
// can pause and report the current position accurately.
func (s *Supervisor) EmptyRoom(ctx context.Context) error {
	if ctx == nil {
		return errors.New("nil music operation context")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrSupervisorClosed
	}
	next, err := Apply(s.state, s.state.Revision, Operation{Kind: OpPause, NowMS: time.Now().UnixMilli()})
	if err != nil {
		return err
	}
	revision, err := s.store.Save(ctx, s.channel, s.revision, next)
	if err != nil {
		return err
	}
	s.state, s.revision = next, revision
	s.closePlaybackLocked()
	if s.emptyTimer != nil {
		s.emptyTimer.Stop()
	}
	if s.onEmpty != nil {
		s.emptyTimer = s.afterFunc(s.grace, s.onEmpty)
	}
	s.signalLocked()
	return nil
}

// RoomOccupied cancels a pending leave callback when someone returns.
func (s *Supervisor) RoomOccupied() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.emptyTimer != nil {
		s.emptyTimer.Stop()
		s.emptyTimer = nil
	}
}

func (s *Supervisor) closePlaybackLocked() {
	if s.playback != nil {
		p := s.playback
		s.playback = nil
		_ = p.Close()
	}
}
func (s *Supervisor) signalLocked() { close(s.changed); s.changed = make(chan struct{}) }

// WaitForChange waits until persisted state or playback status changes.
func (s *Supervisor) WaitForChange(ctx context.Context) error {
	if ctx == nil {
		return errors.New("nil music wait context")
	}
	s.mu.Lock()
	changed := s.changed
	s.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-changed:
		return nil
	}
}

func (s *Supervisor) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.stopLifetime != nil {
		s.stopLifetime()
	}
	if s.emptyTimer != nil {
		s.emptyTimer.Stop()
		s.emptyTimer = nil
	}
	s.closePlaybackLocked()
	var err error
	if closer, ok := s.starter.(io.Closer); ok {
		err = closer.Close()
	}
	s.signalLocked()
	return err
}
