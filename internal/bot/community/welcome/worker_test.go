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
	text         []string
}

func (s *testSender) ResolveWelcome(_ context.Context, _, _ id.ID) (protocol.SendReceipt, bool, error) {
	s.resolveCalls++
	return s.receipt, s.resolveFound, nil
}

func (s *testSender) SendWelcome(_ context.Context, req SendRequest) (protocol.SendReceipt, error) {
	s.calls++
	s.operations = append(s.operations, req.OperationID)
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

func fixture() (*testNative, *testSender, *Processor, id.ID, id.ID, id.ID, id.ID) {
	community, install, user, episode := testID(1), testID(2), testID(3), testID(4)
	n := &testNative{binding: native.Binding{Instance: testID(5), Community: community, Installation: install}, values: map[string]native.StateValue{}, transactions: map[id.ID][]native.StateChange{}}
	s := &testSender{receipt: protocol.SendReceipt{OperationID: testID(9), AttemptID: testID(10), CommunityID: community, GroupID: testID(6), Outcome: protocol.ReceiptAccepted, SendResponse: &protocol.OriginalSendResponse{Sequence: 1, FrankingTag: make([]byte, 32), ReceiveTimestamp: 1, Body: mustCBOR([]any{uint64(1), make([]byte, 32), uint64(1)})}}}
	p, _ := New(n, Options{ChannelID: testID(6), Template: "Welcome {member} to {server} in {channel}", ServerName: "Dilla", ChannelName: "general", MemberName: func(id.ID) string { return "Ada" }, Membership: testMembership(true), Sender: s, Now: func() time.Time { return time.Unix(2_000_000, 0) }})
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
	_ = n
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
