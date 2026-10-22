package api

import (
	"math"
	"net/http"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

const selfRoleAllowedBits = PermViewChannel | PermSendMessages | PermAttachFiles |
	PermAddReactions | PermReadHistory | PermConnect | PermSpeak | PermVideo | PermScreenShare

type selfRolePolicyRequest struct {
	_         struct{} `cbor:",toarray"`
	RequestID id.ID
	Roles     []id.ID
}

type selfRoleSelectionRequest struct {
	_         struct{} `cbor:",toarray"`
	RequestID id.ID
	Enabled   uint8
}

type rolePanelOptionRequest struct {
	_     struct{} `cbor:",toarray"`
	Emoji string
	Role  id.ID
}

type rolePanelRegistrationRequest struct {
	_          struct{} `cbor:",toarray"`
	RequestID  id.ID
	ChannelID  id.ID
	MessageSeq uint64
	Options    []rolePanelOptionRequest
}

func (h *Roles) RegisterSelfRoles(mux *server.Mux) {
	mux.HandleFunc("GET /v1/communities/{id}/self-roles", h.listSelfRoles)
	mux.HandleFunc("PUT /v1/communities/{id}/self-roles/policy", h.configureSelfRoles)
	mux.HandleFunc("PUT /v1/communities/{id}/self-roles/{role_id}", h.selectSelfRole)
	mux.HandleFunc("PUT /v1/communities/{id}/role-panels", h.registerRolePanel)
}

func (h *Roles) registerRolePanel(w http.ResponseWriter, r *http.Request) {
	var req rolePanelRegistrationRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		refuseCBOR(w, r, err)
		return
	}
	cid, actor, err := h.selfRoleCommunity(r, h.repo)
	if err != nil {
		h.fail(w, r, "register role panel", err)
		return
	}
	if req.RequestID.IsZero() || req.ChannelID.IsZero() || req.MessageSeq == 0 || req.MessageSeq > math.MaxInt64 || len(req.Options) == 0 || len(req.Options) > 100 {
		h.fail(w, r, "register role panel", server.Errorf(server.CodeInvalidRequest, "invalid role panel"))
		return
	}
	seen := map[string]bool{}
	for _, option := range req.Options {
		if option.Emoji == "" || len(option.Emoji) > 32 || !utf8.ValidString(option.Emoji) || option.Role.IsZero() || seen[option.Emoji] {
			h.fail(w, r, "register role panel", server.Errorf(server.CodeInvalidRequest, "invalid or duplicate emoji mapping"))
			return
		}
		seen[option.Emoji] = true
	}
	var panel store.RolePanelRow
	options := make([]store.RolePanelOptionRow, len(req.Options))
	for i, option := range req.Options {
		options[i] = store.RolePanelOptionRow{Emoji: option.Emoji, RoleID: option.Role}
	}
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
		channel, err := tx.GetChannel(r.Context(), req.ChannelID)
		if err != nil || channel.CommunityID == nil || *channel.CommunityID != cid || channel.Kind != ChannelText || channel.Mode != ModeReadable || channel.DeletedAt != nil {
			return server.Errorf(server.CodeNotFound, "channel not found")
		}
		installation, err := tx.GetActiveBotInstallationByCommunity(r.Context(), cid)
		if err != nil || installation.State != store.BotInstallationReady || installation.UserID == nil || installation.DeviceID == nil {
			return server.Errorf(server.CodeForbidden, "ready community bot required")
		}
		botUser, err := tx.GetUser(r.Context(), *installation.UserID)
		if err != nil || botUser.Kind != 1 {
			return server.Errorf(server.CodeForbidden, "ready community bot required")
		}
		if _, err := tx.GetMember(r.Context(), cid, botUser.ID); err != nil {
			return server.Errorf(server.CodeForbidden, "bot must be a community member")
		}
		messages, err := tx.ListReadableMessages(r.Context(), req.ChannelID, req.MessageSeq, 1)
		if err != nil {
			return err
		}
		if len(messages) != 1 || messages[0].Seq != req.MessageSeq || messages[0].Sender != botUser.ID || messages[0].UploaderDevice != *installation.DeviceID || messages[0].Deleted != nil {
			return server.Errorf(server.CodeForbidden, "panel must reference a live message authored by the installed bot")
		}
		policy, err := tx.ListSelfRolePolicy(r.Context(), cid)
		if err != nil {
			return err
		}
		approved := make(map[id.ID]store.SelfRolePolicyRow, len(policy))
		for _, row := range policy {
			approved[row.RoleID] = row
		}
		for _, option := range req.Options {
			if err := h.selfRoleCandidate(r, tx, cid, actor.UserID, option.Role, actorBits, snap); err != nil {
				return err
			}
			row, ok := approved[option.Role]
			if !ok {
				return server.Errorf(server.CodeForbidden, "panel role is not approved for self-service")
			}
			approverSnap, err := LoadSnapshot(r.Context(), tx, cid, row.ApprovedBy, nil)
			if err != nil {
				return server.Errorf(server.CodeForbidden, "self-service approval is no longer valid")
			}
			approverBits := approverSnap.Resolve(row.ApprovedBy)
			if !approverBits.Has(PermManageRoles) || h.selfRoleCandidate(r, tx, cid, row.ApprovedBy, option.Role, approverBits, approverSnap) != nil {
				return server.Errorf(server.CodeForbidden, "panel role is no longer within the approved policy")
			}
		}
		panel = store.RolePanelRow{CommunityID: cid, ChannelID: req.ChannelID, MessageSeq: req.MessageSeq, AuthorID: botUser.ID, InstallationID: installation.ID}
		return tx.SetRolePanel(r.Context(), panel, options)
	})
	if err != nil {
		h.fail(w, r, "register role panel", err)
		return
	}
	_ = server.WriteCBOR(w, http.StatusOK, []any{req.RequestID, uint64(len(options))})
}

