package service

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/reminders"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type reminderStateFake struct {
	mu   sync.Mutex
	rows map[string]native.StateEntry
}

func (s *reminderStateFake) StateGet(_ context.Context, _ uint64, k []byte) (native.StateValue, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.rows[string(k)]
	return native.StateValue{Revision: e.Revision, Value: e.Value, Tombstone: e.Tombstone}, nil
}
func (s *reminderStateFake) StateScan(_ context.Context, _ uint64, after []byte, limit uint64) (native.StatePage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ks := []string{}
	for k := range s.rows {
		if len(after) == 0 || k > string(after) {
			ks = append(ks, k)
		}
	}
	sort.Strings(ks)
	if len(ks) > int(limit) {
		ks = ks[:limit]
	}
	p := native.StatePage{}
	for _, k := range ks {
		p.Entries = append(p.Entries, s.rows[k])
	}
	if len(ks) > 0 {
		p.Next = []byte(ks[len(ks)-1])
	}
	return p, nil
}
func (s *reminderStateFake) StateTransaction(_ context.Context, _ id.ID, cs []native.StateChange) ([]uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rows == nil {
		s.rows = map[string]native.StateEntry{}
	}
	if len(cs) > 64 {
		return nil, errors.New("tx too large")
	}
	for _, c := range cs {
		if s.rows[string(c.Key)].Revision != c.ExpectedRevision {
			return nil, reminders.ErrConflict
		}
	}
	out := make([]uint64, len(cs))
	for i, c := range cs {
		v := s.rows[string(c.Key)]
		v.Key = append([]byte(nil), c.Key...)
		v.Revision++
		v.Value = append([]byte(nil), c.Value...)
		s.rows[string(c.Key)] = v
		out[i] = v.Revision
	}
	return out, nil
}

type reminderAuthorityFake struct {
	member bool
	source bool
	checks int
}

