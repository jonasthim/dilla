package main

import (
	"errors"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// sessionLive reports whether the bearer token still names a session.
func sessionLive(t *testing.T, h *cliHarness, tok string) bool {
	t.Helper()
	_, err := h.Repo(t).GetSessionByHash(t.Context(), auth.TokenHash(tok), h.Now())
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("session: %v", err)
	}
	return err == nil
}

// `device revoke --all <user>` signs every device of the person out (R1): each device is revoked,
// each session is gone, the verb names what the person loses, and another person is untouched.
func TestDeviceRevokeAllRevokesEveryDeviceOfTheUser(t *testing.T) {
	h := newCLIHarness(t)
	alice := h.SeedUser(t, "alice")
	bob := h.SeedUser(t, "bob")
	aliceTok := []string{h.SeedSession(t, alice), h.SeedSession(t, alice)}
	bobTok := h.SeedSession(t, bob)
	aliceDevices := []id.ID{}
	for _, tok := range aliceTok {
		s, err := h.Repo(t).GetSessionByHash(t.Context(), auth.TokenHash(tok), h.Now())
		if err != nil {
			t.Fatalf("session: %v", err)
		}
		aliceDevices = append(aliceDevices, s.DeviceID)
	}

	code, out := h.Run(t, "admin", "device", "revoke", "--all", "alice", "--config="+h.ConfigPath)
	if code != 0 {
		t.Fatalf("revoke --all: %d %s", code, out)
	}
	if !strings.Contains(out, "2 devices") || !strings.Contains(out, "history") {
		t.Errorf("the output must say how many devices and that history is lost unless another device holds it: %s", out)
	}
	for _, d := range aliceDevices {
		row, err := h.Repo(t).GetDevice(t.Context(), d)
		if err != nil || row.RevokedAt == nil {
			t.Errorf("device %s was not revoked: %+v %v", d, row, err)
		}
	}
	for _, tok := range aliceTok {
		if sessionLive(t, h, tok) {
			t.Error("one of alice's sessions survived")
		}
	}
	if !sessionLive(t, h, bobTok) {
		t.Error("bob's session was deleted")
	}
}

// The username and the id name the same person; the id is accepted as the positional argument too.
func TestDeviceRevokeAllAcceptsAnIDAsWellAsAUsername(t *testing.T) {
	h := newCLIHarness(t)
	alice := h.SeedUser(t, "alice")
	tok := h.SeedSession(t, alice)
	if code, out := h.Run(t, "admin", "device", "revoke", "--all", alice.String(), "--config="+h.ConfigPath); code != 0 {
		t.Fatalf("revoke --all <id>: %d %s", code, out)
	}
	if sessionLive(t, h, tok) {
		t.Error("the session survived a revoke by id")
	}
}

func TestDeviceRevokeAllUsageAndUnknownUser(t *testing.T) {
	h := newCLIHarness(t)
	alice := h.SeedUser(t, "alice")
	tok := h.SeedSession(t, alice)

	cases := []struct {
		name string
		args []string
		want exit.Code
	}{
		{"no user", []string{"--all"}, exit.Usage},
		{"with --id", []string{"--all", "alice", "--id=" + id.New().String()}, exit.Usage},
		{"unknown user", []string{"--all", "carol"}, exit.Data},
	}
	for _, c := range cases {
		args := append([]string{"admin", "device", "revoke"}, c.args...)
		code, out := h.Run(t, append(args, "--config="+h.ConfigPath)...)
		if exit.Code(code) != c.want {
			t.Errorf("%s: exit %d, want %d: %s", c.name, code, c.want, out)
		}
	}
	if !sessionLive(t, h, tok) {
		t.Error("a refused revoke still signed alice out")
	}
}
