//go:build linux

package main

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

func TestInteractionRegistrationRuntimeUsesStableMemberJoinContext(t *testing.T) {
	var got service.InteractionRegistrationRequest
	calls := 0
	installation := id.New()
	handler := interactionRegistrationEventHandler(installation, func(_ context.Context, req service.InteractionRegistrationRequest) error {
		calls++
		got = req
		return nil
	})
	eventID, user, device := id.New(), id.New(), id.New()
	community := id.New()
	event := protocol.Event{ID: eventID, CommunityID: community, Kind: protocol.EventMemberJoin, Data: []any{user, device}}
	if err := handler(context.Background(), event); err != nil {
		t.Fatalf("first event: %v", err)
	}
	first := got.Group
	if err := handler(context.Background(), event); err != nil {
		t.Fatalf("replayed event: %v", err)
	}
	if calls != 2 || first.IsZero() || got.Group != first || got.ParticipantUser != user || got.ParticipantDevice != device || got.MinimumEligibilityRevision != 0 || len(got.ParticipantKeyPackage) != 0 {
		t.Fatalf("member join did not preserve an idempotent, server-authorized registration request: calls=%d request=%+v", calls, got)
	}
	if first != interactionRegistrationGroupID(installation, event.CommunityID, event.ID, user, device) || first == interactionRegistrationGroupID(id.New(), event.CommunityID, event.ID, user, device) || first == interactionRegistrationGroupID(installation, community, id.New(), user, device) {
		t.Fatal("group ID is not stable and installation-scoped")
	}
}

func TestInteractionRegistrationRuntimeSkipsNonJoinEventsAndExpectedDenial(t *testing.T) {
	calls := 0
	handler := interactionRegistrationEventHandler(id.New(), func(context.Context, service.InteractionRegistrationRequest) error {
		calls++
		return service.ErrInteractionNotEligible
	})
	if err := handler(context.Background(), protocol.Event{ID: id.New(), CommunityID: id.New(), Kind: protocol.EventMemberLeave, Data: []any{id.New(), id.New()}}); err != nil {
		t.Fatalf("leave event: %v", err)
	}
	if err := handler(context.Background(), protocol.Event{ID: id.New(), CommunityID: id.New(), Kind: protocol.EventMemberJoin, Data: []any{id.New(), id.New()}}); err != nil {
		t.Fatalf("expected ineligible member refusal: %v", err)
	}
	if calls != 1 {
		t.Fatalf("registration called %d times, want only for member join", calls)
	}
}

func TestInteractionRegistrationRuntimePropagatesOperationalFailure(t *testing.T) {
	want := errors.New("snapshot unavailable")
	handler := interactionRegistrationEventHandler(id.New(), func(context.Context, service.InteractionRegistrationRequest) error { return want })
	if err := handler(context.Background(), protocol.Event{ID: id.New(), CommunityID: id.New(), Kind: protocol.EventMemberJoin, Data: []any{id.New(), id.New()}}); !errors.Is(err, want) {
		t.Fatalf("handler error = %v, want %v", err, want)
	}
}
