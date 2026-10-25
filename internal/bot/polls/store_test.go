package polls

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type testState struct {
	mu   sync.Mutex
	rows map[string]native.StateEntry
}

func newTestState() *testState { return &testState{rows: map[string]native.StateEntry{}} }
func (s *testState) StateGet(_ context.Context, _ uint64, key []byte) (native.StateValue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.rows[string(key)]
	if !ok {
		return native.StateValue{}, nil
	}
	return native.StateValue{Revision: e.Revision, Value: append([]byte(nil), e.Value...), Tombstone: e.Tombstone}, nil
}
func (s *testState) StateScan(_ context.Context, _ uint64, after []byte, limit uint64) (native.StatePage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var keys []string
	for k := range s.rows {
		if len(after) == 0 || k > string(after) {
			keys = append(keys, k)
		}
	}
	sortStrings(keys)
	if len(keys) > int(limit) {
		keys = keys[:limit]
	}
	out := native.StatePage{}
	for _, k := range keys {
		out.Entries = append(out.Entries, s.rows[k])
	}
	if len(keys) > 0 {
		out.Next = []byte(keys[len(keys)-1])
	}
	return out, nil
}
func (s *testState) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range changes {
		e := s.rows[string(c.Key)]
		if e.Revision != c.ExpectedRevision {
			return nil, ErrConflict
		}
	}
	out := make([]uint64, len(changes))
	for i, c := range changes {
		e := s.rows[string(c.Key)]
		e.Key = append([]byte(nil), c.Key...)
		e.Revision++
		e.Value = append([]byte(nil), c.Value...)
		e.Tombstone = c.Value == nil
		s.rows[string(c.Key)] = e
		out[i] = e.Revision
	}
	return out, nil
}
func sortStrings(a []string) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}
func pid(n byte) (v id.ID) { v[15] = n; return }

