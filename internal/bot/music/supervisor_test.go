package music_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	music "github.com/jonasthim/dilla/internal/bot/music"
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
func (n *supervisorNative) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.rows[string(key)], nil
}
func (n *supervisorNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
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
}

func (p *supervisorPlayback) Done() <-chan struct{} { return p.done }
func (p *supervisorPlayback) Wait() error           { return nil }
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
	starts  []music.Track
	current *supervisorPlayback
	fail    bool
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

func (s *supervisorStarter) Start(_ context.Context, t music.Track) (music.Playback, error) {
	if s.fail {
		return nil, errors.New("start failed")
	}
	s.starts = append(s.starts, t)
	s.current = &supervisorPlayback{done: make(chan struct{})}
	return s.current, nil
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
	if !state.Paused || state.Current == nil || state.Current.ID != track.ID || state.PositionMS != 1234 || wrapped.saves != wrapped.failOnSave {
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
	if p.closed != 1 || !state.Paused || state.PositionMS != 1234 {
		t.Fatalf("pause failed: closed=%d state=%+v", p.closed, state)
	}
	state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	p = starter.current
	if err := s.EmptyRoom(context.Background()); err != nil {
		t.Fatal(err)
	}
	if p.closed != 1 || s.State().Current == nil || s.State().Current.ID != "a" || !s.State().Paused || s.State().PositionMS != 1234 || len(s.State().Queue) != 1 || s.State().Queue[0].ID != "b" {
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
	state, err := s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
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
			state, err = s.Apply(context.Background(), state.Revision, music.Operation{Kind: music.OpResume})
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
