package music_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	music "github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type supervisorNative struct {
	mu      sync.Mutex
	rows    map[string]native.StateValue
	binding native.Binding
}

type supervisorStore struct{ inner *persistence.Store }

type failingStore struct {
	supervisorStore
	saves      int
	failOnSave int
}

func (s *failingStore) Save(ctx context.Context, channel id.ID, expected uint64, state music.State) (uint64, error) {
	s.saves++
	if s.saves == s.failOnSave {
		return 0, errors.New("save failed")
	}
	return s.supervisorStore.Save(ctx, channel, expected, state)
}

func (s supervisorStore) Load(ctx context.Context, channel id.ID) (music.State, uint64, error) {
	x, err := s.inner.Load(ctx, channel)
	return x.State, x.Revision, err
}
func (s supervisorStore) Save(ctx context.Context, channel id.ID, expected uint64, state music.State) (uint64, error) {
	x, err := s.inner.Save(ctx, channel, expected, state)
	return x.Revision, err
}

func (n *supervisorNative) Binding() native.Binding { return n.binding }
func (n *supervisorNative) StateGet(ctx context.Context, area uint64, key []byte) (native.StateValue, error) {
	if err := ctx.Err(); err != nil {
		return native.StateValue{}, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.rows[string(key)], nil
}
func (n *supervisorNative) StateTransaction(ctx context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	c := changes[0]
	old := n.rows[string(c.Key)]
	if old.Revision != c.ExpectedRevision {
		return nil, persistence.ErrConflict
	}
	n.rows[string(c.Key)] = native.StateValue{Revision: old.Revision + 1, Value: append([]byte(nil), c.Value...)}
	return []uint64{old.Revision + 1}, nil
}

type supervisorPlayback struct {
	done   chan struct{}
	closed int
	err    error
}

func (p *supervisorPlayback) Done() <-chan struct{} { return p.done }
func (p *supervisorPlayback) Wait() error           { return p.err }
func (p *supervisorPlayback) Close() error {
	p.closed++
	select {
	case <-p.done:
	default:
		close(p.done)
	}
	return nil
}

type supervisorStarter struct {
	explicitStarts int
	closed         atomic.Int32
	starts         []music.Track
	current        *supervisorPlayback
	fail           bool
}

type fakeTimer struct {
	fn      func()
	stopped bool
}

func (t *fakeTimer) Stop() bool { was := !t.stopped; t.stopped = true; return was }
func (t *fakeTimer) Fire() {
	if !t.stopped {
		t.fn()
	}
}

func (s *supervisorStarter) Start(ctx context.Context, t music.Track) (music.Playback, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.fail {
		return nil, errors.New("start failed")
	}
	s.starts = append(s.starts, t)
	s.current = &supervisorPlayback{done: make(chan struct{})}
	return s.current, nil
}
func (s *supervisorStarter) StartExplicit(ctx context.Context, track music.Track) (music.Playback, error) {
	s.explicitStarts++
	return s.Start(ctx, track)
}
func (s *supervisorStarter) Close() error { s.closed.Add(1); return nil }

func TestSupervisorCancellationClosesRetainedConnectionOnce(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	starter := &supervisorStarter{}
	supervisor, err := music.NewSupervisor(ctx, tid(4), supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer supervisor.Close()
	cancel()
	deadline := time.After(time.Second)
	for starter.closed.Load() == 0 {
		select {
		case <-deadline:
			t.Fatal("cancellation did not close retained connection")
		case <-time.After(time.Millisecond):
		}
	}
	if err := supervisor.Close(); err != nil {
		t.Fatal(err)
	}
	if starter.closed.Load() != 1 {
		t.Fatal("retained connection closed more than once")
	}
}

func tid(v byte) (x id.ID) { x[15] = v; return }

func TestSupervisorPersistsQueueBeforePlaybackAndNeverAutoplaysRestore(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), tid(4), supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if len(starter.starts) != 0 {
		t.Fatal("restore started audio")
	}
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	state, err := s.Apply(context.Background(), s.State().Revision, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}})
	if err != nil {
		t.Fatal(err)
	}
	if len(starter.starts) != 0 || state.Current != nil {
		t.Fatal("enqueue started audio")
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	if len(starter.starts) != 1 || state.Current == nil || state.Paused {
		t.Fatalf("resume state=%+v starts=%d", state, len(starter.starts))
	}
}

