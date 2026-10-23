package service

import (
	"context"
	"fmt"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

// playlistAcceptanceNative provides the same revision-checked state API used by
// the encrypted native helper while retaining rows across Store instances.
type playlistAcceptanceNative struct {
	binding native.Binding
	rows    map[string]native.StateValue
	writes  int
}

func (n *playlistAcceptanceNative) Binding() native.Binding { return n.binding }
func (n *playlistAcceptanceNative) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	return n.rows[fmt.Sprintf("%d:%s", area, key)], nil
}
func (n *playlistAcceptanceNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	if len(changes) != 1 {
		return nil, fmt.Errorf("expected one state change, got %d", len(changes))
	}
	change := changes[0]
	key := fmt.Sprintf("%d:%s", change.Area, change.Key)
	current := n.rows[key]
	if current.Revision != change.ExpectedRevision {
		return nil, persistence.ErrConflict
	}
	n.writes++
	n.rows[key] = native.StateValue{Revision: current.Revision + 1, Value: append([]byte(nil), change.Value...)}
	return []uint64{current.Revision + 1}, nil
}

// This exercises the registered interaction handler and real persistence.Store:
// an imported playlist that crosses the queue cap must leave the stored queue
// byte-for-byte logically unchanged after the handler reports refusal.
func TestYouTubePlaylistOverflowLeavesPersistedQueueUnchanged(t *testing.T) {
	ctx := context.Background()
	community, channel, user := id.New(), id.New(), id.New()
	nativeStore := &playlistAcceptanceNative{
		binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		rows:    make(map[string]native.StateValue),
	}
	queueStore, err := persistence.New(nativeStore, community)
	if err != nil {
		t.Fatal(err)
	}
	before, err := queueStore.Load(ctx, channel)
	if err != nil {
		t.Fatal(err)
	}
	tracks := make([]music.Track, music.QueueLimit-1)
	for i := range tracks {
		tracks[i] = music.Track{ID: fmt.Sprintf("existing-%03d", i), Provider: music.ProviderYouTube,
			CanonicalID: "abcdefghijk", Title: "Existing", RequesterID: "prior-requester"}
	}
	state, err := music.Apply(before.State, before.Revision, music.Operation{Kind: music.OpEnqueue, Tracks: tracks})
	if err != nil {
		t.Fatal(err)
	}
	before, err = queueStore.Save(ctx, channel, before.Revision, state)
	if err != nil {
		t.Fatal(err)
	}
	writesBeforeImport := nativeStore.writes

	authority := &musicInteractionAuthorityFake{
		call: MusicCallBinding{CallID: id.New(), ChannelID: channel, Active: true}, user: true, dj: true,
	}
	resolver := &musicInteractionResolverFake{tracks: []music.Track{
		{ID: "resolved-one", Provider: music.ProviderYouTube, CanonicalID: "12345678901", Title: "Playlist one"},
		{ID: "resolved-two", Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Playlist two"},
	}}
	h := MusicInteractions{Store: queueStore, Authority: authority, CommunityID: community, Resolver: resolver}
	request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(before.Revision),
		Args: []any{"https://www.youtube.com/playlist?list=PLabc_123"}}
	result, err := h.Handlers()[protocol.OpMusicEnqueue].Handle(ctx, InteractionActor{User: user}, request)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != interactionStatusUnavailable {
		t.Fatalf("playlist enqueue status=%d, want unavailable for cap overflow", result.Status)
	}
	if nativeStore.writes != writesBeforeImport {
		t.Fatalf("overflow import committed %d state write(s), want none", nativeStore.writes-writesBeforeImport)
	}

	restartedStore, err := persistence.New(nativeStore, community)
	if err != nil {
		t.Fatal(err)
	}
	after, err := restartedStore.Load(ctx, channel)
	if err != nil {
		t.Fatal(err)
	}
	if after.Revision != before.Revision || len(after.State.Queue) != music.QueueLimit-1 {
		t.Fatalf("persisted snapshot after refusal: revision=%d queue=%d, want revision=%d queue=%d",
			after.Revision, len(after.State.Queue), before.Revision, music.QueueLimit-1)
	}
	for i, track := range after.State.Queue {
		if track.ID != tracks[i].ID {
			t.Fatalf("persisted queue item %d=%q, want original %q", i, track.ID, tracks[i].ID)
		}
	}
}
