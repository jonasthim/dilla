package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type musicInteractionResolverFake struct {
	tracks    []music.Track
	err       error
	inputs    []string
	onResolve func()
}

type musicSpotifyResolverFake struct {
	tracks     []music.Track
	err        error
	inputs     []string
	requesters []id.ID
}

func (r *musicSpotifyResolverFake) ResolveSpotify(_ context.Context, input string, requester id.ID) ([]music.Track, error) {
	r.inputs = append(r.inputs, input)
	r.requesters = append(r.requesters, requester)
	return append([]music.Track(nil), r.tracks...), r.err
}

func (r *musicInteractionResolverFake) Resolve(_ context.Context, input string) ([]music.Track, error) {
	r.inputs = append(r.inputs, input)
	if r.onResolve != nil {
		r.onResolve()
	}
	return append([]music.Track(nil), r.tracks...), r.err
}

type musicInteractionStoreFake struct {
	snapshot persistence.Snapshot
	saves    int
}

func (s *musicInteractionStoreFake) Load(context.Context, id.ID) (persistence.Snapshot, error) {
	return s.snapshot, nil
}

type musicInteractionRestartViewStore struct{ *musicInteractionStoreFake }

func (s musicInteractionRestartViewStore) Load(_ context.Context, _ id.ID) (persistence.Snapshot, error) {
	snapshot := s.snapshot
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
	call           MusicCallBinding
	callAfterFirst *MusicCallBinding
	dj             bool
	djAfterFirst   *bool
	user           bool
	emergency      bool
	callChecks     int
	roleChecks     int
}

func (a *musicInteractionAuthorityFake) CurrentCall(_ context.Context, channel id.ID) (MusicCallBinding, error) {
	a.callChecks++
	if a.callChecks > 1 && a.callAfterFirst != nil {
		a.call = *a.callAfterFirst
	}
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
	if a.roleChecks > 1 && a.djAfterFirst != nil {
		return *a.djAfterFirst, nil
	}
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

func TestMusicSearchReturnsResolvedTracksWithoutWritingQueue(t *testing.T) {
	channel, community := interactionID(55), interactionID(52)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: false}
	resolver := &musicInteractionResolverFake{tracks: []music.Track{{
		ID: "yt:abcdefghijk", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Track", Artist: "Artist", DurationMS: 123000,
	}}}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Args: []any{"search terms"}}
	result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicSearch)
	if err != nil || result.Status != 0 || result.Revision != nil {
		t.Fatalf("search result=%+v err=%v, want success without queue revision", result, err)
	}
	want, err := cborx.Marshal([]any{uint64(1), []any{[]any{"yt:abcdefghijk", "youtube", "abcdefghijk", "Track", "Artist", "", uint64(123000), ""}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(result.Data) != string(want) {
		t.Fatalf("search data=%x, want track tuples %x", result.Data, want)
	}
	if len(resolver.inputs) != 1 || resolver.inputs[0] != "search terms" || store.saves != 0 {
		t.Fatalf("resolver inputs=%v saves=%d, want one lookup and no queue write", resolver.inputs, store.saves)
	}
}

func TestMusicEnqueueImportsResolvedPlaylistAtomicallyWithStableQueueIDs(t *testing.T) {
	channel, community := interactionID(65), interactionID(62)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	resolver := &musicInteractionResolverFake{tracks: []music.Track{
		{ID: "yt:abcdefghijk", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One"},
		{ID: "yt:12345678901", Provider: music.ProviderYouTube, CanonicalID: "12345678901", Title: "Two"},
	}}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"https://www.youtube.com/playlist?list=PLabc_123"}}
	actor := InteractionActor{User: interactionID(68)}
	result, err := h.handle(context.Background(), actor, request, protocol.OpMusicEnqueue)
	if err != nil || result.Status != 0 || result.Revision == nil || *result.Revision != 1 {
		t.Fatalf("enqueue result=%+v err=%v, want committed revision 1", result, err)
	}
	if len(store.snapshot.State.Queue) != 2 || store.snapshot.State.Queue[0].Title != "One" || store.snapshot.State.Queue[1].Title != "Two" {
		t.Fatalf("stored queue=%+v, want both playlist tracks", store.snapshot.State.Queue)
	}
	for _, queued := range store.snapshot.State.Queue {
		if queued.ID == "yt:abcdefghijk" || queued.ID == "yt:12345678901" || queued.RequesterID != actor.User.String() {
			t.Fatalf("queued descriptor=%+v, want a unique queue ID and requesting actor", queued)
		}
	}
	if store.snapshot.State.Queue[0].ID == store.snapshot.State.Queue[1].ID || authority.callChecks != 2 || authority.roleChecks != 2 {
		t.Fatalf("queue IDs=%q/%q call checks=%d role checks=%d, want unique IDs and final authorization recheck", store.snapshot.State.Queue[0].ID, store.snapshot.State.Queue[1].ID, authority.callChecks, authority.roleChecks)
	}
}

func TestMusicEnqueueImportsSpotifyPlaylistAtomicallyForActor(t *testing.T) {
	channel, community, actorID := interactionID(165), interactionID(162), interactionID(168)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	input := "https://open.spotify.com/playlist/BBBBBBBBBBBBBBBBBBBBBB"
	resolver := &musicSpotifyResolverFake{tracks: []music.Track{
		{Provider: music.ProviderSpotify, CanonicalID: "spotify:track:0123456789012345678901", Title: "One"},
		{Provider: music.ProviderSpotify, CanonicalID: "spotify:track:1123456789012345678901", Title: "Two"},
	}}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, SpotifyResolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{input}}
	result, err := h.handle(context.Background(), InteractionActor{User: actorID}, request, protocol.OpMusicEnqueue)
	if err != nil || result.Status != 0 || result.Revision == nil || *result.Revision != 1 {
		t.Fatalf("Spotify enqueue result=%+v err=%v resolver inputs=%v, want committed revision 1", result, err, resolver.inputs)
	}
	if len(resolver.inputs) != 1 || resolver.inputs[0] != input || len(resolver.requesters) != 1 || resolver.requesters[0] != actorID {
		t.Fatalf("Spotify resolver inputs=%v requesters=%v, want one input with actor requester", resolver.inputs, resolver.requesters)
	}
	if store.saves != 1 || len(store.snapshot.State.Queue) != 2 || store.snapshot.State.Queue[0].Provider != music.ProviderSpotify || store.snapshot.State.Queue[1].Provider != music.ProviderSpotify {
		t.Fatalf("saved=%d queue=%+v, want one atomic Spotify playlist import", store.saves, store.snapshot.State.Queue)
	}
	for _, track := range store.snapshot.State.Queue {
		if track.ID == "" || track.RequesterID != actorID.String() {
			t.Fatalf("queued track=%+v, want stable ID and actor requester", track)
		}
	}
}