func (h *Roles) selfRoleCommunity(r *http.Request, repo store.Repository) (id.ID, auth.Session, error) {
	s, ok := session(r)
	if !ok {
		return id.ID{}, auth.Session{}, server.Errorf(server.CodeUnauthenticated, "")
	}
	u, err := repo.GetUser(r.Context(), s.UserID)
	if err != nil {
		return id.ID{}, auth.Session{}, notFound(err)
	}
	if u.Kind != kindHuman {
		return id.ID{}, auth.Session{}, server.Errorf(server.CodeForbidden, "human session required")
	}
	cid, err := server.PathID(r, "id")
	if err != nil {
		return id.ID{}, auth.Session{}, err
	}
	if _, err := repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		return id.ID{}, auth.Session{}, notFound(err)
	}
	if _, err := repo.GetCommunity(r.Context(), cid); err != nil {
		return id.ID{}, auth.Session{}, notFound(err)
	}
	return cid, s, nil
}

func (h *Roles) selfRoleCandidate(ctx *http.Request, repo store.Repository, cid, actor, roleID id.ID, have Bits, snap Snapshot) error {
	role, err := repo.GetRole(ctx.Context(), roleID)
	if err != nil || role.CommunityID != cid {
		return server.Errorf(server.CodeInvalidRequest, "role is unavailable for self-service")
	}
	if role.Position == 0 || Bits(role.Allow)&^selfRoleAllowedBits != 0 || Bits(role.Deny)&^selfRoleAllowedBits != 0 || Bits(role.Allow)&^have != 0 {
		return server.Errorf(server.CodeForbidden, "role exceeds self-service permission limits")
	}
	// A role must remain below the actor's highest held role. Owners can configure any
	// otherwise-safe role; an ordinary manager cannot approve a peer or superior role.
	if actor != snap.Owner {
		var highest uint64
		for _, held := range snap.Roles {
			if (snap.Held[held.ID] || held.ID == snap.Everyone) && held.Position > highest {
				highest = held.Position
			}
		}
		if role.Position >= highest {
			return server.Errorf(server.CodeForbidden, "role must be below your highest role")
		}
	}
	if inst, err := repo.GetActiveBotInstallationByCommunity(ctx.Context(), cid); err == nil && inst.RoleID != nil && *inst.RoleID == roleID {
		return server.Errorf(server.CodeForbidden, "bot-managed role cannot be self-assigned")
	}
	return nil
}

func (h *Roles) listSelfRoles(w http.ResponseWriter, r *http.Request) {
	cid, s, err := h.selfRoleCommunity(r, h.repo)
	if err != nil {
		h.fail(w, r, "list self roles", err)
		return
	}
	policy, err := h.repo.ListSelfRolePolicy(r.Context(), cid)
	if err != nil {
		h.fail(w, r, "list self roles", err)
		return
	}
	rows := make([][]any, 0, len(policy))
	for _, p := range policy {
		role, e := h.repo.GetRole(r.Context(), p.RoleID)
		if e != nil {
			continue
		}
		enabled, e := h.repo.HasMemberRoleGrant(r.Context(), cid, s.UserID, p.RoleID, store.RoleGrantSelf)
		if e != nil {
			h.fail(w, r, "list self roles", e)
			return
		}
		var selected uint64
		if enabled {
			selected = 1
		}
		rows = append(rows, []any{p.RoleID, role.Name, uint64(role.Position), selected})
	}
	_ = server.EncodeBody(w, http.StatusOK, rows)
}

