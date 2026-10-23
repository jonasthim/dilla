package service

import (
	"context"
	"errors"
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

type musicInteractionRestartViewStore struct{ *musicInteractionStoreFake }

func (s musicInteractionRestartViewStore) Load(_ context.Context, _ id.ID) (persistence.Snapshot, error) {
	snapshot := s.musicInteractionStoreFake.snapshot
	snapshot.State.Paused = true // Match persistence.Store's restart-safe read view.
	return snapshot, nil
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

func TestMusicInteractionsNotifiesSnapshotBridgeOnlyAfterSuccessfulCommit(t *testing.T) {
	channel, community, installation := interactionID(5), interactionID(2), interactionID(3)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	var commits []uint64
	h := MusicInteractions{Store: store, Authority: authority, InstallationID: installation, CommunityID: community,
		OnPersistedSnapshot: func(_ context.Context, gotInstallation, gotCommunity, gotChannel id.ID, _ music.State, revision uint64, _ bool) (uint64, error) {
			if gotInstallation != installation || gotCommunity != community || gotChannel != channel {
				t.Errorf("bridge context=(%s,%s,%s), want (%s,%s,%s)", gotInstallation, gotCommunity, gotChannel, installation, community, channel)
			}
			if store.snapshot.Revision != revision {
				t.Errorf("bridge revision=%d before store revision=%d", revision, store.snapshot.Revision)
			}
			commits = append(commits, revision)
			return revision, nil
		}}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0)}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicPause)
	if err != nil || result.Status != 0 || len(commits) != 1 || commits[0] != 1 {
		t.Fatalf("successful commit result=%+v err=%v bridge revisions=%v", result, err, commits)
	}
	request.Revision = uint64Ptr(0)
	result, err = h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicPause)
	if err != nil || result.Status != interactionStatusConflict || len(commits) != 1 {
		t.Fatalf("conflicting commit result=%+v err=%v bridge revisions=%v, want no second notification", result, err, commits)
	}
}

func TestMusicInteractionsMarksOnlyCommittedResumeForLiveHandoff(t *testing.T) {
	channel, community := interactionID(15), interactionID(12)
	state, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{
		ID: "track-1", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Track", RequesterID: "member",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: state, Revision: state.Revision}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	var liveResume bool
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community,
		OnPersistedSnapshot: func(_ context.Context, _, _, _ id.ID, _ music.State, revision uint64, resume bool) (uint64, error) {
			liveResume = resume
			return revision, nil
		}}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(state.Revision)}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicPause)
	if err != nil || result.Status != 0 || liveResume {
		t.Fatalf("pause result=%+v err=%v liveResume=%v", result, err, liveResume)
	}
	request.Revision = result.Revision
	result, err = h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicResume)
	if err != nil || result.Status != 0 || !liveResume || result.Revision == nil || *result.Revision != 3 {
		t.Fatalf("resume result=%+v err=%v liveResume=%v, want committed explicit resume", result, err, liveResume)
	}
}

func TestMusicInteractionsPreservesLivePlaybackAcrossQueueMetadataMutations(t *testing.T) {
	channel, community := interactionID(35), interactionID(32)
	state, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{
		ID: "track-1", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Track", RequesterID: "member",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	state, err = music.Apply(state, state.Revision, music.Operation{Kind: music.OpResume})
	if err != nil {
		t.Fatal(err)
	}
	base := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: state, Revision: state.Revision}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	var callbackState music.State
	h := MusicInteractions{Store: musicInteractionRestartViewStore{base}, Authority: authority, CommunityID: community,
		CurrentState: func(context.Context, id.ID, id.ID, id.ID) (music.State, uint64, error) {
			return state, state.Revision, nil
		},
		OnPersistedSnapshot: func(_ context.Context, _, _, _ id.ID, committed music.State, revision uint64, liveResume bool) (uint64, error) {
			callbackState = committed
			if liveResume {
				t.Error("volume change was incorrectly marked as Resume")
			}
			return revision, nil
		}}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(state.Revision), Args: []any{uint64(35)}}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicVolume)
	if err != nil || result.Status != 0 || callbackState.Paused || base.snapshot.State.Paused || base.snapshot.State.Volume != 35 {
		t.Fatalf("live volume mutation result=%+v err=%v callback=%+v persisted=%+v", result, err, callbackState, base.snapshot.State)
	}
}

func TestMusicInteractionsRejectsUnsyncedRuntimeStateBeforeMutation(t *testing.T) {
	channel, community := interactionID(45), interactionID(42)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	callbacks := 0
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community,
		CurrentState: func(context.Context, id.ID, id.ID, id.ID) (music.State, uint64, error) {
			return music.State{Revision: 1, Queue: []music.Track{}, Paused: false}, 1, nil
		},
		OnPersistedSnapshot: func(context.Context, id.ID, id.ID, id.ID, music.State, uint64, bool) (uint64, error) {
			callbacks++
			return 0, nil
		}}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{uint64(35)}}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicVolume)
	if err != nil || result.Status != interactionStatusConflict || store.saves != 0 || callbacks != 0 {
		t.Fatalf("unsynced runtime result=%+v err=%v saves=%d callbacks=%d", result, err, store.saves, callbacks)
	}
}

func TestMusicInteractionsReportsUnavailableAndPersistsPauseWhenResumeHandoffFails(t *testing.T) {
	channel, community := interactionID(25), interactionID(22)
	state, err := music.Apply(music.InitialState(), 0, music.Operation{Kind: music.OpEnqueue, Tracks: []music.Track{{
		ID: "track-1", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Track", RequesterID: "member",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: state, Revision: state.Revision}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community,
		OnPersistedSnapshot: func(context.Context, id.ID, id.ID, id.ID, music.State, uint64, bool) (uint64, error) {
			return 0, errors.New("provider start failed")
		}}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(state.Revision)}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicResume)
	if err != nil || result.Status != interactionStatusUnavailable || result.Revision == nil || *result.Revision != 3 {
		t.Fatalf("failed resume result=%+v err=%v, want unavailable at paused revision 3", result, err)
	}
	if !store.snapshot.State.Paused || store.snapshot.Revision != 3 {
		t.Fatalf("failed resume persisted state=%+v revision=%d, want compensating pause", store.snapshot.State, store.snapshot.Revision)
	}
}

func TestMusicInteractionsNonDJCannotMutateAndEmergencyStopIsNarrow(t *testing.T) {
	channel := id.New()
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, emergency: true}
	bridgeCalls := 0
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: id.New(), OnPersistedSnapshot: func(context.Context, id.ID, id.ID, id.ID, music.State, uint64, bool) (uint64, error) {
		bridgeCalls++
		return 0, nil
	}}
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
	if bridgeCalls != 1 {
		t.Fatalf("runtime handoffs=%d, want only the authorized stop handoff", bridgeCalls)
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