func TestSupervisorRestoresPersistedCurrentPausedWithoutStartingAudio(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	state := music.InitialState()
	track := music.Track{ID: "restored", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Restored", RequesterID: "member"}
	state, err = music.Apply(state, 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}})
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.Save(context.Background(), tid(4), 0, state)
	if err != nil {
		t.Fatal(err)
	}
	state, err = music.Apply(first.State, first.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Save(context.Background(), tid(4), first.Revision, state); err != nil {
		t.Fatal(err)
	}
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), tid(4), supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got := s.State()
	if !got.Paused || got.Current == nil || got.Current.ID != track.ID || len(starter.starts) != 0 {
		t.Fatalf("restore state=%+v starts=%d", got, len(starter.starts))
	}
}

func TestSupervisorAppliesCommittedRevisionWithoutSecondMutationWrite(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	channel := tid(4)
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), channel, supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	nextTrack := music.Track{ID: "b", Provider: music.ProviderYouTube, CanonicalID: "bcdefghijkl", Title: "B", RequesterID: "member"}
	queued, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track, nextTrack}})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Save(context.Background(), channel, 0, queued)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, false); err != nil {
		t.Fatal(err)
	}
	if len(starter.starts) != 0 || s.State().Revision != saved.Revision {
		t.Fatalf("non-resume apply state=%+v starts=%d", s.State(), len(starter.starts))
	}
	playing, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, playing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, true); err != nil {
		t.Fatal(err)
	}
	if len(starter.starts) != 1 || starter.starts[0].ID != track.ID {
		t.Fatalf("committed resume starts=%v, want one start of %s", starter.starts, track.ID)
	}
	skipped, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpSkip})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, skipped)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, true); err != nil {
		t.Fatal(err)
	}
	if starter.explicitStarts != 2 {
		t.Fatalf("committed resume and Skip must authorize their own fresh admission: %d", starter.explicitStarts)
	}
	if len(starter.starts) != 2 || starter.starts[1].ID != nextTrack.ID || starter.current == nil {
		t.Fatalf("committed active Skip starts=%v, want playback of %s", starter.starts, nextTrack.ID)
	}
	loaded, err := store.Load(context.Background(), channel)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Revision != saved.Revision {
		t.Fatalf("successful handoff wrote revision %d, want only committed revision %d", loaded.Revision, saved.Revision)
	}
}

func TestSupervisorAppliesCommittedSkipAfterRequestContextCancellation(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	channel := tid(4)
	starter := &supervisorStarter{}
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	defer cancelLifetime()
	s, err := music.NewSupervisor(lifetime, channel, supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first := music.Track{ID: "first", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "First", RequesterID: "member"}
	second := music.Track{ID: "second", Provider: music.ProviderYouTube, CanonicalID: "bcdefghijkl", Title: "Second", RequesterID: "member"}
	queued, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{first, second}})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Save(context.Background(), channel, 0, queued)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, false); err != nil {
		t.Fatal(err)
	}
	playing, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, playing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, true); err != nil {
		t.Fatal(err)
	}
	skipped, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpSkip})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, skipped)
	if err != nil {
		t.Fatal(err)
	}
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	cancelRequest()
	if _, err := s.ApplyPersistedSnapshot(requestCtx, saved.State, saved.Revision, true); err != nil {
		t.Fatalf("committed Skip handoff with canceled request context: %v", err)
	}
	if got := s.State(); got.Current == nil || got.Current.ID != second.ID || got.Paused {
		t.Fatalf("supervisor state after canceled request context = %+v, want active Second", got)
	}
	if len(starter.starts) != 2 || starter.starts[1].ID != second.ID || starter.current == nil {
		t.Fatalf("playback starts after canceled request context = %v, want Second", starter.starts)
	}
}