func (h *Roles) configureSelfRoles(w http.ResponseWriter, r *http.Request) {
	var req selfRolePolicyRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		refuseCBOR(w, r, err)
		return
	}
	cid, s, err := h.selfRoleCommunity(r, h.repo)
	if err != nil {
		h.fail(w, r, "configure self roles", err)
		return
	}
	if len(req.Roles) > 250 {
		h.fail(w, r, "configure self roles", server.Errorf(server.CodeInvalidRequest, "at most 250 roles"))
		return
	}
	now := h.clk.Now().Unix()
	revoked := map[id.ID]bool{}
	err = h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.LockCommunity(r.Context(), cid); err != nil {
			return notFound(err)
		}
		if _, _, err := h.selfRoleCommunity(r, tx); err != nil {
			return err
		}
		snap, err := LoadSnapshot(r.Context(), tx, cid, s.UserID, nil)
		if err != nil {
			return notFound(err)
		}
		have := snap.Resolve(s.UserID)
		if !have.Has(PermManageRoles) {
			return server.Errorf(server.CodeForbidden, "manage_roles required")
		}
		seen := map[id.ID]bool{}
		for _, rid := range req.Roles {
			if seen[rid] {
				return server.Errorf(server.CodeInvalidRequest, "duplicate role")
			}
			seen[rid] = true
			if err := h.selfRoleCandidate(r, tx, cid, s.UserID, rid, have, snap); err != nil {
				return err
			}
		}
		previous, err := tx.ListSelfRolePolicy(r.Context(), cid)
		if err != nil {
			return err
		}
		for _, row := range previous {
			if seen[row.RoleID] {
				continue
			}
			users, err := tx.ListSelfRoleGrantUsers(r.Context(), cid, row.RoleID)
			if err != nil {
				return err
			}
			for _, user := range users {
				if err := tx.RemoveMemberRoleGrant(r.Context(), cid, user, row.RoleID, store.RoleGrantSelf); err != nil {
					return err
				}
				revoked[user] = true
			}
		}
		return tx.SetSelfRolePolicy(r.Context(), cid, s.UserID, req.Roles, now)
	})
	if err != nil {
		h.fail(w, r, "configure self roles", err)
		return
	}
	for user := range revoked {
		if err := syncChannelEligibility(afterCommit(r), h.repo, h.dsvc, cid, user, now); err != nil {
			h.log.ErrorContext(r.Context(), "sync channel eligibility after self role policy", "community", cid, "user", user, "err", err)
		}
		h.syncCallGrants(afterCommit(r), cid, &user, nil)
	}
	if len(revoked) > 0 {
		h.notify.Changed(afterCommit(r), cid)
	}
	_ = server.WriteCBOR(w, http.StatusOK, []any{req.RequestID, uint64(len(req.Roles))})
}

func (h *Roles) selectSelfRole(w http.ResponseWriter, r *http.Request) {
	var req selfRoleSelectionRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		refuseCBOR(w, r, err)
		return
	}
	cid, s, err := h.selfRoleCommunity(r, h.repo)
	if err != nil {
		h.fail(w, r, "select self role", err)
		return
	}
	rid, err := server.PathID(r, "role_id")
	if err != nil {
		h.fail(w, r, "select self role", err)
		return
	}
	if req.Enabled > 1 {
		h.fail(w, r, "select self role", server.Errorf(server.CodeInvalidRequest, "enabled must be 0 or 1"))
		return
	}
	var changed bool
	err = h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.LockCommunity(r.Context(), cid); err != nil {
			return notFound(err)
		}
		if _, _, err := h.selfRoleCommunity(r, tx); err != nil {
			return err
		}
		policy, err := tx.ListSelfRolePolicy(r.Context(), cid)
		if err != nil {
			return err
		}
		var approval *store.SelfRolePolicyRow
		for i := range policy {
			if policy[i].RoleID == rid {
				approval = &policy[i]
				break
			}
		}
		if approval == nil {
			return server.Errorf(server.CodeForbidden, "role is not currently approved for self-service")
		}
		approverSnap, err := LoadSnapshot(r.Context(), tx, cid, approval.ApprovedBy, nil)
		if err != nil {
			return server.Errorf(server.CodeForbidden, "self-service approval is no longer valid")
		}
		approverBits := approverSnap.Resolve(approval.ApprovedBy)
		if !approverBits.Has(PermManageRoles) {
			return server.Errorf(server.CodeForbidden, "self-service approval is no longer valid")
		}
		if err := h.selfRoleCandidate(r, tx, cid, approval.ApprovedBy, rid, approverBits, approverSnap); err != nil {
			return server.Errorf(server.CodeForbidden, "role is no longer within the approved policy")
		}
		hasSelf, err := tx.HasMemberRoleGrant(r.Context(), cid, s.UserID, rid, store.RoleGrantSelf)
		if err != nil {
			return err
		}
		if req.Enabled == 1 && !hasSelf {
			err = tx.AddMemberRoleGrant(r.Context(), cid, s.UserID, rid, store.RoleGrantSelf)
		} else if req.Enabled == 0 && hasSelf {
			err = tx.RemoveMemberRoleGrant(r.Context(), cid, s.UserID, rid, store.RoleGrantSelf)
		}
		if err == nil && (req.Enabled == 1) != hasSelf {
			changed = true
		}
		return err
	})
	if err != nil {
		h.fail(w, r, "select self role", err)
		return
	}
	if changed {
		if err := syncChannelEligibility(afterCommit(r), h.repo, h.dsvc, cid, s.UserID, h.clk.Now().Unix()); err != nil {
			h.log.ErrorContext(r.Context(), "sync channel eligibility after self role", "community", cid, "user", s.UserID, "err", err)
		}
		h.syncCallGrants(afterCommit(r), cid, &s.UserID, nil)
		h.notify.Changed(afterCommit(r), cid)
	}
	w.WriteHeader(http.StatusNoContent)
}
