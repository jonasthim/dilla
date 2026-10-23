package api_test

import (
	"log/slog"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

func TestHumanWarningRequiresModeratorAndReturnsAcceptedAction(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewMemberWarnings(e.Repo, e.Clk).Register(e.Mux)
	target, targetTok := e.NewUser("warning-target")
	joinCommunity(t, e, cid, targetTok)
	path := "/v1/communities/" + cid.String() + "/members/" + target.String() + "/warning"
	requestID := id.New()
	if status, _ := e.Do(http.MethodPost, path, targetTok, []any{requestID}); status != http.StatusForbidden {
		t.Fatalf("member warning POST = %d, want forbidden", status)
	}
	status, body := e.Do(http.MethodPost, path, ownerTok, []any{requestID})
	if status != http.StatusOK {
		t.Fatalf("owner warning POST = %d (%x), want 200", status, body)
	}
	var receipt []any
	if err := cborx.Unmarshal(body, &receipt); err != nil || len(receipt) != 4 {
		t.Fatal(err)
	}
	request, rok := receipt[0].([]byte)
	action, aok := receipt[1].([]byte)
	revision, vok := receipt[2].(uint64)
	accepted, tok := receipt[3].(uint64)
	if !rok || !aok || !vok || !tok || string(request) != string(requestID[:]) || len(action) != 16 || revision == 0 || accepted == 0 {
		t.Fatalf("warning receipt = %#v", receipt)
	}
	page, err := e.Repo.ListBotStructuralEvents(t.Context(), cid, 0, 10)
	if err != nil || len(page.Events) == 0 {
		t.Fatalf("warning events = %d, %v", len(page.Events), err)
	}
	var actionID id.ID
	copy(actionID[:], action)
	var event protocol.Event
	for _, candidate := range page.Events {
		if candidate.ID == actionID {
			event = candidate
			break
		}
	}
	if event.Kind != protocol.EventModeration || event.ID != actionID || event.Sequence != revision || len(event.Data) != 9 {
		t.Fatalf("warning event = %+v", event)
	}
	rows, err := e.Repo.ListAudit(t.Context(), 0, 20)
	if err != nil || len(rows) == 0 || rows[0].Action != "member.warn" || rows[0].Target != target.String() {
		t.Fatalf("warning audit = %+v, %v", rows, err)
	}
}

func TestHumanWarningCannotTargetEqualOrHigherRole(t *testing.T) {
	e, cid, ownerTok := channelEnv(t)
	api.NewMemberWarnings(e.Repo, e.Clk).Register(e.Mux)
	api.NewRoles(e.Repo, e.Clk, "dilla.example", slog.New(slog.DiscardHandler)).Register(e.Mux)
	moderator, modTok := e.NewUser("warning-mod")
	joinCommunity(t, e, cid, modTok)
	target, targetTok := e.NewUser("warning-peer")
	joinCommunity(t, e, cid, targetTok)
	role := createRole(t, e, cid, ownerTok, "peer-moderators", 5, api.PermModerateMembers)
	grant(t, e, cid, ownerTok, moderator, role, http.StatusNoContent)
	grant(t, e, cid, ownerTok, target, role, http.StatusNoContent)
	path := "/v1/communities/" + cid.String() + "/members/" + target.String() + "/warning"
	if status, _ := e.Do(http.MethodPost, path, modTok, []any{id.New()}); status != http.StatusForbidden {
		t.Fatalf("equal rank warning POST = %d, want forbidden", status)
	}
}
