package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

type responseOutboxState struct {
	binding native.Binding
	value   native.StateValue
	failCAS bool
	sends   int
}

func (s *responseOutboxState) Binding() native.Binding { return s.binding }
func (s *responseOutboxState) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	if area != interactionResponseOutboxArea || string(key) != string(interactionResponseOutboxKey(s.binding.Installation, 9)) {
		return native.StateValue{}, errors.New("unexpected state key")
	}
	return native.StateValue{Revision: s.value.Revision, Value: append([]byte(nil), s.value.Value...), Tombstone: s.value.Tombstone}, nil
}
func (s *responseOutboxState) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	if s.failCAS {
		return nil, errors.New("injected CAS failure")
	}
	ch := changes[0]
	if ch.ExpectedRevision != s.value.Revision {
		return nil, errors.New("CAS revision conflict")
	}
	s.value = native.StateValue{Revision: s.value.Revision + 1, Value: append([]byte(nil), ch.Value...)}
	return []uint64{s.value.Revision}, nil
}

type responseOutboxSender struct {
	inputs []SendInput
	err    error
	before func(SendInput) error
}

func (s *responseOutboxSender) send(_ context.Context, in SendInput) (protocol.SendReceipt, error) {
	if s.before != nil {
		if err := s.before(in); err != nil {
			return protocol.SendReceipt{}, err
		}
	}
	s.inputs = append(s.inputs, SendInput{OperationID: in.OperationID, AttemptID: in.AttemptID, GroupID: in.GroupID,
		RequestBody: append([]byte(nil), in.RequestBody...), OriginalNow: in.OriginalNow, ExpectedGeneration: in.ExpectedGeneration})
	if s.err != nil {
		return protocol.SendReceipt{}, s.err
	}
	return protocol.SendReceipt{OperationID: in.OperationID, AttemptID: in.AttemptID}, nil
}

func responseOutboxFixture(t *testing.T) (*responseOutboxState, *responseOutboxSender, native.GroupEvent) {
	t.Helper()
	b := native.Binding{Instance: interactionID(21), Community: interactionID(22), Installation: interactionID(23)}
	body, err := protocol.EncodeRequest(protocol.Request{RequestID: interactionID(24), CommunityID: b.Community, Operation: protocol.OpOverviewGet, Args: []any{}})
	if err != nil {
		t.Fatal(err)
	}
	event := native.GroupEvent{DeliveryID: 9, Group: interactionID(25), Community: b.Community, Channel: interactionID(26), SourceSequence: 4, Epoch: 7,
		SenderUser: interactionID(27), SenderDevice: interactionID(28), SenderKind: 0, SenderTier: 0, Message: interactionID(29), EnvelopeType: 0, Body: &body}
	state, sender := &responseOutboxState{binding: b}, &responseOutboxSender{}
	return state, sender, event
}