func TestMusicEnqueueRejectsOversizedSpotifyImportWithoutPartialWrite(t *testing.T) {
	channel, community := interactionID(175), interactionID(172)
	tracks := make([]music.Track, 501)
	for i := range tracks {
		tracks[i] = music.Track{Provider: music.ProviderSpotify, CanonicalID: "spotify:track:0123456789012345678901", Title: "Track"}
	}
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	resolver := &musicSpotifyResolverFake{tracks: tracks}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, SpotifyResolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB"}}
	result, err := h.handle(context.Background(), InteractionActor{User: interactionID(178)}, request, protocol.OpMusicEnqueue)
	if err != nil || result.Status != interactionStatusUnavailable || store.saves != 0 || len(store.snapshot.State.Queue) != 0 {
		t.Fatalf("oversized Spotify enqueue result=%+v err=%v saves=%d queue=%d, want unavailable without partial write", result, err, store.saves, len(store.snapshot.State.Queue))
	}
}

func TestMusicEnqueueRejectsWholePlaylistWhenQueueCapWouldBeExceeded(t *testing.T) {
	channel, community := interactionID(75), interactionID(72)
	state := music.InitialState()
	for i := 0; i < music.QueueLimit; i++ {
		state.Queue = append(state.Queue, music.Track{ID: fmt.Sprintf("existing-%d", i), Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Existing", RequesterID: "member"})
	}
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: state, Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	resolver := &musicInteractionResolverFake{tracks: []music.Track{
		{ID: "yt:abcdefghijk", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One"},
		{ID: "yt:12345678901", Provider: music.ProviderYouTube, CanonicalID: "12345678901", Title: "Two"},
	}}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"https://www.youtube.com/playlist?list=PLabc_123"}}
	result, err := h.handle(context.Background(), InteractionActor{User: interactionID(78)}, request, protocol.OpMusicEnqueue)
	if err != nil || result.Status != interactionStatusUnavailable || store.saves != 0 || len(store.snapshot.State.Queue) != music.QueueLimit {
		t.Fatalf("overflow enqueue result=%+v err=%v saves=%d queue=%d, want unavailable and no partial import", result, err, store.saves, len(store.snapshot.State.Queue))
	}
}

func TestMusicEnqueueRequiresFinalCallAndDJRecheckAfterResolution(t *testing.T) {
	for _, change := range []string{"call", "dj"} {
		t.Run(change, func(t *testing.T) {
			channel, community := interactionID(85), interactionID(82)
			initialCall := MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}
			authority := &musicInteractionAuthorityFake{call: initialCall, user: true, dj: true}
			if change == "call" {
				changed := initialCall
				changed.CallID = id.New()
				authority.callAfterFirst = &changed
			} else {
				denied := false
				authority.djAfterFirst = &denied
			}
			store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
			resolver := &musicInteractionResolverFake{tracks: []music.Track{{ID: "yt:abcdefghijk", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One"}}}
			h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
			request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"one song"}}
			result, err := h.handle(context.Background(), InteractionActor{User: interactionID(88)}, request, protocol.OpMusicEnqueue)
			if err != nil || result.Status != interactionStatusConflict && result.Status != interactionStatusForbidden || store.saves != 0 {
				t.Fatalf("enqueue after %s change result=%+v err=%v saves=%d, want refused before persistence", change, result, err, store.saves)
			}
		})
	}
}

func TestMusicEnqueueRejectsExpiredRequestAfterSlowResolution(t *testing.T) {
	channel, community := interactionID(115), interactionID(112)
	store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
	authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true}
	now := time.Unix(1000, 0)
	resolver := &musicInteractionResolverFake{tracks: []music.Track{{ID: "yt:abcdefghijk", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "One"}}, onResolve: func() {
		now = time.Unix(1030, 0)
	}}
	h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver, Now: func() time.Time { return now }}
	expires := uint64(1030)
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Expires: &expires, Args: []any{"one song"}}
	result, err := h.handle(context.Background(), InteractionActor{User: interactionID(118)}, request, protocol.OpMusicEnqueue)
	if err != nil || result.Status != interactionStatusExpired || store.saves != 0 || len(store.snapshot.State.Queue) != 0 {
		t.Fatalf("late enqueue result=%+v err=%v saves=%d queue=%d, want expired with no mutation", result, err, store.saves, len(store.snapshot.State.Queue))
	}
}