func TestSupervisorCommittedResumeFailurePersistsPausedQueue(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	channel := tid(4)
	starter := &supervisorStarter{fail: true}
	s, err := music.NewSupervisor(context.Background(), channel, supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	queued, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Save(context.Background(), channel, 0, queued)
	if err != nil {
		t.Fatal(err)
	}
	playing, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, playing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, true); err == nil {
		t.Fatal("provider failure was ignored")
	}
	loaded, err := store.Load(context.Background(), channel)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.State.Paused || loaded.Revision != saved.Revision+1 {
		t.Fatalf("provider failure state=%+v revision=%d, want a persisted pause after the committed resume", loaded.State, loaded.Revision)
	}
}

func TestSupervisorPausesPersistedQueueWhenPublisherLosesEpoch(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	channel := tid(4)
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), channel, supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	queued, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.Save(context.Background(), channel, 0, queued)
	if err != nil {
		t.Fatal(err)
	}
	playing, err := music.Apply(saved.State, saved.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = store.Save(context.Background(), channel, saved.Revision, playing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPersistedSnapshot(context.Background(), saved.State, saved.Revision, true); err != nil {
		t.Fatal(err)
	}
	playback := starter.current
	playback.err = livekit.ErrEpochChanged
	close(playback.done)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		state := s.State()
		if state.Paused && state.Revision == saved.Revision+1 {
			persisted, loadErr := store.Load(context.Background(), channel)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if !persisted.State.Paused || persisted.Revision != state.Revision {
				t.Fatalf("persisted epoch-loss state=%+v revision=%d", persisted.State, persisted.Revision)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("publisher epoch loss did not pause queue: %+v", s.State())
}

func TestSupervisorFailedStartLeavesStatePausedWhenPauseSaveFails(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, _ := persistence.New(n, tid(2))
	wrapped := &failingStore{supervisorStore: supervisorStore{store}}
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), tid(4), wrapped, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	state, err := s.Apply(context.Background(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}})
	if err != nil {
		t.Fatal(err)
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpSeek, PositionMS: 1234})
	if err != nil {
		t.Fatal(err)
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpPause})
	if err != nil {
		t.Fatal(err)
	}
	starter.fail = true
	wrapped.failOnSave = wrapped.saves + 2 // Resume persists; compensating pause fails.
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err == nil {
		t.Fatal("expected provider start failure")
	}
	if !state.Paused || state.Current == nil || state.Current.ID != track.ID || !nearPlayhead(state.PositionMS, 0) || wrapped.saves != wrapped.failOnSave {
		t.Fatalf("failed start left unsafe state: %+v", state)
	}
}

func TestSupervisorPauseAndEmptyRoomClosePlayback(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, _ := persistence.New(n, tid(2))
	starter := &supervisorStarter{}
	var scheduled *fakeTimer
	left := false
	s, _ := music.NewSupervisor(context.Background(), tid(4), supervisorStore{store}, starter, music.WithEmptyRoomGrace(5*time.Minute, func(_ time.Duration, fn func()) music.Timer { scheduled = &fakeTimer{fn: fn}; return scheduled }, func() { left = true }))
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	queued := music.Track{ID: "b", Provider: music.ProviderYouTube, CanonicalID: "bcdefghijkl", Title: "B", RequesterID: "member"}
	state, _ := s.Apply(context.Background(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track, queued}})
	state, err := s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	p := starter.current
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpSeek, PositionMS: 1234})
	if err != nil {
		t.Fatal(err)
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpPause})
	if err != nil {
		t.Fatal(err)
	}
	// Fix round 2: the seek is not applied to the audio, so the paused playhead is what played since the start.
	if p.closed != 1 || !state.Paused || !nearPlayhead(state.PositionMS, 0) {
		t.Fatalf("pause failed: closed=%d state=%+v", p.closed, state)
	}
	_, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	p = starter.current
	if err := s.EmptyRoom(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p.closed != 1 || s.State().Current == nil || s.State().Current.ID != "a" || !s.State().Paused || !nearPlayhead(s.State().PositionMS, 0) || len(s.State().Queue) != 1 || s.State().Queue[0].ID != "b" {
		t.Fatal("empty room did not pause while preserving current track and queue")
	}
	if left || scheduled == nil {
		t.Fatal("empty-room callback ran before grace expiry")
	}
	scheduled.Fire()
	if !left {
		t.Fatal("expiry callback was not invoked")
	}
	left = false
	if err := s.EmptyRoom(context.Background()); err != nil {
		t.Fatal(err)
	}
	s.RoomOccupied()
	scheduled.Fire()
	if left {
		t.Fatal("returning member did not cancel leave callback")
	}
}

