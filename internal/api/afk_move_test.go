package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type afkDisconnected struct{}

func (afkDisconnected) Online(id.ID) bool { return false }

func TestAFKTimeoutCutsMediaAndBlocksRejoin(t *testing.T) {
	b := newMembershipCallEnvWithoutLoop(t)
	afk := id.New()
	if err := b.e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: afk, CommunityID: &b.cid, Kind: 1, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	if err := b.e.Repo.SetCommunityAFK(t.Context(), b.cid, store.CommunityAFK{ChannelID: &afk, TimeoutSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	activity := "/v1/communities/" + b.cid.String() + "/afk/activity"
	if code, body := b.e.Do(http.MethodPost, activity, b.memberTok, []any{b.ch[:]}); code != http.StatusNoContent {
		t.Fatalf("activity = %d: %x", code, body)
	}
	b.e.Clk.Advance(59 * time.Second)
	b.calls.SweepAFK(t.Context())
	if removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("moved before timeout")
	}
	b.e.Clk.Advance(2 * time.Second)
	b.calls.SweepAFK(t.Context())
	if !removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("idle device kept its media session")
	}
	if code, _ := b.e.Do(http.MethodPost, "/v1/channels/"+b.ch.String()+"/calls", b.memberTok, []any{}); code != http.StatusForbidden {
		t.Fatalf("rejoin while AFK = %d", code)
	}
	if code, body := b.e.Do(http.MethodGet, "/v1/communities/"+b.cid.String()+"/afk", b.ownerTok, nil); code != http.StatusOK {
		t.Fatalf("snapshot = %d: %x", code, body)
	}
	if code, _ := b.e.Do(http.MethodDelete, "/v1/communities/"+b.cid.String()+"/afk", b.memberTok, nil); code != http.StatusNoContent {
		t.Fatalf("leave AFK = %d", code)
	}
}

func TestAFKAdmissionStartsTimerWithoutBrowserActivity(t *testing.T) {
	b := newMembershipCallEnvWithoutLoop(t)
	afk := id.New()
	if err := b.e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: afk, CommunityID: &b.cid, Kind: 1, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	if err := b.e.Repo.SetCommunityAFK(t.Context(), b.cid, store.CommunityAFK{ChannelID: &afk, TimeoutSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	b.calls.Admitted(t.Context(), b.room, b.memberDev, false)
	b.e.Clk.Advance(40 * time.Second)
	b.calls.Admitted(t.Context(), b.room, b.memberDev, true)
	b.e.Clk.Advance(21 * time.Second)
	b.calls.SweepAFK(t.Context())
	if !removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("suspended device kept media after admission timeout")
	}
}

func TestAFKActivityResetsOnlyItsOwnDeviceTimer(t *testing.T) {
	b := newMembershipCallEnvWithoutLoop(t)
	afk := id.New()
	if err := b.e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: afk, CommunityID: &b.cid, Kind: 1, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	if err := b.e.Repo.SetCommunityAFK(t.Context(), b.cid, store.CommunityAFK{ChannelID: &afk, TimeoutSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	path := "/v1/communities/" + b.cid.String() + "/afk/activity"
	if code, _ := b.e.Do(http.MethodPost, path, b.memberTok, []any{b.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	b.e.Clk.Advance(50 * time.Second)
	if code, _ := b.e.Do(http.MethodPost, path, b.memberTok, []any{b.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	b.e.Clk.Advance(20 * time.Second)
	if code, _ := b.e.Do(http.MethodPost, path, b.ownerTok, []any{b.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	b.calls.SweepAFK(t.Context())
	if removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("another device or early sweep moved the member")
	}
	b.e.Clk.Advance(41 * time.Second)
	b.calls.SweepAFK(t.Context())
	if !removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("member did not move after its own inactivity")
	}
}

func TestAFKManualMoveHasNoMediaAndSnapshotNamesOccupant(t *testing.T) {
	b := newMembershipCallEnvWithoutLoop(t)
	afk := id.New()
	if err := b.e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: afk, CommunityID: &b.cid, Kind: 1, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	if err := b.e.Repo.SetCommunityAFK(t.Context(), b.cid, store.CommunityAFK{ChannelID: &afk, TimeoutSeconds: 300}); err != nil {
		t.Fatal(err)
	}
	path := "/v1/communities/" + b.cid.String() + "/afk"
	if code, body := b.e.Do(http.MethodPost, path, b.memberTok, []any{b.ch[:]}); code != 204 {
		t.Fatalf("move = %d: %x", code, body)
	}
	if !removedDevice(b.stub, b.room, b.memberDev) {
		t.Fatal("media remained in source")
	}
	if code, _ := b.e.Do(http.MethodPost, "/v1/channels/"+afk.String()+"/calls", b.ownerTok, []any{}); code != 403 {
		t.Fatalf("AFK allowed media call: %d", code)
	}
	code, body := b.e.Do(http.MethodGet, path, b.ownerTok, nil)
	if code != 200 {
		t.Fatalf("snapshot = %d: %x", code, body)
	}
	var rows []cbor.RawMessage
	if err := cbor.Unmarshal(body, &rows); err != nil {
		t.Fatal(err)
	}
	var people [][]cbor.RawMessage
	if err := cbor.Unmarshal(rows[2], &people); err != nil {
		t.Fatal(err)
	}
	if len(people) != 1 {
		t.Fatalf("occupants = %d", len(people))
	}
	var device id.ID
	if err := cbor.Unmarshal(people[0][1], &device); err != nil || device != b.memberDev {
		t.Fatalf("occupant device = %s, %v", device, err)
	}
}

func TestAFKOccupancyClearsOnDisconnectAndMembershipRemoval(t *testing.T) {
	for _, kind := range []string{"disconnect", "membership"} {
		t.Run(kind, func(t *testing.T) {
			b := newMembershipCallEnvWithoutLoop(t)
			afk := id.New()
			if err := b.e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: afk, CommunityID: &b.cid, Kind: 1, Name: "AFK", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
				t.Fatal(err)
			}
			if err := b.e.Repo.SetCommunityAFK(t.Context(), b.cid, store.CommunityAFK{ChannelID: &afk, TimeoutSeconds: 300}); err != nil {
				t.Fatal(err)
			}
			path := "/v1/communities/" + b.cid.String() + "/afk"
			if code, body := b.e.Do(http.MethodPost, path, b.memberTok, []any{b.ch[:]}); code != 204 {
				t.Fatalf("move = %d: %x", code, body)
			}
			switch kind {
			case "disconnect":
				b.calls.WithAFKLive(afkDisconnected{}, nil)
			case "membership":
				if err := b.e.Repo.DeleteMember(t.Context(), b.cid, b.member); err != nil {
					t.Fatal(err)
				}
			}
			b.calls.SweepAFK(t.Context())
			code, body := b.e.Do(http.MethodGet, path, b.ownerTok, nil)
			if code != 200 {
				t.Fatalf("snapshot = %d: %x", code, body)
			}
			var rows []cbor.RawMessage
			if err := cbor.Unmarshal(body, &rows); err != nil {
				t.Fatal(err)
			}
			var people [][]cbor.RawMessage
			if err := cbor.Unmarshal(rows[2], &people); err != nil {
				t.Fatal(err)
			}
			if len(people) != 0 {
				t.Fatalf("stale occupants = %d", len(people))
			}
		})
	}
}