func newResponseOutbox(t *testing.T, state *responseOutboxState, sender *responseOutboxSender) *InteractionResponseOutbox {
	t.Helper()
	o, err := newInteractionResponseOutbox(state, sender.send)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestInteractionResponseOutboxRestartReusesExactPersistedResponseAndSendIdentity(t *testing.T) {
	ctx := context.Background()
	state, firstSender, event := responseOutboxFixture(t)
	firstSender.before = func(in SendInput) error {
		if state.value.Revision != 1 || len(state.value.Value) == 0 {
			return errors.New("send started before response was durably persisted")
		}
		saved, err := decodeInteractionResponseRecord(state.value.Value)
		if err != nil || string(saved.ResponseBody) != string(in.RequestBody) || saved.OperationID != in.OperationID || saved.AttemptID != in.AttemptID {
			return errors.New("persisted response does not match send input")
		}
		return nil
	}
	first := newResponseOutbox(t, state, firstSender)
	if _, err := first.Send(ctx, event, []byte("response-one"), interactionID(30), interactionID(31), 123, 8); err != nil {
		t.Fatal(err)
	}
	secondSender := &responseOutboxSender{}
	second := newResponseOutbox(t, state, secondSender) // simulate process restart
	saved, found, err := second.Lookup(ctx, event)
	if err != nil || !found || string(saved.Body) != "response-one" || saved.OperationID != interactionID(30) || saved.AttemptID != interactionID(31) {
		t.Fatalf("lookup found=%v saved=%#v err=%v", found, saved, err)
	}
	if _, found, err := second.Resume(ctx, event); err != nil || !found {
		t.Fatal(err)
	}
	if len(secondSender.inputs) != 1 {
		t.Fatalf("restart sends=%d, want 1", len(secondSender.inputs))
	}
	got := secondSender.inputs[0]
	if string(got.RequestBody) != "response-one" || got.OperationID != interactionID(30) || got.AttemptID != interactionID(31) || got.OriginalNow != 123 || got.ExpectedGeneration != 8 {
		t.Fatalf("restart changed persisted send: %#v", got)
	}
}

func TestInteractionResponseOutboxKeepsRevokedPendingResponseUnsent(t *testing.T) {
	ctx := context.Background()
	state, firstSender, event := responseOutboxFixture(t)
	first := newResponseOutbox(t, state, firstSender)
	if _, err := first.Send(ctx, event, []byte("private response"), interactionID(30), interactionID(31), 123, 8); err != nil {
		t.Fatal(err)
	}
	savedValue := append([]byte(nil), state.value.Value...)
	retrySender := &responseOutboxSender{}
	retry := newResponseOutbox(t, state, retrySender)
	revoked := errors.New("read permission revoked")
	preflightCalls := 0
	_, found, err := retry.ResumeWithPreflight(ctx, event, func(context.Context) error {
		preflightCalls++
		return revoked
	})
	if !found || !errors.Is(err, revoked) || preflightCalls != 1 || len(retrySender.inputs) != 0 {
		t.Fatalf("found=%v err=%v checks=%d sends=%d", found, err, preflightCalls, len(retrySender.inputs))
	}
	if string(state.value.Value) != string(savedValue) {
		t.Fatal("denied replay changed the immutable outbox record")
	}
}

func TestInteractionResponseOutboxRejectsConflictingEventRequestIdentity(t *testing.T) {
	ctx := context.Background()
	state, sender, event := responseOutboxFixture(t)
	o := newResponseOutbox(t, state, sender)
	if _, err := o.Send(ctx, event, []byte("response"), interactionID(30), interactionID(31), 123, 8); err != nil {
		t.Fatal(err)
	}
	changed := event
	otherBody, err := protocol.EncodeRequest(protocol.Request{RequestID: interactionID(35), CommunityID: state.binding.Community, Operation: protocol.OpOverviewGet, Args: []any{}})
	if err != nil {
		t.Fatal(err)
	}
	changed.Body = &otherBody
	if _, err := o.Send(ctx, changed, []byte("response-two"), interactionID(36), interactionID(37), 123, 8); !errors.Is(err, ErrInteractionResponseConflict) {
		t.Fatalf("conflicting request error=%v", err)
	}
	if len(sender.inputs) != 1 {
		t.Fatalf("conflict triggered send, count=%d", len(sender.inputs))
	}
}

func TestInteractionResponseOutboxCASFailureNeverSends(t *testing.T) {
	ctx := context.Background()
	state, sender, event := responseOutboxFixture(t)
	state.failCAS = true
	o := newResponseOutbox(t, state, sender)
	if _, err := o.Send(ctx, event, []byte("response"), interactionID(30), interactionID(31), 123, 8); err == nil {
		t.Fatal("expected CAS failure")
	}
	if len(sender.inputs) != 0 {
		t.Fatalf("CAS failure triggered %d sends", len(sender.inputs))
	}
}

func TestInteractionResponseOutboxLostSendResponseRetriesSameAttempt(t *testing.T) {
	ctx := context.Background()
	state, sender, event := responseOutboxFixture(t)
	sender.err = errors.New("response lost after remote acceptance")
	o := newResponseOutbox(t, state, sender)
	if _, err := o.Send(ctx, event, []byte("stable-response"), interactionID(30), interactionID(31), 123, 8); err == nil {
		t.Fatal("expected lost response error")
	}
	sender.err = nil
	if _, err := newResponseOutbox(t, state, sender).Send(ctx, event, []byte("stable-response"), interactionID(32), interactionID(33), 999, 11); err != nil {
		t.Fatal(err)
	}
	if len(sender.inputs) != 2 {
		t.Fatalf("send calls=%d, want 2", len(sender.inputs))
	}
	first, second := sender.inputs[0], sender.inputs[1]
	if first.OperationID != second.OperationID || first.AttemptID != second.AttemptID || first.OriginalNow != second.OriginalNow || first.ExpectedGeneration != second.ExpectedGeneration || string(first.RequestBody) != string(second.RequestBody) {
		t.Fatalf("retry changed attempt: first=%#v second=%#v", first, second)
	}
}

func TestInteractionResponseOutboxRejectsSendCoordinatorForDifferentInstallation(t *testing.T) {
	state, _, _ := responseOutboxFixture(t)
	otherBinding := state.binding
	otherBinding.Installation = interactionID(44)
	if otherBinding.Community != state.binding.Community {
		t.Fatal("fixture must share community")
	}
	n := &sendNativeFake{binding: otherBinding}
	coordinator, err := newSendCoordinator(n, sendAuthorityFake{discovery: client.Discovery{InstanceID: otherBinding.Instance, Generation: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newInteractionResponseOutboxWithCoordinator(state, coordinator, &client.Session{}); err == nil {
		t.Fatal("outbox accepted a coordinator bound to a different installation in the same community")
	}
}
