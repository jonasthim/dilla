package welcome

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type testNative struct {
	binding      native.Binding
	values       map[string]native.StateValue
	transactions map[id.ID][]native.StateChange
	failReadback bool
}

func (n *testNative) Binding() native.Binding { return n.binding }
func (n *testNative) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	return n.values[stateMapKey(area, key)], nil
}
func (n *testNative) StateTransaction(_ context.Context, tx id.ID, changes []native.StateChange) ([]uint64, error) {
	if old, ok := n.transactions[tx]; ok {
		if len(old) != len(changes) {
			return nil, errors.New("transaction conflict")
		}
		for i := range old {
			if old[i].Area != changes[i].Area || string(old[i].Key) != string(changes[i].Key) || string(old[i].Value) != string(changes[i].Value) {
				return nil, errors.New("transaction conflict")
			}
		}
	} else {
		n.transactions[tx] = changes
	}
	revs := make([]uint64, len(changes))
	for i, ch := range changes {
		k := stateMapKey(ch.Area, ch.Key)
		current := n.values[k]
		if current.Revision != ch.ExpectedRevision {
			return nil, errors.New("revision conflict")
		}
		current.Revision++
		current.Value = append([]byte(nil), ch.Value...)
		n.values[k] = current
		revs[i] = current.Revision
	}
	return revs, nil
}
func stateMapKey(area uint64, key []byte) string { return string(rune(area)) + ":" + string(key) }

type testSender struct {
	calls        int
	err          error
	receipt      protocol.SendReceipt
	resolveFound bool
	resolveCalls int
	operations   []id.ID
	groups       []id.ID
	text         []string
}

func (s *testSender) ResolveWelcome(_ context.Context, _, _ id.ID) (protocol.SendReceipt, bool, error) {
	s.resolveCalls++
	return s.receipt, s.resolveFound, nil
}

func (s *testSender) SendWelcome(_ context.Context, req SendRequest) (protocol.SendReceipt, error) {
	s.calls++
	s.operations = append(s.operations, req.OperationID)
	s.groups = append(s.groups, req.GroupID)
	s.text = append(s.text, req.Text)
	s.receipt.OperationID = req.OperationID
	s.receipt.AttemptID = req.AttemptID
	s.receipt.CommunityID = req.CommunityID
	s.receipt.GroupID = req.GroupID
	s.receipt.CiphertextHash = make([]byte, 32)
	return s.receipt, s.err
}

type testMembership bool

func (m testMembership) IsCurrentMember(context.Context, id.ID) (bool, error) { return bool(m), nil }

type testDestination struct {
	group id.ID
	err   error
}

func (d testDestination) ResolveTextGroup(context.Context, id.ID, id.ID) (id.ID, error) {
	return d.group, d.err
}

func fixture() (*testNative, *testSender, *Processor, id.ID, id.ID, id.ID, id.ID) {
	community, install, user, episode := testID(1), testID(2), testID(3), testID(4)
	n := &testNative{binding: native.Binding{Instance: testID(5), Community: community, Installation: install}, values: map[string]native.StateValue{}, transactions: map[id.ID][]native.StateChange{}}
	channel, group := testID(6), testID(12)
	s := &testSender{receipt: protocol.SendReceipt{OperationID: testID(9), AttemptID: testID(10), CommunityID: community, GroupID: group, Outcome: protocol.ReceiptAccepted, SendResponse: &protocol.OriginalSendResponse{Sequence: 1, FrankingTag: make([]byte, 32), ReceiveTimestamp: 1, Body: mustCBOR([]any{uint64(1), make([]byte, 32), uint64(1)})}}}
	p, _ := New(n, Options{ChannelID: channel, ExpectedGroupID: group, Destination: testDestination{group: group}, Template: "Welcome {member} to {server} in {channel}", ServerName: "Dilla", ChannelName: "general", MemberName: func(id.ID) string { return "Ada" }, Membership: testMembership(true), Sender: s, Now: func() time.Time { return time.Unix(2_000_000, 0) }})
	return n, s, p, community, user, episode, install
}
func testID(v byte) id.ID   { var out id.ID; out[15] = v; return out }
func mustCBOR(v any) []byte { b, _ := cborx.Marshal(v); return b }
func joinEvent(community, user, episode id.ID, ts uint64) protocol.Event {
	return protocol.Event{ID: testID(7), Sequence: 1, CommunityID: community, Timestamp: ts, Kind: protocol.EventMemberJoin, Data: []any{user, episode}}
}

func TestDuplicateJoinSendsOneEpisode(t *testing.T) {
	n, s, p, c, u, e, _ := fixture()
	ev := joinEvent(c, u, e, 1_999_999)
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s.calls != 1 {
		t.Fatalf("send calls = %d", s.calls)
	}
	if s.text[0] != "Welcome Ada to Dilla in general" {
		t.Fatalf("rendered %q", s.text[0])
	}
	if s.groups[0] == testID(6) || s.groups[0] != testID(12) || s.receipt.GroupID != s.groups[0] {
		t.Fatalf("send group=%s receipt group=%s; want resolved group %s, distinct from channel %s", s.groups[0], s.receipt.GroupID, testID(12), testID(6))
	}
	_ = n
}

