//go:build linux

package main

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

func TestInteractionRegistrationRuntimeUsesStableMemberJoinContext(t *testing.T) {
	var gotUser, gotEpisode id.ID
	calls := 0
	installation := id.New()
	user, episode := id.New(), id.New()
	handler := interactionRegistrationEventHandler(installation, func(_ context.Context, got id.ID, gotEpisodeValue id.ID) error {
		calls++
		gotUser, gotEpisode = got, gotEpisodeValue
		return nil
	})
	eventID := id.New()
	community := id.New()
	event := protocol.Event{ID: eventID, CommunityID: community, Kind: protocol.EventMemberJoin, Data: []any{user, episode}}
	if err := handler(context.Background(), event); err != nil {
		t.Fatalf("first event: %v", err)
	}
	if calls != 1 || gotUser != user || gotEpisode != episode {
		t.Fatalf("member join did not stage the producer's exact user and episode: calls=%d user=%s episode=%s", calls, gotUser, gotEpisode)
	}
}

func TestInteractionRegistrationRuntimeSkipsNonJoinEventsAndExpectedDenial(t *testing.T) {
	calls := 0
	handler := interactionRegistrationEventHandler(id.New(), func(context.Context, id.ID, id.ID) error {
		calls++
		return nil
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
	handler := interactionRegistrationEventHandler(id.New(), func(context.Context, id.ID, id.ID) error { return want })
	if err := handler(context.Background(), protocol.Event{ID: id.New(), CommunityID: id.New(), Kind: protocol.EventMemberJoin, Data: []any{id.New(), id.New()}}); !errors.Is(err, want) {
		t.Fatalf("handler error = %v, want %v", err, want)
	}
}
