package service

import (
	"context"
	"sort"
	"sync"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/polls"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

type pollTestState struct {
	mu   sync.Mutex
	rows map[string]native.StateEntry
}

func (s *pollTestState) StateGet(_ context.Context, _ uint64, key []byte) (native.StateValue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.rows[string(key)]
	if !ok {
		return native.StateValue{}, nil
	}
	return native.StateValue{Revision: e.Revision, Value: e.Value, Tombstone: e.Tombstone}, nil
}
func (s *pollTestState) StateScan(_ context.Context, _ uint64, after []byte, limit uint64) (native.StatePage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.rows))
	for k := range s.rows {
		if len(after) == 0 || k > string(after) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(keys) > int(limit) {
		keys = keys[:limit]
	}
	p := native.StatePage{}
	for _, k := range keys {
		p.Entries = append(p.Entries, s.rows[k])
	}
	if len(keys) > 0 {
		p.Next = []byte(keys[len(keys)-1])
	}
	return p, nil
}
func (s *pollTestState) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rows == nil {
		s.rows = map[string]native.StateEntry{}
	}
	for _, c := range changes {
		if s.rows[string(c.Key)].Revision != c.ExpectedRevision {
			return nil, polls.ErrConflict
		}
	}
	r := make([]uint64, len(changes))
	for i, c := range changes {
		e := s.rows[string(c.Key)]
		e.Key = c.Key
		e.Revision++
		e.Value = c.Value
		s.rows[string(c.Key)] = e
		r[i] = e.Revision
	}
	return r, nil
}

type pollAuthorityFake struct {
	bits   uint64
	member bool
	calls  int
}

func (a *pollAuthorityFake) PollPermissions(context.Context, id.ID, id.ID) (uint64, error) {
	a.calls++
	return a.bits, nil
}
func (a *pollAuthorityFake) PollMember(context.Context, id.ID) (bool, error) { return a.member, nil }

type pollPublisherFake struct {
	calls int
	err   error
}

func (p *pollPublisherFake) PublishPoll(context.Context, polls.Poll) error { p.calls++; return p.err }
func TestPollPermissionIsRefreshedForEveryRead(t *testing.T) {
	a := &pollAuthorityFake{bits: 1 | 64, member: true}
	store := polls.NewStore(&pollTestState{}, pollServiceID(1))
	now := time.Unix(1000, 0)
	pollID := pollServiceID(3)
	_, err := store.Create(context.Background(), pollID, [32]byte{1}, polls.Poll{ID: pollID, CommunityID: pollServiceID(1), ChannelID: pollServiceID(4), CreatorID: pollServiceID(2), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}, now)
	if err != nil {
		t.Fatal(err)
	}
	h := PollInteractions{Store: store, Authority: a, CommunityID: pollServiceID(1), Now: func() time.Time { return time.Unix(1000, 0) }}
	actor := InteractionActor{User: pollServiceID(2), Kind: 0}
	r := protocol.Request{CommunityID: pollServiceID(1), Operation: protocol.OpPollGet, Args: []any{pollID}}
	got, _ := h.get(context.Background(), actor, r)
	if got.Status != 0 {
		t.Fatalf("authorized read status=%d", got.Status)
	}
	if a.calls != 1 {
		t.Fatalf("permission checks=%d want 1", a.calls)
	}
	a.bits = 0
	got, _ = h.get(context.Background(), actor, r)
	if got.Status != interactionStatusForbidden {
		t.Fatalf("revoked read status=%d", got.Status)
	}
	if a.calls != 2 {
		t.Fatalf("permission checks after revocation=%d want 2", a.calls)
	}
}
func pollServiceID(n byte) (v id.ID) { v[15] = n; return }

func TestCreatePublicationFailureIsRecoverableAndDoesNotReportSuccess(t *testing.T) {
	state := &pollTestState{}
	store := polls.NewStore(state, pollServiceID(1))
	authority := &pollAuthorityFake{bits: 2, member: true}
	pub := &pollPublisherFake{err: context.DeadlineExceeded}
	now := time.Unix(1000, 0)
	h := PollInteractions{Store: store, Authority: authority, CommunityID: pollServiceID(1), Now: func() time.Time { return now }, Publisher: pub}
	actor := InteractionActor{User: pollServiceID(2), Kind: 0}
	reqID := pollServiceID(30)
	ch := pollServiceID(3)
	payload, err := cborx.Marshal([]any{uint64(1), ch[:], nil, "Question", []any{"A", "B"}, uint64(0), uint64(3600)})
	if err != nil {
		t.Fatal(err)
	}
	rev := uint64(0)
	expires := uint64(1100)
	r := protocol.Request{RequestID: reqID, CommunityID: pollServiceID(1), Operation: protocol.OpPollCreate, Revision: &rev, Expires: &expires, Args: []any{payload}}
	result, err := h.create(context.Background(), actor, r)
	if err != nil || result.Status != interactionStatusUnavailable {
		t.Fatalf("failed publication result=%+v err=%v", result, err)
	}
	pub.err = nil
	if err = h.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	saved, err := store.Get(context.Background(), reqID)
	if err != nil || !saved.Published || pub.calls != 2 {
		t.Fatalf("saved=%+v publishes=%d err=%v", saved, pub.calls, err)
	}
	result, err = h.create(context.Background(), actor, r)
	if err != nil || result.Status != 0 {
		t.Fatalf("replayed create=%+v err=%v", result, err)
	}
}

func TestPollReadsRejectWrongCommunityAndNonHumanActors(t *testing.T) {
	state := &pollTestState{}
	store := polls.NewStore(state, pollServiceID(1))
	now := time.Unix(1000, 0)
	pollID := pollServiceID(3)
	if _, e := store.Create(context.Background(), pollID, [32]byte{1}, polls.Poll{ID: pollID, CommunityID: pollServiceID(1), ChannelID: pollServiceID(4), CreatorID: pollServiceID(2), Question: "Q", Answers: []string{"A", "B"}, CreatedAt: 1000, DueAt: 4600}, now); e != nil {
		t.Fatal(e)
	}
	auth := &pollAuthorityFake{bits: 1 | 64, member: true}
	h := PollInteractions{Store: store, Authority: auth, CommunityID: pollServiceID(1)}
	idBytes := pollID
	r := protocol.Request{CommunityID: pollServiceID(99), Operation: protocol.OpPollGet, Args: []any{idBytes}}
	res, _ := h.get(context.Background(), InteractionActor{User: pollServiceID(2)}, r)
	if res.Status != interactionStatusUnavailable {
		t.Fatalf("wrong community status=%d", res.Status)
	}
	r.CommunityID = pollServiceID(1)
	res, _ = h.get(context.Background(), InteractionActor{User: pollServiceID(2), Kind: 1}, r)
	if res.Status != interactionStatusForbidden || auth.calls != 0 {
		t.Fatalf("nonhuman read=%+v permission calls=%d", res, auth.calls)
	}
}
