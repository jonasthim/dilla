package announcements

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type schedulerNative struct {
	mu       sync.Mutex
	binding  native.Binding
	value    native.StateValue
	failNext bool
}

func (n *schedulerNative) Binding() native.Binding { return n.binding }
func (n *schedulerNative) StateGet(_ context.Context, _ uint64, _ []byte) (native.StateValue, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.value, nil
}
func (n *schedulerNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.failNext {
		n.failNext = false
		return nil, errors.New("injected state failure")
	}
	if len(changes) != 1 || changes[0].ExpectedRevision != n.value.Revision {
		return nil, errors.New("revision conflict")
	}
	n.value.Revision++
	n.value.Value = append([]byte(nil), changes[0].Value...)
	return []uint64{n.value.Revision}, nil
}

type schedulerDestination bool

func (d schedulerDestination) Exists(context.Context, id.ID) (bool, error) { return bool(d), nil }

type schedulerAuthorization bool

func (a schedulerAuthorization) CanAnnounce(context.Context, id.ID) (bool, error) {
	return bool(a), nil
}

type schedulerDestinationFunc func(context.Context, id.ID) (bool, error)

func (f schedulerDestinationFunc) Exists(ctx context.Context, dest id.ID) (bool, error) {
	return f(ctx, dest)
}

type schedulerAuthorizationFunc func(context.Context, id.ID) (bool, error)

func (f schedulerAuthorizationFunc) CanAnnounce(ctx context.Context, dest id.ID) (bool, error) {
	return f(ctx, dest)
}

type schedulerSender struct {
	mu       sync.Mutex
	requests []SendRequest
	lookups  []SendRequest
	started  chan struct{}
	resume   chan struct{}
	preStart chan struct{}
	startNow chan struct{}
	err      error
	onSend   func()
	receipts map[id.ID]protocol.SendReceipt
}

func (s *schedulerSender) SendAnnouncement(_ context.Context, req SendRequest) (protocol.SendReceipt, error) {
	if s.onSend != nil {
		s.onSend()
	}
	if s.preStart != nil {
		close(s.preStart)
		<-s.startNow
	}
	if req.BeforeSend == nil || !req.BeforeSend() {
		return protocol.SendReceipt{}, ErrSendNotStarted
	}
	s.mu.Lock()
	s.requests = append(s.requests, req)
	s.mu.Unlock()
	if s.started != nil {
		close(s.started)
		<-s.resume
	}
	receipt := acceptedReceipt(req)
	s.mu.Lock()
	if s.receipts == nil {
		s.receipts = make(map[id.ID]protocol.SendReceipt)
	}
	s.receipts[req.OperationID] = receipt
	s.mu.Unlock()
	return receipt, s.err
}

func (s *schedulerSender) LookupAnnouncement(_ context.Context, req SendRequest) (protocol.SendReceipt, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lookups = append(s.lookups, req)
	receipt, ok := s.receipts[req.OperationID]
	return receipt, ok, nil
}

func acceptedReceipt(req SendRequest) protocol.SendReceipt {
	return protocol.SendReceipt{
		OperationID: req.OperationID, AttemptID: req.AttemptID,
		CommunityID: req.CommunityID, GroupID: req.GroupID,
		CiphertextHash: make([]byte, 32),
		Outcome:        protocol.ReceiptAccepted,
		SendResponse:   &protocol.OriginalSendResponse{Sequence: 1, FrankingTag: make([]byte, 32), ReceiveTimestamp: 1, Body: mustCBOR([]any{uint64(1), make([]byte, 32), uint64(1)})},
	}
}