func TestSupervisorAdvancesAfterTrackEOF(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, _ := persistence.New(n, tid(2))
	starter := &supervisorStarter{}
	s, _ := music.NewSupervisor(context.Background(), tid(4), supervisorStore{store}, starter)
	defer s.Close()
	tracks := []music.Track{{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}, {ID: "b", Provider: music.ProviderYouTube, CanonicalID: "bcdefghijkl", Title: "B", RequesterID: "member"}}
	state, _ := s.Apply(context.Background(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: tracks})
	_, err := s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	close(starter.current.done)
	waitCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for {
		current := s.State()
		if current.Current != nil && current.Current.ID == "b" {
			break
		}
		select {
		case <-waitCtx.Done():
			t.Fatal(waitCtx.Err())
		case <-time.After(time.Millisecond):
		}
	}
	if starter.explicitStarts != 1 {
		t.Fatalf("EOF must not authorize a room reconnect: explicit starts=%d", starter.explicitStarts)
	}
	if len(starter.starts) != 2 || s.State().Current == nil || s.State().Current.ID != "b" {
		t.Fatalf("did not advance: starts=%v state=%+v", starter.starts, s.State())
	}
}

func TestSupervisorEOFFailuresLeaveQueuePaused(t *testing.T) {
	for _, phase := range []string{"save completion", "start successor"} {
		t.Run(phase, func(t *testing.T) {
			n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
			store, err := persistence.New(n, tid(2))
			if err != nil {
				t.Fatal(err)
			}
			wrapped := &failingStore{supervisorStore: supervisorStore{store}}
			starter := &supervisorStarter{}
			s, err := music.NewSupervisor(context.Background(), tid(4), wrapped, starter)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			tracks := []music.Track{{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}, {ID: "b", Provider: music.ProviderYouTube, CanonicalID: "bcdefghijkl", Title: "B", RequesterID: "member"}}
			state, err := s.Apply(context.Background(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: tracks})
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
			if err != nil {
				t.Fatal(err)
			}
			if phase == "save completion" {
				wrapped.failOnSave = wrapped.saves + 1
			} else {
				starter.fail = true
			}
			close(starter.current.done)
			deadline := time.Now().Add(time.Second)
			for !s.State().Paused && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			got := s.State()
			wantCurrent, wantQueued := "a", 1
			if phase == "start successor" {
				wantCurrent, wantQueued = "b", 0
			}
			if !got.Paused || got.Current == nil || got.Current.ID != wantCurrent || len(got.Queue) != wantQueued {
				t.Fatalf("EOF %s left unsafe state: %+v", phase, got)
			}
		})
	}
}

func TestSupervisorResumeWhilePlayingKeepsCurrentPublication(t *testing.T) {
	n := &supervisorNative{rows: map[string]native.StateValue{}, binding: native.Binding{Instance: tid(1), Community: tid(2), Installation: tid(3)}}
	store, err := persistence.New(n, tid(2))
	if err != nil {
		t.Fatal(err)
	}
	starter := &supervisorStarter{}
	s, err := music.NewSupervisor(context.Background(), tid(4), supervisorStore{store}, starter)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	track := music.Track{ID: "a", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "A", RequesterID: "member"}
	if _, err := s.Apply(context.Background(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{track}}); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := s.Apply(context.Background(), s.State().Revision, music.Operation{Kind: music.OpResume}); err != nil {
			t.Fatal(err)
		}
	}
	if len(starter.starts) != 1 || s.State().Paused {
		t.Fatalf("repeated Resume replaced a live track: starts=%d state=%+v", len(starter.starts), s.State())
	}
}

// nearPlayhead allows the few milliseconds a playing track advances between a test's resume and its pause (Ruling AI:
// a pause settles the playhead the track reached).
func nearPlayhead(got, want int64) bool { return got >= want && got < want+1000 }
