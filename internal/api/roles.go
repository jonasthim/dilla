package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// moderatorBits are the permissions that make a role a moderation role for the
// purposes of communities.require_mod_2fa.
const moderatorBits = PermManageMessages | PermKickMembers | PermBanMembers |
	PermManageChannels | PermManageRoles | PermManageCommunity | PermAdministrator

// Roles serves the role routes of interfaces.md §5.2. Task 1 ships only the
// grant route, because require_mod_2fa gates it; task 3 adds the other six
// once the permission resolver exists.
type Roles struct {
	repo store.Repository
	clk  clock.Clock
	rpID string // auth.webauthn.rp_id, §6.4 — see requireSecondFactor
	log  *slog.Logger
}

func NewRoles(repo store.Repository, clk clock.Clock, rpID string, log *slog.Logger) *Roles {
	return &Roles{repo: repo, clk: clk, rpID: rpID, log: log}
}

// Register registers only the grant route at task 1. Task 3 replaces this body
// with the full seven-route table once the resolver exists.
func (h *Roles) Register(mux *server.Mux) {
	mux.HandleFunc("PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}", h.grant)
}

// requireSecondFactor returns nil when the user holds a confirmed TOTP secret or
// at least one passkey registered for rpID. It is called before any grant of a
// role carrying moderatorBits in a community whose require_mod_2fa is 1.
//
// rpID is threaded rather than defaulted to "": §4.3 indexes
// webauthn_credentials on (rp_id, user_id), so ListWebauthnCredentials with an
// empty rp_id matches nothing and the passkey branch could never succeed.
func requireSecondFactor(ctx context.Context, repo store.Repository, userID id.ID, rpID string) error {
	t, err := repo.GetTOTP(ctx, userID)
	switch {
	case err == nil && t.ConfirmedAt != nil:
		return nil
	case err != nil && !errors.Is(err, store.ErrNotFound):
		return err
	}
	creds, err := repo.ListWebauthnCredentials(ctx, userID, rpID)
	if err != nil {
		return err
	}
	if len(creds) > 0 {
		return nil
	}
	return server.Errorf(server.CodeForbidden,
		"this community requires a second factor before a moderator role is granted")
}

// grant is PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}: 204 with
// an empty body. At task 1 only the owner may grant; task 3 replaces the owner
// check with the resolver's PermManageRoles and the position bound.
func (h *Roles) grant(w http.ResponseWriter, r *http.Request) {
	s, err := enrolledSession(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	cid, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	target, err := server.PathID(r, "user_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	roleID, err := server.PathID(r, "role_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	com, err := h.repo.GetCommunity(r.Context(), cid)
	if err != nil {
		h.fail(w, r, notFound(err))
		return
	}
	if _, err := h.repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		// A non-member must not learn that the community exists.
		h.fail(w, r, notFound(err))
		return
	}
	if com.Owner != s.UserID { // task 3 replaces this with snap.Resolve(...).Has(PermManageRoles)
		server.WriteError(w, server.Errorf(server.CodeForbidden, "manage roles"))
		return
	}
	role, err := h.repo.GetRole(r.Context(), roleID)
	if err != nil {
		h.fail(w, r, notFound(err))
		return
	}
	if role.CommunityID != cid {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such role"))
		return
	}
	if com.RequireMod2FA == 1 && Bits(role.Allow)&moderatorBits != 0 {
		if err := requireSecondFactor(r.Context(), h.repo, target, h.rpID); err != nil {
			h.fail(w, r, err)
			return
		}
	}
	if _, err := h.repo.GetMember(r.Context(), cid, target); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			err = server.Errorf(server.CodeNotFound, "not a member")
		}
		h.fail(w, r, err)
		return
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.PutMemberRole(r.Context(), cid, target, roleID); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "role.grant", Target: target.String(),
			Detail: roleID.String(), At: now,
		})
	}); err != nil {
		h.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// fail writes err as the client's refusal, logging anything that is not a
// *server.Error: those reach the client as an empty E_INTERNAL.
func (h *Roles) fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *server.Error
	if !errors.As(err, &se) {
		h.log.ErrorContext(r.Context(), "role grant", "err", err)
	}
	server.WriteError(w, err)
}