func schedulerFixture(t *testing.T, now *time.Time) (*Scheduler, *schedulerNative, *schedulerSender, id.ID, id.ID) {
	t.Helper()
	community, destination := schedulerID(1), schedulerID(2)
	n := &schedulerNative{binding: native.Binding{Instance: schedulerID(3), Community: community, Installation: schedulerID(4)}}
	sender := &schedulerSender{}
	s, err := NewScheduler(n, SchedulerOptions{
		Destination: schedulerDestination(true), Authorization: schedulerAuthorization(true), Sender: sender, ReceiptLookup: sender,
		Now: func() time.Time { return *now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return s, n, sender, community, destination
}

func schedulerID(v byte) id.ID { var out id.ID; out[15] = v; return out }
func mustCBOR(v any) []byte    { b, _ := cborx.Marshal(v); return b }

func dailyAnnouncement(destination id.ID, text string, revision uint64) Announcement {
	return Announcement{ID: schedulerID(8), DestinationID: destination, Text: text,
		Schedule: Schedule{Kind: Daily, Timezone: "UTC", Hour: 10, Revision: revision}, Enabled: true}
}

func TestSchedulerLateOccurrenceSendsOnceWithStableOperationAcrossRestart(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, n, sender, _, destination := schedulerFixture(t, &now)
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "private announcement", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 10, 0, 0, time.UTC)
	if err := s.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 1 {
		t.Fatalf("send calls = %d, want 1", len(sender.requests))
	}
	first := sender.requests[0]
	if first.Text != "private announcement" || first.OperationID.IsZero() || first.AttemptID.IsZero() {
		t.Fatalf("invalid send request: %+v", first)
	}
	if len(n.value.Value) == 0 {
		t.Fatal("accepted state was not persisted")
	}

	restarted, _, restartedSender, _, _ := schedulerFixture(t, &now)
	restarted.native = n
	if err := restarted.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(restartedSender.requests) != 0 {
		t.Fatalf("accepted occurrence resent %d times", len(restartedSender.requests))
	}
}

func TestSchedulerSkipsOccurrenceMoreThanFifteenMinutesLate(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, _, sender, _, destination := schedulerFixture(t, &now)
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "skip me", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 16, 0, 0, time.UTC)
	if err := s.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 0 {
		t.Fatalf("sent a stale occurrence: %d calls", len(sender.requests))
	}
}

func TestSchedulerSendsDueAnnouncement(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, _, sender, _, destination := schedulerFixture(t, &now)
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "authorized", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	if err := s.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 1 {
		t.Fatalf("send calls = %d, want 1", len(sender.requests))
	}
}

func TestSchedulerRecoversAcceptedReceiptAfterLostStateCommit(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, n, sender, _, destination := schedulerFixture(t, &now)
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "recover accepted", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	sender.onSend = func() { n.mu.Lock(); n.failNext = true; n.mu.Unlock() }
	if err := s.RunDue(context.Background()); err == nil {
		t.Fatal("expected state commit failure after accepted send")
	}
	first := sender.requests[0]
	now = time.Date(2026, 10, 22, 10, 16, 0, 0, time.UTC)
	restarted, _, retry, _, _ := schedulerFixture(t, &now)
	restarted.native = n
	restarted.receiptLookup = sender
	if err := restarted.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(retry.requests) != 0 || len(sender.lookups) != 1 || sender.lookups[0].OperationID != first.OperationID || sender.lookups[0].AttemptID != first.AttemptID {
		t.Fatalf("accepted send recovery did not resolve same IDs: first=%+v retries=%+v lookups=%+v", first, retry.requests, sender.lookups)
	}
}

func TestSchedulerDoesNotSendAfterPermissionLossOrDeletedDestination(t *testing.T) {
	for _, tc := range []struct {
		name            string
		exists, allowed bool
	}{{"permission lost", true, false}, {"destination deleted", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
			s, _, sender, _, destination := schedulerFixture(t, &now)
			s.destination = schedulerDestinationFunc(func(context.Context, id.ID) (bool, error) { return tc.exists, nil })
			s.authorization = schedulerAuthorizationFunc(func(context.Context, id.ID) (bool, error) { return tc.allowed, nil })
			if err := s.Put(context.Background(), dailyAnnouncement(destination, "should not send", 1)); err != nil {
				t.Fatal(err)
			}
			now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
			if err := s.RunDue(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(sender.requests) != 0 {
				t.Fatalf("unauthorized send count=%d", len(sender.requests))
			}
		})
	}
}

func TestSchedulerRechecksLateWindowAtSendStartAfterSlowAuthorization(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, _, sender, _, destination := schedulerFixture(t, &now)
	s.authorization = schedulerAuthorizationFunc(func(context.Context, id.ID) (bool, error) {
		now = time.Date(2026, 10, 22, 10, 16, 0, 0, time.UTC)
		return true, nil
	})
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "too late after policy", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	if err := s.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 0 {
		t.Fatalf("send began after late window closed: %+v", sender.requests)
	}
}

func TestSchedulerRetriesUncertainSendWithSameOperationID(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, n, sender, _, destination := schedulerFixture(t, &now)
	sender.err = errors.New("reply lost")
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "recover me", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	if err := s.RunDue(context.Background()); err == nil {
		t.Fatal("expected uncertain send error")
	}
	first := sender.requests[0]
	restarted, _, retry, _, _ := schedulerFixture(t, &now)
	restarted.native = n
	if err := restarted.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(retry.requests) != 1 || retry.requests[0].OperationID != first.OperationID || retry.requests[0].AttemptID != first.AttemptID {
		t.Fatalf("retry did not reuse durable IDs: first=%+v retry=%+v", first, retry.requests)
	}
}

func TestSchedulerEditDoesNotHoldLockAcrossNetworkAndInvalidatesUnstartedOccurrence(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, _, sender, _, destination := schedulerFixture(t, &now)
	sender.started, sender.resume = make(chan struct{}), make(chan struct{})
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "old text", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	runDone := make(chan error, 1)
	go func() { runDone <- s.RunDue(context.Background()) }()
	<-sender.started
	updated := dailyAnnouncement(destination, "new text", 2)
	updated.Schedule.Hour = 11
	putDone := make(chan error, 1)
	go func() { putDone <- s.Put(context.Background(), updated) }()
	select {
	case err := <-putDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		close(sender.resume)
		t.Fatal("schedule edit blocked behind network send")
	}
	close(sender.resume)
	if err := <-runDone; err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 1 || sender.requests[0].Text != "old text" {
		t.Fatalf("started send changed unexpectedly: %+v", sender.requests)
	}
	if err := s.RunDue(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 1 {
		t.Fatalf("unstarted old occurrence sent after edit: %d", len(sender.requests))
	}
}

func TestSchedulerEditBeforeSendStartGateCancelsOldOccurrence(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 59, 0, 0, time.UTC)
	s, _, sender, _, destination := schedulerFixture(t, &now)
	sender.preStart, sender.startNow = make(chan struct{}), make(chan struct{})
	if err := s.Put(context.Background(), dailyAnnouncement(destination, "old text", 1)); err != nil {
		t.Fatal(err)
	}
	now = time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	runDone := make(chan error, 1)
	go func() { runDone <- s.RunDue(context.Background()) }()
	<-sender.preStart
	updated := dailyAnnouncement(destination, "new text", 2)
	updated.Schedule.Hour = 11
	if err := s.Put(context.Background(), updated); err != nil {
		t.Fatal(err)
	}
	close(sender.startNow)
	if err := <-runDone; err != nil {
		t.Fatal(err)
	}
	if len(sender.requests) != 0 {
		t.Fatalf("old occurrence began after revision update: %+v", sender.requests)
	}
}

func TestSchedulerAggregateStateNeverExceedsNativeStateLimit(t *testing.T) {
	now := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	s, n, _, _, destination := schedulerFixture(t, &now)
	text := strings.Repeat("x", maxAnnouncementText)
	var putErr error
	for i := 1; i <= maxAnnouncements; i++ {
		announcement := dailyAnnouncement(destination, text, 1)
		announcement.ID = schedulerID(byte(i))
		putErr = s.Put(context.Background(), announcement)
		if putErr != nil {
			break
		}
	}
	if putErr == nil {
		t.Fatal("aggregate schedules exceeded native state limit without error")
	}
	if len(n.value.Value) > 262144 {
		t.Fatalf("persisted state is %d bytes, exceeds native 262144-byte limit", len(n.value.Value))
	}
}