func TestCreateVoteReplaceWithdrawAndDurableReplay(t *testing.T) {
	ctx := context.Background()
	state := newTestState()
	store := NewStore(state, pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Lunch?", Answers: []string{"Soup", "Salad"}, CreatedAt: 1000, DueAt: 4600}
	got, err := store.Create(ctx, p.ID, [32]byte{1}, p, now)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != p.ID {
		t.Fatalf("create=%+v", got)
	}
	out, err := store.Vote(ctx, p.ID, pid(6), pid(7), [32]byte{2}, []uint64{0}, 1, now)
	if err != nil || len(out.Choice) != 1 {
		t.Fatalf("vote choices=%v err=%v", out.Choice, err)
	}
	out, err = store.Vote(ctx, p.ID, pid(6), pid(8), [32]byte{3}, []uint64{1}, 2, now)
	if err != nil || len(out.Choice) != 1 || out.Choice[0] != 1 {
		t.Fatalf("replace=%v err=%v", out.Choice, err)
	}
	counts, _, err := store.Counts(ctx, p.ID, pid(6))
	if err != nil || counts[0] != 0 || counts[1] != 1 {
		t.Fatalf("counts=%v err=%v", counts, err)
	}
	_, err = store.Vote(ctx, p.ID, pid(6), pid(9), [32]byte{4}, nil, 3, now)
	if err != nil {
		t.Fatal(err)
	}
	counts, _, err = store.Counts(ctx, p.ID, pid(6))
	if err != nil || counts[1] != 0 {
		t.Fatalf("withdraw counts=%v err=%v", counts, err)
	}
	replay, err := NewStore(state, pid(1)).Vote(ctx, p.ID, pid(6), pid(8), [32]byte{3}, []uint64{1}, 2, now)
	if err != nil || len(replay.Choice) != 1 || replay.Poll.Revision != 3 || replay.Poll.Counts[1] != 1 {
		t.Fatalf("durable replay=%+v err=%v", replay, err)
	}
	_, err = store.Vote(ctx, p.ID, pid(6), pid(8), [32]byte{9}, []uint64{0}, 2, now)
	if !errors.Is(err, ErrMutationIDConflict) {
		t.Fatalf("reuse err=%v", err)
	}
}

func TestPollDeadlineAndClose(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(100, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 100, DueAt: 200}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Vote(ctx, p.ID, pid(6), pid(7), [32]byte{2}, []uint64{0}, 1, time.Unix(200, 0)); !errors.Is(e, ErrClosed) {
		t.Fatalf("deadline vote=%v", e)
	}
	p, e := s.Close(ctx, p.ID, pid(4), pid(8), [32]byte{3}, 1, now, false)
	if e != nil || !p.Closed {
		t.Fatalf("close=%+v err=%v", p, e)
	}
}

func TestMultiChoiceBoundsAndNamedVoters(t *testing.T) {
	ctx := context.Background()
	state := newTestState()
	s := NewStore(state, pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Choose", Answers: []string{"A", "B", "C"}, Multi: true, CreatedAt: 1000, DueAt: 4600}
	_, err := s.Create(ctx, p.ID, [32]byte{1}, p, now)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Vote(ctx, p.ID, pid(5), pid(6), [32]byte{2}, []uint64{0, 2}, 1, now)
	if err != nil || len(out.Choice) != 2 {
		t.Fatalf("multi vote=%+v err=%v", out, err)
	}
	if _, err = s.Vote(ctx, p.ID, pid(7), pid(8), [32]byte{3}, []uint64{0, 0}, 2, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("duplicate option error=%v", err)
	}
	if _, err = s.Vote(ctx, p.ID, pid(7), pid(9), [32]byte{4}, []uint64{3}, 2, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("out of range error=%v", err)
	}
	voters, _, err := s.Voters(ctx, p.ID, 2, nil, 20)
	if err != nil || len(voters) != 1 || voters[0] != pid(5) {
		t.Fatalf("voters=%v err=%v", voters, err)
	}
	if _, _, err = s.Voters(ctx, p.ID, 2, []byte(votePrefix+idhex(pid(9))+"/"), 20); !errors.Is(err, ErrInvalid) {
		t.Fatalf("foreign cursor error=%v", err)
	}
}

func TestListCursorPagesStayBoundToCommunityChannelAndThread(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	thread := pid(8)
	for i := byte(10); i < 32; i++ {
		p := Poll{ID: pid(i), CommunityID: pid(1), ChannelID: pid(3), ThreadID: &thread, CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
		if _, e := s.Create(ctx, p.ID, [32]byte{i}, p, now); e != nil {
			t.Fatal(e)
		}
	}
	first, cursor, e := s.List(ctx, pid(3), &thread, "")
	if e != nil || len(first) != pageSize || cursor == "" {
		t.Fatalf("first len=%d cursor=%q err=%v", len(first), cursor, e)
	}
	second, next, e := s.List(ctx, pid(3), &thread, cursor)
	if e != nil || len(second) != 2 || next != "" {
		t.Fatalf("second len=%d next=%q err=%v", len(second), next, e)
	}
	if _, _, e = s.List(ctx, pid(9), &thread, cursor); !errors.Is(e, ErrInvalid) {
		t.Fatalf("wrong channel cursor err=%v", e)
	}
	if len(cursor) > 256 {
		t.Fatalf("cursor bytes=%d", len(cursor))
	}
}

func TestOpenQuotaReleasedByEarlyClose(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 604900}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	closed, e := s.Close(ctx, p.ID, pid(4), pid(5), [32]byte{2}, 1, now, false)
	if e != nil || !closed.Closed {
		t.Fatalf("close=%+v err=%v", closed, e)
	}
	p.ID = pid(6)
	if _, e = s.Create(ctx, p.ID, [32]byte{6}, p, now); e != nil {
		t.Fatalf("create after close err=%v", e)
	}
}

type publisherTest struct {
	calls int
	fail  bool
}

func (p *publisherTest) PublishPoll(context.Context, Poll) error {
	p.calls++
	if p.fail {
		return errors.New("transport unavailable")
	}
	return nil
}
func TestReconcileRetriesPublicationAndStoresReceiptState(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	pub := &publisherTest{fail: true}
	if e := s.Reconcile(ctx, now, pub); e == nil {
		t.Fatal("failed publisher was treated as success")
	}
	pub.fail = false
	if e := NewStore(s.state, pid(1)).Reconcile(ctx, now, pub); e != nil {
		t.Fatal(e)
	}
	got, e := s.Get(ctx, p.ID)
	if e != nil || !got.Published || pub.calls != 2 {
		t.Fatalf("poll=%+v calls=%d err=%v", got, pub.calls, e)
	}
}

func TestConcurrentVotesPreserveCountsWithRevisionCAS(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := byte(10); i < 26; i++ {
		wg.Add(1)
		go func(user byte) {
			defer wg.Done()
			req := pid(user + 40)
			for retry := 0; retry < 50; retry++ {
				current, e := s.Get(ctx, p.ID)
				if e != nil {
					errs <- e
					return
				}
				_, e = s.Vote(ctx, p.ID, pid(user), req, [32]byte{user}, []uint64{uint64(user % 2)}, current.Revision, now)
				if e == nil {
					return
				}
				if !errors.Is(e, ErrConflict) {
					errs <- e
					return
				}
			}
			errs <- ErrConflict
		}(i)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	counts, _, e := s.Counts(ctx, p.ID, pid(70))
	if e != nil {
		t.Fatal(e)
	}
	if counts[0]+counts[1] != 16 {
		t.Fatalf("counts=%v", counts)
	}
}

func TestVoteRejectsStaleRevisionAndClosedPollRemainsReadable(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Vote(ctx, p.ID, pid(5), pid(6), [32]byte{2}, []uint64{0}, 0, now); !errors.Is(e, ErrConflict) {
		t.Fatalf("stale vote=%v", e)
	}
	closed, e := s.Close(ctx, p.ID, pid(4), pid(7), [32]byte{3}, 1, now, false)
	if e != nil {
		t.Fatal(e)
	}
	read, e := s.Get(ctx, p.ID)
	if e != nil || !read.Closed || read.ID != closed.ID {
		t.Fatalf("closed poll read=%+v err=%v", read, e)
	}
}

func TestOpenPollQuotaIsAtomicAndReleasedByClose(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	for n := byte(2); n < 130; n++ {
		p := Poll{ID: pid(n), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
		if _, e := s.Create(ctx, p.ID, [32]byte{n}, p, now); e != nil {
			t.Fatalf("create %d: %v", n, e)
		}
	}
	extra := Poll{ID: pid(130), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
	if _, e := s.Create(ctx, extra.ID, [32]byte{130}, extra, now); !errors.Is(e, ErrQuota) {
		t.Fatalf("129th poll error=%v", e)
	}
	if _, e := s.Close(ctx, pid(2), pid(4), pid(131), [32]byte{131}, 1, now, false); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Create(ctx, extra.ID, [32]byte{130}, extra, now); e != nil {
		t.Fatalf("create after quota release: %v", e)
	}
}

func TestSingleChoiceRejectsMultipleSelections(t *testing.T) {
	ctx := context.Background()
	s := NewStore(newTestState(), pid(1))
	now := time.Unix(1000, 0)
	p := Poll{ID: pid(2), CommunityID: pid(1), ChannelID: pid(3), CreatorID: pid(4), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}
	if _, e := s.Create(ctx, p.ID, [32]byte{1}, p, now); e != nil {
		t.Fatal(e)
	}
	if _, e := s.Vote(ctx, p.ID, pid(5), pid(6), [32]byte{2}, []uint64{0, 1}, 1, now); !errors.Is(e, ErrInvalid) {
		t.Fatalf("multiple selections on single choice=%v", e)
	}
}
