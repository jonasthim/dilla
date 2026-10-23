package client

import (
	"context"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
)

func TestSessionMusicDJPolicyUsesInstallationBoundNoStoreRead(t *testing.T) {
	community, installation, role := testID(31), testID(32), testID(33)
	var gotPath, gotAuth string
	requests := 0
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		requests++
		w.Header().Set("Content-Type", "application/cbor")
		body, err := cborx.Marshal([]any{community, installation, uint64(1), []any{role}})
		if err != nil {
			t.Error(err)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}, 0)
	s, err := c.Session("bot-session")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.MusicDJRolePolicy(context.Background(), installation)
	if err != nil || got.CommunityID != community || got.InstallationID != installation || got.Capabilities != 1 || len(got.RoleIDs) != 1 || got.RoleIDs[0] != role {
		t.Fatalf("DJ policy = %#v, %v", got, err)
	}
	if gotPath != "/v1/bot-runtime/installations/"+installation.String()+"/music/dj-roles" || gotAuth != "Bearer bot-session" {
		t.Fatalf("request = %q, %q", gotPath, gotAuth)
	}
	if _, err := s.MusicDJRolePolicy(context.Background(), installation); err != nil || requests != 2 {
		t.Fatalf("second policy read error=%v requests=%d, want a fresh second request", err, requests)
	}
}

func TestSessionMusicDJPolicyRejectsCapabilityRevocationAndMalformedBindings(t *testing.T) {
	installation := testID(32)
	for _, tc := range []struct {
		name string
		body any
	}{
		{name: "capability revoked", body: []any{testID(31), installation, uint64(0), []any{}}},
		{name: "installation mismatch", body: []any{testID(31), testID(34), uint64(1), []any{}}},
		{name: "duplicate roles", body: []any{testID(31), installation, uint64(1), []any{testID(33), testID(33)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/instance" {
					reply(w, http.StatusOK, discovery(testID(99)))
					return
				}
				reply(w, http.StatusOK, tc.body)
			}, 0)
			s, _ := c.Session("bot-session")
			if _, err := s.MusicDJRolePolicy(context.Background(), installation); err == nil {
				t.Fatal("policy read accepted revoked or malformed authority")
			}
		})
	}
}
