package api_test

import (
	"log/slog"
	"net/http"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/api"
)

// G26: a live role change re-pushes the complete permission of each affected participant; a
// userID scope touches only that user's devices, and "#" shadows are never addressed.
func TestSyncCallGrantsPushesTheCurrentPermission(t *testing.T) {
	e, ch, tok, group, stub, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL, MaxPublishers: 10})
	ownerDev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, ownerDev, 3, nil)
	e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	room := stub.minted()[0][0]
	member, memberDev, _ := joinedMember(t, e, ch, group, "member")
	stub.setPresent(room, &livekit.ParticipantInfo{Identity: ownerDev.String()},
		&livekit.ParticipantInfo{Identity: memberDev.String()}, &livekit.ParticipantInfo{Identity: memberDev.String() + "#x"})
	denyInChannel(t, e, ch, member, api.PermSpeak)
	cid := ownerCommunityOf(t, e, ch)

	if err := api.SyncCallGrants(t.Context(), e.Repo, api.NewResolver(e.Repo), stub, calls, cid, &member, nil); err != nil {
		t.Fatalf("SyncCallGrants(user): %v", err)
	}
	updates := stub.permUpdates()
	if len(updates) != 1 || updates[0].Identity != memberDev.String() || updates[0].Perm.GetCanPublish() {
		t.Fatalf("updates = %+v, want one listen-only push for the member's device", updates)
	}
	if err := api.SyncCallGrants(t.Context(), e.Repo, api.NewResolver(e.Repo), stub, calls, cid, nil, &ch); err != nil {
		t.Fatalf("SyncCallGrants(channel): %v", err)
	}
	if got := stub.permUpdates(); len(got) != 3 || got[1].Identity != ownerDev.String() || !got[1].Perm.GetCanPublish() {
		t.Fatalf("updates after the channel-wide sync = %+v", got)
	}
}

// A user who lost both video and screen_share loses the slot too, after the demotion is pushed.
func TestSyncCallGrantsReleasesTheSlotOfAUserWhoLostVideoAndScreen(t *testing.T) {
	e, ch, tok, group, stub, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL, MaxPublishers: 1})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	share := "/v1/calls/" + decodeCall(t, body).CallID.String() + "/share"
	room := stub.minted()[0][0]
	member, memberDev, memberTok := joinedMember(t, e, ch, group, "member")
	if status, _ := e.Do(http.MethodPost, share, memberTok, []any{}); status != http.StatusNoContent {
		t.Fatalf("member share = %d", status)
	}
	stub.setPresent(room, &livekit.ParticipantInfo{Identity: memberDev.String()})
	denyInChannel(t, e, ch, member, api.PermVideo|api.PermScreenShare)
	if err := api.SyncCallGrants(t.Context(), e.Repo, api.NewResolver(e.Repo), stub, calls,
		ownerCommunityOf(t, e, ch), &member, nil); err != nil {
		t.Fatalf("SyncCallGrants: %v", err)
	}
	if got := stub.permUpdates(); hasCamera(got[len(got)-1].Perm) {
		t.Fatalf("the member kept the camera: %+v", got[len(got)-1].Perm)
	}
	if status, _ := e.Do(http.MethodPost, share, tok, []any{}); status != http.StatusNoContent {
		t.Fatalf("the owner's share after the member lost video = %d, want 204: the slot was not released", status)
	}
}

// The role routes run the sync after their commit: a PUT overwrite reaches the SFU.
func TestAnOverwriteChangeReachesTheLiveCall(t *testing.T) {
	e, ch, tok, group, stub, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).WithDS(e.DS).WithCalls(stub, calls).Register(e.Mux)
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	member, memberDev, _ := joinedMember(t, e, ch, group, "member")
	stub.setPresent(stub.minted()[0][0], &livekit.ParticipantInfo{Identity: memberDev.String()})
	if status, _ := e.Do(http.MethodPut, "/v1/channels/"+ch.String()+"/overwrites/1/"+member.String(), tok,
		[]any{uint64(0), uint64(api.PermSpeak)}); status != http.StatusNoContent {
		t.Fatal("PUT overwrite failed")
	}
	if got := stub.permUpdates(); len(got) != 1 || got[0].Identity != memberDev.String() || got[0].Perm.GetCanPublish() {
		t.Fatalf("updates after the overwrite = %+v, want the member demoted to listen-only", got)
	}
}