func TestConfiguredEventHandlerDistinguishesProvenDisabledFromPending(t *testing.T) {
	n, _, _, community, user, episode, _ := fixture()
	event := joinEvent(community, user, episode, 1_999_999)
	handler := ConfiguredEventHandler(n, nil)
	if err := handler(context.Background(), event); err != nil {
		t.Fatalf("missing config should be a proven no-op: %v", err)
	}
	change, err := ConfigStateChange(Config{ChannelID: testID(6), Template: "hello {member}", ServerName: "Dilla"})
	if err != nil {
		t.Fatal(err)
	}
	change.ExpectedRevision = 0
	if _, err = n.StateTransaction(context.Background(), testID(20), []native.StateChange{change}); err != nil {
		t.Fatal(err)
	}
	if err = handler(context.Background(), event); err == nil || err.Error() != "configured welcome is pending: authenticated current-membership and member-profile APIs are unavailable" {
		t.Fatalf("configured join should remain pending, got %v", err)
	}
}

func TestConfiguredEventHandlerAllowsReconciledStructuralEventsBeforeJoin(t *testing.T) {
	n, _, _, community, user, episode, _ := fixture()
	handler := ConfiguredEventHandler(n, nil)
	for _, kind := range []protocol.EventKind{protocol.EventInstallation, protocol.EventPermission, protocol.EventChannel} {
		if err := handler(context.Background(), protocol.Event{CommunityID: community, Kind: kind}); err != nil {
			t.Fatalf("reconciled event kind %d blocks later joins: %v", kind, err)
		}
	}
	if err := handler(context.Background(), joinEvent(community, user, episode, 1_999_999)); err != nil {
		t.Fatalf("unconfigured join after structural events: %v", err)
	}
}

func TestMalformedWelcomeConfigFailsClosed(t *testing.T) {
	n, _, _, community, user, episode, _ := fixture()
	n.values[stateMapKey(stateArea, []byte(configKey))] = native.StateValue{Revision: 1, Value: []byte{0xff}}
	err := ConfiguredEventHandler(n, nil)(context.Background(), joinEvent(community, user, episode, 1_999_999))
	if err == nil || err.Error() != "malformed welcome configuration" {
		t.Fatalf("malformed state error=%v", err)
	}
}

func TestChangedOrMissingDestinationFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name string
		to   testDestination
	}{
		{name: "changed group", to: testDestination{group: testID(13)}},
		{name: "missing group", to: testDestination{}},
		{name: "resolver error", to: testDestination{err: errors.New("channel is no longer authorized")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, s, p, c, u, e, _ := fixture()
			p.destination = tc.to
			if err := p.Process(context.Background(), joinEvent(c, u, e, 1_999_999)); err == nil {
				t.Fatal("expected destination resolution failure")
			}
			if s.calls != 0 {
				t.Fatalf("sent %d messages to invalid destination", s.calls)
			}
		})
	}
}

