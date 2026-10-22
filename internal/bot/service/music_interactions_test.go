package service

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

type musicInteractionStoreFake struct {
	snapshot persistence.Snapshot
	saves    int
}

func (s *musicInteractionStoreFake) Load(context.Context, id.ID) (persistence.Snapshot, error) {
	return s.snapshot, nil
}
func (s *musicInteractionStoreFake) Save(_ context.Context, _ id.ID, expected uint64, state music.State) (persistence.Snapshot, error) {
	if expected != s.snapshot.Revision {
		return persistence.Snapshot{}, persistence.ErrConflict
	}
	s.snapshot = persistence.Snapshot{State: state, Revision: state.Revision}
	s.saves++
	return s.snapshot, nil
}

type musicInteractionAuthorityFake struct {
	call       MusicCallBinding
	dj         bool
	user       bool
	emergency  bool
	callChecks int
	roleChecks int
}

func (a *musicInteractionAuthorityFake) CurrentCall(_ context.Context, channel id.ID) (MusicCallBinding, error) {
	a.callChecks++
	call := a.call
	if call.ChannelID != channel {
		call.ChannelID = channel
	}
	return call, nil
}
func (a *musicInteractionAuthorityFake) CanUse(context.Context, InteractionActor, MusicCallBinding) (bool, error) {
	return a.user, nil
}
func (a *musicInteractionAuthorityFake) CanDJ(context.Context, InteractionActor, MusicCallBinding) (bool, error) {
	a.roleChecks++
	return a.dj, nil
}
func (a *musicInteractionAuthorityFake) CanEmergencyStop(context.Context, InteractionActor, MusicCallBinding) (bool, error) {
	return a.emergency, nil
}

func TestMusicInteractionsRecheckDJAndPersistOnlyQueueState(t *testing.T) {
	channel, callID := id.New(), id.New()
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: callID, ChannelID: channel, Active: true}, user: true, dj: true}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: id.New()}
	request := protocol.Request{CommunityID: h.CommunityID, ChannelID: &channel, Revision: uint64Ptr(0)}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicPause)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != 0 || result.Revision == nil || *result.Revision != 1 || store.saves != 1 {
		t.Fatalf("result=%+v saves=%d, want successful revision 1 state save", result, store.saves)
	}
	if !store.snapshot.State.Paused || store.snapshot.State.Revision != 1 {
		t.Fatalf("stored state=%+v, want paused revision 1", store.snapshot.State)
	}
	if authority.callChecks != 2 || authority.roleChecks != 2 {
		t.Fatalf("call checks=%d role checks=%d, want both rechecked before save", authority.callChecks, authority.roleChecks)
	}
}

func TestMusicInteractionsNonDJCannotMutateAndEmergencyStopIsNarrow(t *testing.T) {
	channel := id.New()
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, emergency: true}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: id.New()}
	request := protocol.Request{CommunityID: h.CommunityID, ChannelID: &channel, Revision: uint64Ptr(0)}
	if got, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicPause); err != nil || got.Status != interactionStatusForbidden {
		t.Fatalf("pause result=%+v err=%v, want forbidden", got, err)
	}
	if got, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicStop); err != nil || got.Status != 0 {
		t.Fatalf("emergency stop result=%+v err=%v, want allowed", got, err)
	}
	if store.saves != 1 {
		t.Fatalf("saves=%d, want only emergency stop persisted", store.saves)
	}
}

func TestMusicInteractionsRejectsStaleBindingAndLeavesUnsupportedProvidersUnavailable(t *testing.T) {
	channel := id.New()
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: false}, user: true, dj: true}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: id.New()}
	request := protocol.Request{CommunityID: h.CommunityID, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"search"}}
	if got, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicSearch); err != nil || got.Status != interactionStatusUnavailable {
		t.Fatalf("inactive-call search result=%+v err=%v, want unavailable", got, err)
	}
	authority.call.Active = true
	if got, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicSearch); err != nil || got.Status != interactionStatusUnavailable {
		t.Fatalf("providerless search result=%+v err=%v, want unavailable", got, err)
	}
	if store.saves != 0 {
		t.Fatalf("unsupported operations wrote %d times", store.saves)
	}
}

func uint64Ptr(v uint64) *uint64 { return &v }

func TestMusicMutationDefersRevisionCheckUntilAuthorization(t *testing.T) {
	channel := interactionID(5)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 7}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: false, dj: true}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: interactionID(2)}
	for operation, spec := range h.Handlers() {
		if operation != protocol.OpMusicState && operation != protocol.OpMusicSearch && (spec.CurrentRevision != nil || !spec.RevisionInHandler) {
			t.Fatalf("operation %v exposes revision before handler authorization", operation)
		}
	}
	d, event, _ := interactionFixture(t, h.Handlers())
	stale := uint64(1)
	expires := uint64(120)
	body, err := protocol.EncodeRequest(protocol.Request{RequestID: id.New(), CommunityID: h.CommunityID, ChannelID: &channel,
		Operation: protocol.OpMusicPause, Revision: &stale, Expires: &expires, Args: []any{}})
	if err != nil {
		t.Fatal(err)
	}
	event.Body = &body
	encoded, err := d.Dispatch(context.Background(), event)
	if err != nil {
		t.Fatal(err)
	}
	response := interactionResponse(t, encoded)
	if response.Status != interactionStatusForbidden || response.Revision != nil {
		t.Fatalf("unauthorized stale request response=%+v, want forbidden without revision", response)
	}
}
