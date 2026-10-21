package gateway

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type botSweepAuth struct {
	Authenticator
	revoked bool
	checks  int
}

func (a *botSweepAuth) ValidateSessionHash(context.Context, []byte) error {
	a.checks++
	if a.revoked {
		return store.ErrNotFound
	}
	return nil
}

type botSweepStore struct {
	Store
	row store.SessionRow
}

func (s botSweepStore) GetSessionByHash(context.Context, []byte, int64) (store.SessionRow, error) {
	if s.row.TokenHash == nil {
		return store.SessionRow{}, store.ErrNotFound
	}
	return s.row, nil
}

func TestGatewayRequiresBoundJoiningOrReadyBotAtWireThree(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state uint8
		wire  uint64
		allow bool
	}{
		{name: "enrolling", state: store.BotInstallationEnrolling, wire: 3},
		{name: "joining wire two", state: store.BotInstallationJoining, wire: 2},
		{name: "joining wire three", state: store.BotInstallationJoining, wire: 3, allow: true},
		{name: "ready wire three", state: store.BotInstallationReady, wire: 3, allow: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			device := id.New()
			bot := auth.BotSessionBinding{InstallationID: id.New(), CommunityID: id.New(), State: tc.state}
			session := auth.Session{Scope: auth.ScopeEnrolled, WireVersion: tc.wire, Bot: &bot}
			token := scopedSession(h, device, session)
			got, err := h.gw.identify(context.Background(), token)
			if tc.allow {
				if err != nil || got.Bot == nil {
					t.Fatalf("identify = %+v, %v; want bound bot", got, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("identify accepted phase=%d wire=%d", tc.state, tc.wire)
			}
		})
	}
}

func TestGatewayHeartbeatSweepCutsBotWhenRuntimeIsRevoked(t *testing.T) {
	h := newHarness(t)
	device := id.New()
	sess := session(device)
	sess.TokenHash = make([]byte, 32)
	sess.TokenHash[0] = 1
	c, err := h.gw.register(context.Background(), sess, newRecordingSink(16, false))
	if err != nil {
		t.Fatal(err)
	}
	c.isBot = true
	storeStub := botSweepStore{Store: h, row: store.SessionRow{TokenHash: c.tokenHash, UserID: c.userID, DeviceID: c.deviceID}}
	authStub := &botSweepAuth{Authenticator: h}
	h.gw.opts.Store = storeStub
	h.gw.opts.Auth = authStub
	h.gw.sweepSessions(context.Background())
	if c.noResume {
		t.Fatal("live bot session was closed before revocation")
	}
	authStub.revoked = true
	h.gw.sweepSessions(context.Background())
	if !c.noResume {
		t.Fatalf("revoked bot connection remained resumable (validator calls=%d)", authStub.checks)
	}
}