func (a *reminderAuthorityFake) ReminderMember(context.Context, id.ID) (bool, error) {
	a.checks++
	return a.member, nil
}
func (a *reminderAuthorityFake) ReminderSource(context.Context, id.ID, id.ID) (bool, error) {
	a.checks++
	return a.source, nil
}
func reminderTestID(n byte) (v id.ID) { v[15] = n; return }
func newReminderTest(now *time.Time) (ReminderInteractions, *reminderAuthorityFake) {
	auth := &reminderAuthorityFake{member: true, source: true}
	store := reminders.NewStore(&reminderStateFake{}, native.Binding{Community: reminderTestID(1), Installation: reminderTestID(2)})
	return ReminderInteractions{Store: store, Authority: auth, CommunityID: reminderTestID(1), Now: func() time.Time { return *now }}, auth
}
func TestReminderCreateReplayAcrossDevicesKeepsOriginalDeadline(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1000, 0).UTC()
	h, a := newReminderTest(&now)
	payload, _ := cborx.Marshal([]any{uint64(1), uint64(0), uint64(60), "call", "UTC", nil, nil})
	rev := uint64(0)
	expires := uint64(1100)
	r := protocol.Request{RequestID: reminderTestID(8), CommunityID: reminderTestID(1), Operation: protocol.OpReminderCreate, Revision: &rev, Expires: &expires, Args: []any{payload}}
	one, e := h.create(ctx, InteractionActor{User: reminderTestID(4), Device: reminderTestID(5)}, r)
	if e != nil || one.Status != 0 {
		t.Fatalf("create=%+v err=%v", one, e)
	}
	now = now.Add(time.Hour)
	two, e := h.create(ctx, InteractionActor{User: reminderTestID(4), Device: reminderTestID(6)}, r)
	if e != nil || two.Status != 0 || string(one.Data) != string(two.Data) {
		t.Fatalf("replay=%+v err=%v", two, e)
	}
	if a.checks != 2 {
		t.Fatalf("membership not refreshed across replay: %d", a.checks)
	}
}
func TestReminderMembershipRevocationAndCrossUserAreDenied(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1000, 0).UTC()
	h, a := newReminderTest(&now)
	payload, _ := cborx.Marshal([]any{uint64(1), uint64(0), uint64(60), "private text", "UTC", nil, nil})
	rev := uint64(0)
	exp := uint64(1100)
	r := protocol.Request{RequestID: reminderTestID(8), CommunityID: reminderTestID(1), Operation: protocol.OpReminderCreate, Revision: &rev, Expires: &exp, Args: []any{payload}}
	res, _ := h.create(ctx, InteractionActor{User: reminderTestID(4)}, r)
	if res.Status != 0 {
		t.Fatal(res.Status)
	}
	list := protocol.Request{CommunityID: reminderTestID(1), Operation: protocol.OpReminderList, Args: []any{nil}}
	res, _ = h.list(ctx, InteractionActor{User: reminderTestID(7)}, list)
	if res.Status != 0 {
		t.Fatalf("other account should see empty list: %d", res.Status)
	}
	var data []any
	if cborx.Unmarshal(res.Data, &data) != nil || len(data) != 3 || len(data[1].([]any)) != 0 {
		t.Fatalf("cross-user rows leaked: %v", data)
	}
	a.member = false
	res, _ = h.list(ctx, InteractionActor{User: reminderTestID(4)}, list)
	if res.Status != interactionStatusForbidden {
		t.Fatalf("revoked status=%d", res.Status)
	}
}
func TestReminderCreateBoundsTimezoneAndSourceMembership(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1000, 0).UTC()
	h, a := newReminderTest(&now)
	rev := uint64(0)
	exp := uint64(1100)
	makeReq := func(when uint64, zone string, channel any) protocol.Request {
		p, _ := cborx.Marshal([]any{uint64(1), uint64(0), when, "x", zone, channel, nil})
		return protocol.Request{RequestID: reminderTestID(byte(when)), CommunityID: reminderTestID(1), Operation: protocol.OpReminderCreate, Revision: &rev, Expires: &exp, Args: []any{p}}
	}
	actor := InteractionActor{User: reminderTestID(4)}
	res, _ := h.create(ctx, actor, makeReq(59, "UTC", nil))
	if res.Status != interactionStatusUnavailable {
		t.Fatalf("short interval status=%d", res.Status)
	}
	res, _ = h.create(ctx, actor, makeReq(60, "Not/AZone", nil))
	if res.Status != interactionStatusUnavailable {
		t.Fatalf("invalid zone status=%d", res.Status)
	}
	a.source = false
	res, _ = h.create(ctx, actor, makeReq(61, "UTC", reminderTestID(9)))
	if res.Status != interactionStatusForbidden {
		t.Fatalf("source denial status=%d", res.Status)
	}
}

func TestReminderListPagesStayWithinProtocolLimit(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1000, 0).UTC()
	h, _ := newReminderTest(&now)
	actor := InteractionActor{User: reminderTestID(4)}
	rev := uint64(0)
	exp := uint64(1100)
	for i := byte(20); i < 24; i++ {
		p, _ := cborx.Marshal([]any{uint64(1), uint64(0), uint64(60), strings.Repeat("x", 1500), "UTC", nil, nil})
		r := protocol.Request{RequestID: reminderTestID(i), CommunityID: reminderTestID(1), Operation: protocol.OpReminderCreate, Revision: &rev, Expires: &exp, Args: []any{p}}
		out, e := h.create(ctx, actor, r)
		if e != nil || out.Status != 0 {
			t.Fatalf("create status=%d err=%v", out.Status, e)
		}
	}
	req := protocol.Request{CommunityID: reminderTestID(1), Operation: protocol.OpReminderList, Args: []any{nil}}
	out, e := h.list(ctx, actor, req)
	if e != nil || out.Status != 0 || len(out.Data) > reminderPageBytes {
		t.Fatalf("page bytes=%d status=%d err=%v", len(out.Data), out.Status, e)
	}
	var data []any
	if cborx.Unmarshal(out.Data, &data) != nil || data[2] == nil {
		t.Fatalf("expected continuation cursor: %v", data)
	}
}
