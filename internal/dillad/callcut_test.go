package dillad_test

import (
	"context"
	"net/http"
	"slices"
	"sync"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// roomSFU is upstreamSFU holding one room with the given participants, recording every device
// RemoveParticipants is asked to cut.
type roomSFU struct {
	upstreamSFU
	room  string
	parts []string
	mu    sync.Mutex
	cut   []string
}

func (s *roomSFU) Rooms(context.Context) ([]string, error) { return []string{s.room}, nil }
func (s *roomSFU) Participants(_ context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	if room != s.room {
		return nil, nil
	}
	out := make([]*livekit.ParticipantInfo, 0, len(s.parts))
	for _, p := range s.parts {
		out = append(out, &livekit.ParticipantInfo{Identity: p})
	}
	return out, nil
}
func (s *roomSFU) RemoveParticipants(_ context.Context, _ string, device id.ID) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cut = append(s.cut, device.String())
	return nil
}
func (s *roomSFU) cutDevices() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.cut...)
}

// The critical finding's immediacy half, through the production composition root: revoking a device
// (Sessions.RevokeDevice, the OnRevoke hook) cuts it from the live call room the SFU holds it in at
// once — no room sweep, no call event — and leaves the other participant alone.
func TestRevokingADeviceCutsItFromLiveCallsAtOnce(t *testing.T) {
	cfg, code := testConfigInvite(t)
	callID := id.New()
	room := callID.String() + "-1790000000"
	victim, bystander := id.New(), id.New()
	sfu := &roomSFU{room: room, parts: []string{victim.String(), bystander.String()}}
	srv, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clock.System(), Wasm: sharedRuntime(t), SFU: sfu,
	})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	defer srv.Shutdown(context.Background())
	h := srv.Handler()
	tok := accountToken(t, h, code)
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

	repo, ctx := srv.Repo(), t.Context()
	now := srv.Now().Unix()
	user := id.New()
	if err := repo.CreateUser(ctx, store.UserRow{ID: user, Username: "victim-" + user.String()[:8], Display: "victim",
		UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	for _, d := range []id.ID{victim, bystander} {
		if err := repo.CreateDevice(ctx, store.DeviceRow{ID: d, UserID: user, DSKPub: make([]byte, 32),
			CredentialBlob: []byte{1}, LastSeen: now, Created: now}); err != nil {
			t.Fatalf("CreateDevice: %v", err)
		}
	}
	if err := repo.PutVoiceSession(ctx, store.VoiceSessionRow{CallID: callID, ChannelID: ch, LivekitRoom: room, Started: now}); err != nil {
		t.Fatalf("PutVoiceSession: %v", err)
	}

	if err := srv.Sessions().RevokeDevice(ctx, victim); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	got := sfu.cutDevices()
	if !slices.Contains(got, victim.String()) {
		t.Fatalf("devices cut on revocation = %v, want the revoked device %s at once", got, victim)
	}
	if slices.Contains(got, bystander.String()) {
		t.Fatalf("the revocation cut the bystander too: %v", got)
	}
}