func TestRejoinEpisodeHasDifferentOperation(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	first := joinEvent(c, u, e, 1_999_999)
	if err := p.Process(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	next := testID(8)
	if err := p.Process(context.Background(), joinEvent(c, u, next, 1_999_999)); err != nil {
		t.Fatal(err)
	}
	if s.calls != 2 || s.operations[0] == s.operations[1] {
		t.Fatalf("rejoin not distinct: calls=%d", s.calls)
	}
}

func TestOldJoinIsMarkedMissedWithoutSend(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	ev := joinEvent(c, u, e, 1_000_000)
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s.calls != 0 {
		t.Fatalf("old event sent %d messages", s.calls)
	}
}

func TestLeftMemberIsNotWelcomed(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	p.membership = testMembership(false)
	if err := p.Process(context.Background(), joinEvent(c, u, e, 1_999_999)); err != nil {
		t.Fatal(err)
	}
	if s.calls != 0 {
		t.Fatal("sent to a member who already left")
	}
}

func TestAmbiguousSendRemainsPendingForSameOperation(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	s.err = errors.New("response lost")
	ev := joinEvent(c, u, e, 1_999_999)
	if err := p.Process(context.Background(), ev); err == nil {
		t.Fatal("expected ambiguous send error")
	}
	first := s.operations[0]
	s.err = nil
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s.operations[1] != first {
		t.Fatal("retry changed operation id")
	}
	state, err := p.Status(context.Background(), u, e)
	if err != nil || state != StatusPosted {
		t.Fatalf("state=%v err=%v", state, err)
	}
}

func TestExpiredPendingJoinResolvesReceiptWithoutLateSend(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	s.err = errors.New("response lost")
	ev := joinEvent(c, u, e, 1_999_999)
	if err := p.Process(context.Background(), ev); err == nil {
		t.Fatal("expected ambiguous send")
	}
	p.now = func() time.Time { return time.Unix(2_000_000, 0).Add(25 * time.Hour) }
	s.err = nil
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s.calls != 1 || s.resolveCalls != 1 {
		t.Fatalf("late sends=%d receipt lookups=%d", s.calls, s.resolveCalls)
	}
	if status, err := p.Status(context.Background(), u, e); err != nil || status != StatusMissed {
		t.Fatalf("status=%v err=%v", status, err)
	}
}

func TestExpiredPendingAcceptedReceiptIsPostedWithoutResend(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	s.err = errors.New("response lost")
	ev := joinEvent(c, u, e, 1_999_999)
	if err := p.Process(context.Background(), ev); err == nil {
		t.Fatal("expected ambiguous send")
	}
	p.now = func() time.Time { return time.Unix(2_000_000, 0).Add(25 * time.Hour) }
	s.resolveFound = true
	s.err = nil
	if err := p.Process(context.Background(), ev); err != nil {
		t.Fatal(err)
	}
	if s.calls != 1 || s.resolveCalls != 1 {
		t.Fatalf("late sends=%d receipt lookups=%d", s.calls, s.resolveCalls)
	}
	if status, err := p.Status(context.Background(), u, e); err != nil || status != StatusPosted {
		t.Fatalf("status=%v err=%v", status, err)
	}
}

func TestExpiredPendingResolvesReceiptAfterDestinationLoss(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		_, s, p, c, u, e, _ := fixture()
		s.err = errors.New("response lost")
		ev := joinEvent(c, u, e, 1_999_999)
		if err := p.Process(context.Background(), ev); err == nil {
			t.Fatal("expected ambiguous send")
		}
		p.now = func() time.Time { return time.Unix(2_000_000, 0).Add(25 * time.Hour) }
		p.destination = testDestination{err: errors.New("channel deleted")}
		s.resolveFound = accepted
		s.err = nil
		if err := p.Process(context.Background(), ev); err != nil {
			t.Fatal(err)
		}
		want := StatusMissed
		if accepted {
			want = StatusPosted
		}
		if status, err := p.Status(context.Background(), u, e); err != nil || status != want {
			t.Fatalf("accepted=%v status=%v err=%v", accepted, status, err)
		}
		if s.calls != 1 || s.resolveCalls != 1 {
			t.Fatalf("accepted=%v sends=%d lookups=%d", accepted, s.calls, s.resolveCalls)
		}
	}
}

func TestCrossCommunityEventRejected(t *testing.T) {
	_, s, p, _, u, e, _ := fixture()
	if err := p.Process(context.Background(), joinEvent(testID(99), u, e, 1_999_999)); err == nil {
		t.Fatal("accepted foreign event")
	}
	if s.calls != 0 {
		t.Fatal("foreign event triggered a send")
	}
}

func TestLeaveEventRefusesExistingJoinEpisode(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	leave := protocol.Event{ID: testID(11), Sequence: 2, CommunityID: c, Timestamp: 1_999_999, Kind: protocol.EventMemberLeave, Data: []any{u, e}}
	if err := p.Process(context.Background(), leave); err != nil {
		t.Fatal(err)
	}
	if err := p.Process(context.Background(), joinEvent(c, u, e, 1_999_999)); err != nil {
		t.Fatal(err)
	}
	if s.calls != 0 {
		t.Fatal("sent after leave event")
	}
}

func TestUnacceptedReceiptDoesNotMarkPosted(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	s.receipt.Outcome = protocol.ReceiptUnknownAfterRestore
	s.receipt.SendResponse = nil
	if err := p.Process(context.Background(), joinEvent(c, u, e, 1_999_999)); err == nil {
		t.Fatal("expected unknown receipt to remain unresolved")
	}
	state, err := p.Status(context.Background(), u, e)
	if err != nil || state != StatusPending {
		t.Fatalf("state=%v err=%v", state, err)
	}
}

func TestConcurrentDuplicateJoinUsesOneSend(t *testing.T) {
	_, s, p, c, u, e, _ := fixture()
	ev := joinEvent(c, u, e, 1_999_999)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := p.Process(context.Background(), ev); err != nil {
				t.Errorf("process: %v", err)
			}
		}()
	}
	wg.Wait()
	if s.calls != 1 {
		t.Fatalf("send calls=%d", s.calls)
	}
}

func TestRoleGrantIsExplicitlyUnavailable(t *testing.T) {
	_, _, p, _, u, e, _ := fixture()
	if err := p.GrantRole(context.Background(), u, e); !errors.Is(err, ErrRoleGrantUnavailable) {
		t.Fatalf("grant result=%v", err)
	}
}