func TestMusicSearchRefusesSpotifyAndBoundsEncodedResults(t *testing.T) {
	t.Run("Spotify", func(t *testing.T) {
		channel, community := interactionID(95), interactionID(92)
		store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
		authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true}
		resolver := &musicInteractionResolverFake{tracks: []music.Track{{ID: "spotify-item", Provider: music.ProviderSpotify, CanonicalID: "spotify:track:0123456789012345678901", Title: "Track"}}}
		h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
		request := protocol.Request{CommunityID: community, ChannelID: &channel, Args: []any{"one song"}}
		result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicSearch)
		if err != nil || result.Status != interactionStatusUnavailable || len(result.Data) != 0 || store.saves != 0 {
			t.Fatalf("Spotify search result=%+v err=%v saves=%d, want unavailable and no queue write", result, err, store.saves)
		}
	})
	t.Run("response limit", func(t *testing.T) {
		channel, community := interactionID(105), interactionID(102)
		store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
		authority := &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true}
		tracks := make([]music.Track, youtube.MaxSearchResults)
		for i := range tracks {
			canonicalID := fmt.Sprintf("a%010d", i)
			tracks[i] = music.Track{ID: "yt:" + canonicalID, Provider: music.ProviderYouTube, CanonicalID: canonicalID, Title: strings.Repeat("x", music.MaxMetadataBytes), Artist: strings.Repeat("y", music.MaxMetadataBytes)}
		}
		resolver := &musicInteractionResolverFake{tracks: tracks}
		h := MusicInteractions{Store: store, Authority: authority, CommunityID: community, Resolver: resolver}
		request := protocol.Request{CommunityID: community, ChannelID: &channel, Args: []any{"one song"}}
		result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, request, protocol.OpMusicSearch)
		if err != nil || result.Status != 0 || len(result.Data) == 0 || len(result.Data) > 2400 || store.saves != 0 {
			t.Fatalf("bounded search result status=%d bytes=%d err=%v saves=%d, want success within 2400 bytes and no queue write", result.Status, len(result.Data), err, store.saves)
		}
	})
}

func TestMusicStateReportsCurrentDJControlGrant(t *testing.T) {
	channel := id.New()
	for _, test := range []struct {
		name string
		dj   bool
		want uint64
	}{{name: "DJ", dj: true, want: 1}, {name: "listener", dj: false, want: 0}} {
		t.Run(test.name, func(t *testing.T) {
			store := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState(), Revision: 0}}
			authority := &musicInteractionAuthorityFake{
				call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: test.dj,
			}
			h := MusicInteractions{Store: store, Authority: authority, CommunityID: id.New()}
			result, err := h.handle(context.Background(), InteractionActor{User: id.New()}, protocol.Request{
				CommunityID: h.CommunityID, ChannelID: &channel,
			}, protocol.OpMusicState)
			if err != nil || result.Status != 0 {
				t.Fatalf("state response=%+v err=%v", result, err)
			}
			var snapshot []any
			if err := cborx.Unmarshal(result.Data, &snapshot); err != nil {
				t.Fatalf("decode music snapshot: %v", err)
			}
			if len(snapshot) != 10 {
				t.Fatalf("snapshot fields=%d, want 10", len(snapshot))
			}
			got, ok := snapshot[9].(uint64)
			if !ok || got != test.want || authority.roleChecks != 1 {
				t.Fatalf("control grant=%#v role checks=%d, want %d and one current authorization check", snapshot[9], authority.roleChecks, test.want)
			}
		})
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
