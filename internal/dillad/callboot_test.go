package dillad_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// UP2 (calls survive an upgrade), through the production composition root: an API restart while the
// SFU keeps its rooms. A device barred while no process could cut it — the first process's SFU
// showed it in no room — and still in the SFU's room when the second process starts is cut by the
// boot reconcile before New returns, so before the first request is served; the retry loop's first
// tick is seconds away and nothing queued a cut.
func TestADeviceBarredWhileTheAPIWasDownIsCutBeforeServing(t *testing.T) {
	cfg, code := testConfigInvite(t)
	ctx := context.Background()
	first, err := dillad.New(ctx, dillad.Options{Config: cfg, Clock: clock.System(), Wasm: sharedRuntime(t), SFU: upstreamSFU{}})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	h := first.Handler()
	tok := accountToken(t, first, code)
	rec := call(t, h, http.MethodPost, "/v1/communities", tok, []any{"lounge", []byte("{}"), uint64(0), uint64(0)})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST /v1/communities = %d", rec.Code)
	}
	cid := idOf(t, decodeArray(t, rec)[0])
	rec = call(t, h, http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{uint64(1), uint64(1), uint64(2), nil, "voice", "", uint64(0), uint64(0)})
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST voice channel = %d %s", rec.Code, errorCode(rec))
	}
	ch := idOf(t, decodeArray(t, rec)[0])

	repo, now := first.Repo(), first.Now().Unix()
	callID, user, victim := id.New(), id.New(), id.New()
	room := callID.String() + "-1790000000-0badc0de"
	if err := repo.CreateUser(ctx, store.UserRow{ID: user, Username: "victim-" + user.String()[:8], Display: "victim",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := repo.CreateDevice(ctx, store.DeviceRow{ID: victim, UserID: user, DSKPub: make([]byte, 32),
		CredentialBlob: []byte{1}, LastSeen: now, Created: now}); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	if err := repo.PutVoiceSession(ctx, store.VoiceSessionRow{CallID: callID, ChannelID: ch, LivekitRoom: room, Started: now}); err != nil {
		t.Fatalf("PutVoiceSession: %v", err)
	}
	// Revoked straight in the store, as another process (`dillad admin`) or a write the dying API
	// never got to cut would leave it: nothing queued a cut.
	if err := repo.RevokeDevice(ctx, victim, now); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	if err := first.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown the first process: %v", err)
	}

	sfu := &roomSFU{room: room, parts: []string{victim.String()}}
	second, err := dillad.New(ctx, dillad.Options{Config: cfg, Clock: clock.System(), Wasm: sharedRuntime(t), SFU: sfu})
	if err != nil {
		t.Fatalf("dillad.New after the restart: %v", err)
	}
	defer second.Shutdown(ctx)
	if got := sfu.cutDevices(); !slices.Contains(got, victim.String()) {
		t.Fatalf("devices cut when New returned = %v, want the revoked device %s cut by the boot reconcile", got, victim)
	}
	if row, err := second.Repo().GetVoiceSession(ctx, callID); err != nil || row.Ended != nil {
		t.Fatalf("the call after the restart = %+v (%v), want it still live", row, err)
	}
}
