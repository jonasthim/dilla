package api_test

import (
	"log/slog"
	"net/http"
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestAFKSettingsRequireManagerAndVoiceInSameCommunity(t *testing.T) {
	e := newEnv(t)
	api.NewCommunities(e.Repo, e.DS, e.Clk, slog.New(slog.DiscardHandler)).Register(e.Mux)
	api.NewChannels(e.Repo, e.DS, e.Clk, 10, slog.New(slog.DiscardHandler)).Register(e.Mux)
	owner, token := e.NewUser("afk-owner")
	other, otherToken := e.NewUser("afk-member")
	cid, elsewhere, voice := id.New(), id.New(), id.New()
	for _, community := range []id.ID{cid, elsewhere} {
		if err := e.Repo.CreateCommunity(t.Context(), store.CommunityRow{ID: community, Owner: owner, Name: "test", PolicyJSON: []byte("{}"), PolicyVersion: 1, Created: 1}); err != nil {
			t.Fatal(err)
		}
		if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: community, UserID: owner, Joined: 1}); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{CommunityID: cid, UserID: other, Joined: 1}); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: voice, CommunityID: &cid, Kind: api.ChannelVoice, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	path := "/v1/communities/" + cid.String() + "/afk/settings"
	if code, _ := e.Do(http.MethodPut, path, otherToken, []any{voice[:], uint64(60)}); code != http.StatusForbidden {
		t.Fatalf("member PUT = %d", code)
	}
	if code, _ := e.Do(http.MethodPut, path, token, []any{elsewhere[:], uint64(60)}); code != http.StatusBadRequest {
		t.Fatalf("foreign channel PUT = %d", code)
	}
	if code, body := e.Do(http.MethodPut, path, token, []any{voice[:], uint64(60)}); code != http.StatusNoContent {
		t.Fatalf("owner PUT = %d: %x", code, body)
	}
	if code, _ := e.Do(http.MethodGet, path, otherToken, nil); code != http.StatusForbidden {
		t.Fatalf("member GET = %d", code)
	}
	code, body := e.Do(http.MethodGet, path, token, nil)
	if code != http.StatusOK {
		t.Fatalf("manager GET = %d: %x", code, body)
	}
	var got []cbor.RawMessage
	if err := cbor.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	var channel id.ID
	var timeout uint64
	if err := cbor.Unmarshal(got[0], &channel); err != nil {
		t.Fatal(err)
	}
	if err := cbor.Unmarshal(got[1], &timeout); err != nil {
		t.Fatal(err)
	}
	if channel != voice || timeout != 60 {
		t.Fatalf("settings = %v, %d", channel, timeout)
	}
	if code, body := e.Do(http.MethodDelete, "/v1/channels/"+voice.String(), token, nil); code != http.StatusNoContent {
		t.Fatalf("delete AFK channel = %d: %x", code, body)
	}
	code, body = e.Do(http.MethodGet, path, token, nil)
	if code != http.StatusOK {
		t.Fatalf("settings after delete = %d: %x", code, body)
	}
	if err := cbor.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	var deleted *id.ID
	if err := cbor.Unmarshal(got[0], &deleted); err != nil || deleted != nil {
		t.Fatalf("deleted destination remained: %x (%v)", got[0], err)
	}
}
