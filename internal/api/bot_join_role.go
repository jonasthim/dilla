package api

import (
	"net/http"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

type botJoinRoleRequest struct {
	_         struct{} `cbor:",toarray"`
	RequestID id.ID
	RoleID    id.ID // zero clears the approved role
}

// configureBotJoinRole stores an approval only. Runtime assignment remains
// intentionally unwired until the endpoint can bind it to a live membership
// episode and an idempotent operation receipt.
func (h *Roles) configureBotJoinRole(w http.ResponseWriter, r *http.Request) {
	var req botJoinRoleRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		refuseCBOR(w, r, err)
		return
	}
	cid, actor, err := h.selfRoleCommunity(r, h.repo)
	if err != nil {
		h.fail(w, r, "configure bot join role", err)
		return
	}
	if req.RequestID.IsZero() {
		h.fail(w, r, "configure bot join role", server.Errorf(server.CodeInvalidRequest, "request id required"))
		return
	}
	var installationID id.ID
	err = h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.LockCommunity(r.Context(), cid); err != nil {
			return notFound(err)
		}
		if _, _, err := h.selfRoleCommunity(r, tx); err != nil {
			return err
		}
		snap, err := LoadSnapshot(r.Context(), tx, cid, actor.UserID, nil)
		if err != nil {
			return notFound(err)
		}
		actorBits := snap.Resolve(actor.UserID)
		if !actorBits.Has(PermManageRoles) {
			return server.Errorf(server.CodeForbidden, "manage_roles required")
		}
		installation, err := tx.GetActiveBotInstallationByCommunity(r.Context(), cid)
		if err != nil || installation.State != store.BotInstallationReady || installation.UserID == nil || installation.DeviceID == nil {
			return server.Errorf(server.CodeForbidden, "ready community bot required")
		}
		bot, err := tx.GetUser(r.Context(), *installation.UserID)
		if err != nil || bot.Kind != 1 {
			return server.Errorf(server.CodeForbidden, "ready community bot required")
		}
		if _, err := tx.GetMember(r.Context(), cid, bot.ID); err != nil {
			return server.Errorf(server.CodeForbidden, "installed bot must be a community member")
		}
		if req.RoleID.IsZero() {
			if _, err := tx.(store.BotJoinRolePolicy).GetBotJoinRolePolicy(r.Context(), installation.ID); err != nil && err != store.ErrNotFound {
				return err
			}
		} else {
			if err := h.selfRoleCandidate(r, tx, cid, actor.UserID, req.RoleID, actorBits, snap); err != nil {
				return err
			}
		}
		installationID = installation.ID
		return tx.(store.BotJoinRolePolicy).SetBotJoinRolePolicy(r.Context(), installation.ID, req.RoleID, actor.UserID, h.clk.Now().Unix())
	})
	if err != nil {
		h.fail(w, r, "configure bot join role", err)
		return
	}
	_ = server.WriteCBOR(w, http.StatusOK, []any{req.RequestID, installationID})
}
