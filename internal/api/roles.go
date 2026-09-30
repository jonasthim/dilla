package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// moderatorBits are the permissions that make a role a moderation role for the
// purposes of communities.require_mod_2fa.
const moderatorBits = PermManageMessages | PermKickMembers | PermBanMembers |
	PermManageChannels | PermManageRoles | PermManageCommunity | PermAdministrator

// Role field bounds (protocol/09 § Roles).
const (
	maxRoleNameBytes = 100
	maxRoleColor     = 0xFFFFFF
	// maxRolePosition keeps a client's uint64 inside the signed column on both
	// engines, as maxChannelPosition does for channels.
	maxRolePosition = 1<<31 - 1
	// maxRolesPerCommunity bounds the resolver's work per request: every
	// permission decision reads every role of the community.
	maxRolesPerCommunity = 250
)

// Overwrite target kinds, channel_overwrites.target_kind.
const (
	overwriteRole uint8 = 0
	overwriteUser uint8 = 1
)

// Roles serves the role and overwrite routes of interfaces.md §5.2: create,
// patch and delete a role, grant and revoke one, and put and delete a channel
// overwrite. Every permission decision goes through the resolver (perm.go).
type Roles struct {
	repo store.Repository
	clk  clock.Clock
	rpID string // auth.webauthn.rp_id, §6.4 — see requireSecondFactor
	log  *slog.Logger
	res  *Resolver
}

func NewRoles(repo store.Repository, clk clock.Clock, rpID string, log *slog.Logger) *Roles {
	return &Roles{repo: repo, clk: clk, rpID: rpID, log: log, res: NewResolver(repo)}
}

func (h *Roles) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/communities/{id}/roles", h.create)
	mux.HandleFunc("PATCH /v1/roles/{id}", h.patch)
	mux.HandleFunc("DELETE /v1/roles/{id}", h.delete)
	mux.HandleFunc("PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}", h.grant)
	mux.HandleFunc("DELETE /v1/communities/{id}/members/{user_id}/roles/{role_id}", h.revoke)
	mux.HandleFunc("PUT /v1/channels/{id}/overwrites/{kind}/{target_id}", h.putOverwrite)
	mux.HandleFunc("DELETE /v1/channels/{id}/overwrites/{kind}/{target_id}", h.deleteOverwrite)
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

// roleActor is who is acting on a community's roles, and with what: the
// session, the community and the actor's permission snapshot.
type roleActor struct {
	s    auth.Session
	com  store.CommunityRow
	snap Snapshot
	have Bits // snap.Resolve(s.UserID), community-wide
}

// manager loads the actor for community cid and requires PermManageRoles
// community-wide. A non-member, like an unknown community, is 404: a
// non-member must not learn that the community exists.
func (h *Roles) manager(r *http.Request, s auth.Session, cid id.ID) (roleActor, error) {
	com, err := h.repo.GetCommunity(r.Context(), cid)
	if err != nil {
		return roleActor{}, notFound(err)
	}
	if _, err := h.repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		return roleActor{}, notFound(err)
	}
	snap, err := LoadSnapshot(r.Context(), h.repo, cid, s.UserID, nil)
	if err != nil {
		return roleActor{}, notFound(err)
	}
	a := roleActor{s: s, com: com, snap: snap, have: snap.Resolve(s.UserID)}
	if !a.have.Has(PermManageRoles) {
		return roleActor{}, server.Errorf(server.CodeForbidden, "manage roles")
	}
	return a, nil
}

// outranks reports whether the actor sits strictly above position: the owner is
// above every role, anyone else above the roles below their own highest.
func (a roleActor) outranks(position uint64) bool {
	if a.s.UserID == a.com.Owner {
		return true
	}
	top, _ := a.snap.Highest(a.s.UserID)
	return position < top
}

// checkBits refuses a create, patch, grant or overwrite that would name a bit
// the actor does not hold. allow and deny are checked the same way: the power
// to DENY a permission community-wide is as much authority as the power to
// grant it. Nobody creates authority they do not hold; the owner and any
// holder of PermAdministrator resolve to PermAll, so for them this is a no-op.
func checkBits(have, allow, deny Bits) error {
	if bad := (allow | deny) &^ have; bad != 0 {
		return server.Errorf(server.CodeForbidden,
			"a role may not carry a permission you do not hold (%#x)", uint64(bad))
	}
	return nil
}

// knownBits refuses a bit outside the vocabulary: a stored bit this binary does
// not know is ignored by the resolver, so accepting one would store authority a
// newer binary would then silently grant.
func knownBits(field string, v uint64) (Bits, error) {
	if bad := Bits(v) &^ PermAll; bad != 0 {
		return 0, server.Errorf(server.CodeInvalidRequest, "%s carries undefined permission bits (%#x)", field, uint64(bad))
	}
	return Bits(v), nil
}

// flagByte narrows a 0-or-1 field.
func flagByte(field string, v uint64) (uint8, error) {
	switch v {
	case 0:
		return 0, nil
	case 1:
		return 1, nil
	}
	return 0, server.Errorf(server.CodeInvalidRequest, "%s is 0 or 1", field)
}

// validRole holds the field bounds of a role row about to be written. Position
// 0 is @everyone's: the caller decides whether this row is the @everyone row.
func validRole(role store.RoleRow, everyone bool) error {
	if err := validChannelText("name", role.Name, 1, maxRoleNameBytes, false); err != nil {
		return err
	}
	if role.Color > maxRoleColor {
		return server.Errorf(server.CodeInvalidRequest, "color is at most %#x", maxRoleColor)
	}
	if role.Position > maxRolePosition {
		return server.Errorf(server.CodeInvalidRequest, "position must be at most %d", maxRolePosition)
	}
	switch {
	case everyone && role.Position != 0:
		return server.Errorf(server.CodeInvalidRequest, "@everyone stays at position 0")
	case !everyone && role.Position == 0:
		return server.Errorf(server.CodeInvalidRequest, "position 0 is @everyone's")
	}
	return nil
}

type createRoleReq struct {
	_           struct{} `cbor:",toarray"`
	Name        string
	Color       uint64
	Position    uint64
	Allow       uint64
	Deny        uint64
	Hoist       uint64
	Mentionable uint64
}

// create is POST /v1/communities/{id}/roles: 201 [role_id]. Four checks: the
// actor holds PermManageRoles community-wide; the position is strictly below
// the actor's highest role; position 0 is refused (it is @everyone's, and
// Resolve grants it to every member); and allow and deny name only bits the
// actor holds.
func (h *Roles) create(w http.ResponseWriter, r *http.Request) {
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
	var req createRoleReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	a, err := h.manager(r, s, cid)
	if err != nil {
		h.fail(w, r, "create role", err)
		return
	}
	allow, err := knownBits("allow", req.Allow)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	deny, err := knownBits("deny", req.Deny)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	hoist, err := flagByte("hoist", req.Hoist)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	mentionable, err := flagByte("mentionable", req.Mentionable)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	role := store.RoleRow{
		ID: id.New(), CommunityID: cid, Name: req.Name, Color: req.Color, Position: req.Position,
		Allow: uint64(allow), Deny: uint64(deny), Hoist: hoist, Mentionable: mentionable,
		Created: h.clk.Now().Unix(),
	}
	if err := validRole(role, false); err != nil {
		server.WriteError(w, err)
		return
	}
	if !a.outranks(role.Position) {
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"a role at or above your highest role cannot be created"))
		return
	}
	if err := checkBits(a.have, allow, deny); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		roles, err := tx.ListRoles(r.Context(), cid)
		if err != nil {
			return err
		}
		if len(roles) >= maxRolesPerCommunity {
			return server.Errorf(server.CodeInvalidRequest,
				"a community has at most %d roles", maxRolesPerCommunity)
		}
		if err := tx.PutRole(r.Context(), role); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "role.create", Target: role.ID.String(),
			Detail: cid.String(), At: role.Created,
		})
	}); err != nil {
		h.fail(w, r, "create role", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusCreated, []id.ID{role.ID}); err != nil {
		h.log.Error("encode create role", "err", err)
	}
}

type patchRoleReq struct {
	_           struct{} `cbor:",toarray"`
	Name        *string
	Color       *uint64
	Position    *uint64
	Allow       *uint64
	Deny        *uint64
	Hoist       *uint64
	Mentionable *uint64
}

// patch is PATCH /v1/roles/{id}: 204. Null leaves a field alone. The role must
// sit strictly below the actor, and so must its new position; @everyone may be
// edited by those who outrank it and never moved, and no other role may be
// moved to position 0. A new allow or deny names only bits the actor holds.
func (h *Roles) patch(w http.ResponseWriter, r *http.Request) {
	s, err := enrolledSession(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	roleID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req patchRoleReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	current, err := h.repo.GetRole(r.Context(), roleID)
	if err != nil {
		h.fail(w, r, "patch role", notFound(err))
		return
	}
	a, err := h.manager(r, s, current.CommunityID)
	if err != nil {
		h.fail(w, r, "patch role", err)
		return
	}
	everyone := current.ID == a.snap.Everyone
	if !a.outranks(current.Position) {
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"a role at or above your highest role cannot be changed"))
		return
	}
	if req.Position != nil && (everyone || *req.Position == 0) {
		// Position 0 is @everyone's alone, so Snapshot.Everyone stays
		// unambiguous for the life of the community.
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"@everyone stays at position 0 and no other role may move there"))
		return
	}
	var allow, deny *Bits
	if req.Allow != nil {
		b, err := knownBits("allow", *req.Allow)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		allow = &b
	}
	if req.Deny != nil {
		b, err := knownBits("deny", *req.Deny)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		deny = &b
	}
	var reqAllow, reqDeny Bits
	if allow != nil {
		reqAllow = *allow
	}
	if deny != nil {
		reqDeny = *deny
	}
	if err := checkBits(a.have, reqAllow, reqDeny); err != nil {
		server.WriteError(w, err)
		return
	}
	var hoist, mentionable *uint8
	if req.Hoist != nil {
		v, err := flagByte("hoist", *req.Hoist)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		hoist = &v
	}
	if req.Mentionable != nil {
		v, err := flagByte("mentionable", *req.Mentionable)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		mentionable = &v
	}
	now := h.clk.Now().Unix()
	// The row is read again inside the transaction and the request applied to
	// that, so two concurrent PATCHes of different fields both land.
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		role, err := tx.GetRole(r.Context(), roleID)
		if err != nil {
			return notFound(err)
		}
		if role.Position != current.Position {
			// Moved since the checks above ran: the rank check was made against a
			// position that no longer holds.
			return server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest,
				"the role changed concurrently: read it again and retry"))
		}
		if req.Name != nil {
			role.Name = *req.Name
		}
		if req.Color != nil {
			role.Color = *req.Color
		}
		if req.Position != nil {
			role.Position = *req.Position
		}
		if allow != nil {
			role.Allow = uint64(*allow)
		}
		if deny != nil {
			role.Deny = uint64(*deny)
		}
		if hoist != nil {
			role.Hoist = *hoist
		}
		if mentionable != nil {
			role.Mentionable = *mentionable
		}
		if err := validRole(role, everyone); err != nil {
			return err
		}
		if !a.outranks(role.Position) {
			return server.Errorf(server.CodeForbidden,
				"a role cannot be moved to or above your highest role")
		}
		if err := tx.PutRole(r.Context(), role); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "role.update", Target: role.ID.String(),
			Detail: role.Name, At: now,
		})
	}); err != nil {
		h.fail(w, r, "patch role", err)
		return
	}
	// A role's bits decide who may see every private channel of the community.
	h.materialiseCommunity(r.Context(), current.CommunityID, now)
	w.WriteHeader(http.StatusNoContent)
}

// delete is DELETE /v1/roles/{id}: 204. The actor must outrank the role, and
// @everyone is never deleted. The role's grants go with it (member_roles
// cascades).
func (h *Roles) delete(w http.ResponseWriter, r *http.Request) {
	s, err := enrolledSession(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	roleID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	role, err := h.repo.GetRole(r.Context(), roleID)
	if err != nil {
		h.fail(w, r, "delete role", notFound(err))
		return
	}
	a, err := h.manager(r, s, role.CommunityID)
	if err != nil {
		h.fail(w, r, "delete role", err)
		return
	}
	if role.ID == a.snap.Everyone || role.Position == 0 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "@everyone cannot be deleted"))
		return
	}
	if !a.outranks(role.Position) {
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"a role at or above your highest role cannot be deleted"))
		return
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteRole(r.Context(), role.CommunityID, role.ID); err != nil {
			return notFound(err)
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "role.delete", Target: role.ID.String(),
			Detail: role.Name, At: now,
		})
	}); err != nil {
		h.fail(w, r, "delete role", err)
		return
	}
	h.materialiseCommunity(r.Context(), role.CommunityID, now)
	w.WriteHeader(http.StatusNoContent)
}

// grantTarget is the parsed path of the grant and revoke routes plus the actor
// and the role, checked: the actor holds PermManageRoles, the role belongs to
// the community, the actor outranks it and holds every bit it carries, and the
// target is a member.
type grantTarget struct {
	a      roleActor
	cid    id.ID
	target id.ID
	role   store.RoleRow
}

func (h *Roles) grantPath(r *http.Request, verb string) (grantTarget, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return grantTarget{}, err
	}
	var g grantTarget
	if g.cid, err = server.PathID(r, "id"); err != nil {
		return grantTarget{}, err
	}
	if g.target, err = server.PathID(r, "user_id"); err != nil {
		return grantTarget{}, err
	}
	roleID, err := server.PathID(r, "role_id")
	if err != nil {
		return grantTarget{}, err
	}
	if g.a, err = h.manager(r, s, g.cid); err != nil {
		return grantTarget{}, err
	}
	g.role, err = h.repo.GetRole(r.Context(), roleID)
	// A store fault is not a 404: only ErrNotFound and a role belonging to another
	// community are. Collapsing both into 404 would hide a disk error behind an
	// authorisation answer.
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return grantTarget{}, err
	}
	if err != nil || g.role.CommunityID != g.cid {
		return grantTarget{}, server.Errorf(server.CodeNotFound, "no such role")
	}
	if g.role.ID == g.a.snap.Everyone || g.role.Position == 0 {
		return grantTarget{}, server.Errorf(server.CodeInvalidRequest,
			"@everyone is held by every member and is not %s", verb)
	}
	if !g.a.outranks(g.role.Position) {
		return grantTarget{}, server.Errorf(server.CodeForbidden,
			"a role at or above your highest role cannot be %s", verb)
	}
	// A role below the actor may still have been given, by someone above them,
	// a bit the actor does not hold: handing it out would be creating authority
	// the actor does not have, exactly as a create carrying that bit would be.
	if err := checkBits(g.a.have, Bits(g.role.Allow)&PermAll, Bits(g.role.Deny)&PermAll); err != nil {
		return grantTarget{}, err
	}
	if _, err := h.repo.GetMember(r.Context(), g.cid, g.target); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return grantTarget{}, server.Errorf(server.CodeNotFound, "not a member")
		}
		return grantTarget{}, err
	}
	return g, nil
}

// grant is PUT /v1/communities/{id}/members/{user_id}/roles/{role_id}: 204 with
// an empty body. On top of grantPath's rules, when the community sets
// require_mod_2fa and the role carries a moderation bit, the *target* must hold
// a second factor.
func (h *Roles) grant(w http.ResponseWriter, r *http.Request) {
	g, err := h.grantPath(r, "granted")
	if err != nil {
		h.fail(w, r, "grant role", err)
		return
	}
	if g.a.com.RequireMod2FA == 1 && Bits(g.role.Allow)&moderatorBits != 0 {
		if err := requireSecondFactor(r.Context(), h.repo, g.target, h.rpID); err != nil {
			h.fail(w, r, "grant role", err)
			return
		}
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.PutMemberRole(r.Context(), g.cid, g.target, g.role.ID); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &g.a.s.UserID, Action: "role.grant", Target: g.target.String(),
			Detail: g.role.ID.String(), At: now,
		})
	}); err != nil {
		h.fail(w, r, "grant role", err)
		return
	}
	// The eligibility materialiser runs AFTER the transaction commits, never
	// inside it: it calls the delivery service, which writes through the same
	// single-writer pool (§4.7 SetMaxOpenConns(1)) and would deadlock against the
	// open transaction. Task 7 gives it its body; a failure here is logged and
	// re-driven, because channel_members is derived state.
	if err := syncChannelEligibility(r.Context(), h.repo, g.cid, g.target, now); err != nil {
		h.log.ErrorContext(r.Context(), "sync channel eligibility", "community", g.cid, "user", g.target, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// revoke is DELETE /v1/communities/{id}/members/{user_id}/roles/{role_id}: 204,
// the mirror image of grant. A grant that does not exist is 404.
func (h *Roles) revoke(w http.ResponseWriter, r *http.Request) {
	g, err := h.grantPath(r, "revoked")
	if err != nil {
		h.fail(w, r, "revoke role", err)
		return
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteMemberRole(r.Context(), g.cid, g.target, g.role.ID); err != nil {
			return notFound(err)
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &g.a.s.UserID, Action: "role.revoke", Target: g.target.String(),
			Detail: g.role.ID.String(), At: now,
		})
	}); err != nil {
		h.fail(w, r, "revoke role", err)
		return
	}
	if err := syncChannelEligibility(r.Context(), h.repo, g.cid, g.target, now); err != nil {
		h.log.ErrorContext(r.Context(), "sync channel eligibility", "community", g.cid, "user", g.target, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// overwritePath is the parsed path of the two overwrite routes, checked: the
// channel is one the actor may manage roles in, and the target is a role of the
// channel's community (kind 0) or a member of it (kind 1).
type overwritePath struct {
	s    auth.Session
	ch   store.ChannelRow
	kind uint8
	tgt  id.ID
	have Bits // the actor's bits IN this channel
}

func (h *Roles) overwriteTarget(r *http.Request) (overwritePath, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return overwritePath{}, err
	}
	o := overwritePath{s: s}
	chID, err := server.PathID(r, "id")
	if err != nil {
		return overwritePath{}, err
	}
	switch r.PathValue("kind") {
	case "0":
		o.kind = overwriteRole
	case "1":
		o.kind = overwriteUser
	default:
		return overwritePath{}, server.Errorf(server.CodeInvalidRequest, "kind is 0 (role) or 1 (user)")
	}
	if o.tgt, err = server.PathID(r, "target_id"); err != nil {
		return overwritePath{}, err
	}
	if o.ch, err = h.repo.GetChannel(r.Context(), chID); err != nil {
		return overwritePath{}, notFound(err)
	}
	// Require answers 404 to a caller who cannot view the channel, which
	// includes a non-member and every DM until task 6.
	if o.have, err = h.res.Resolve(r.Context(), s.UserID, o.ch); err != nil {
		return overwritePath{}, err
	}
	if !o.have.Has(PermViewChannel) {
		return overwritePath{}, server.Errorf(server.CodeNotFound, "no such object")
	}
	if !o.have.Has(PermManageRoles) {
		return overwritePath{}, server.Errorf(server.CodeForbidden, "missing permission")
	}
	cid := *o.ch.CommunityID // Resolve answers 0 for a channel with no community
	// The rank rule of the role routes holds here too: an overwrite may target
	// only a role strictly below the actor's highest, or a member whose highest
	// role is, so a staffer cannot mute a senior moderator in one channel.
	actor, err := LoadSnapshot(r.Context(), h.repo, cid, s.UserID, nil)
	if err != nil {
		return overwritePath{}, notFound(err)
	}
	top, _ := actor.Highest(s.UserID)
	var targetPos uint64
	switch o.kind {
	case overwriteRole:
		role, err := h.repo.GetRole(r.Context(), o.tgt)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return overwritePath{}, err
		}
		if err != nil || role.CommunityID != cid {
			return overwritePath{}, server.Errorf(server.CodeNotFound, "no such role")
		}
		targetPos = role.Position
	case overwriteUser:
		if _, err := h.repo.GetMember(r.Context(), cid, o.tgt); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return overwritePath{}, server.Errorf(server.CodeNotFound, "not a member")
			}
			return overwritePath{}, err
		}
		target, err := LoadSnapshot(r.Context(), h.repo, cid, o.tgt, nil)
		if err != nil {
			return overwritePath{}, notFound(err)
		}
		targetPos, _ = target.Highest(o.tgt) // the owner's is above every role
	}
	if s.UserID != actor.Owner && targetPos >= top {
		return overwritePath{}, server.Errorf(server.CodeForbidden,
			"an overwrite may target only a role or member below your highest role")
	}
	return o, nil
}

type putOverwriteReq struct {
	_     struct{} `cbor:",toarray"`
	Allow uint64
	Deny  uint64
}

// putOverwrite is PUT /v1/channels/{id}/overwrites/{kind}/{target_id} with
// [allow, deny]: 204. The actor holds PermManageRoles in the channel; allow and
// deny name only defined, channel-scoped bits the actor holds in the channel,
// and never the same bit twice.
func (h *Roles) putOverwrite(w http.ResponseWriter, r *http.Request) {
	o, err := h.overwriteTarget(r)
	if err != nil {
		h.fail(w, r, "put overwrite", err)
		return
	}
	var req putOverwriteReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	allow, err := knownBits("allow", req.Allow)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	deny, err := knownBits("deny", req.Deny)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if both := allow & deny; both != 0 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"a bit is either allowed or denied, not both (%#x)", uint64(both)))
		return
	}
	if scoped := (allow | deny) & communityBits; scoped != 0 {
		// The resolver ignores them in an overwrite; storing one would record an
		// intent the instance never honours.
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"a channel overwrite cannot carry a community-wide permission (%#x)", uint64(scoped)))
		return
	}
	if err := checkBits(o.have, allow, deny); err != nil {
		server.WriteError(w, err)
		return
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.PutOverwrite(r.Context(), store.OverwriteRow{
			ChannelID: o.ch.ID, TargetKind: o.kind, TargetID: o.tgt,
			Allow: uint64(allow), Deny: uint64(deny),
		}); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &o.s.UserID, Action: "channel.overwrite.put", Target: o.ch.ID.String(),
			Detail: fmt.Sprintf("%d:%s", o.kind, o.tgt), At: now,
		})
	}); err != nil {
		h.fail(w, r, "put overwrite", err)
		return
	}
	if err := materialiseChannelMembers(r.Context(), h.repo, o.ch.ID, now); err != nil {
		h.log.ErrorContext(r.Context(), "materialise channel members", "channel", o.ch.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteOverwrite is DELETE /v1/channels/{id}/overwrites/{kind}/{target_id}:
// 204, or 404 when there is no such overwrite.
func (h *Roles) deleteOverwrite(w http.ResponseWriter, r *http.Request) {
	o, err := h.overwriteTarget(r)
	if err != nil {
		h.fail(w, r, "delete overwrite", err)
		return
	}
	now := h.clk.Now().Unix()
	if err := h.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteOverwrite(r.Context(), o.ch.ID, o.kind, o.tgt); err != nil {
			return notFound(err)
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &o.s.UserID, Action: "channel.overwrite.delete", Target: o.ch.ID.String(),
			Detail: fmt.Sprintf("%d:%s", o.kind, o.tgt), At: now,
		})
	}); err != nil {
		h.fail(w, r, "delete overwrite", err)
		return
	}
	if err := materialiseChannelMembers(r.Context(), h.repo, o.ch.ID, now); err != nil {
		h.log.ErrorContext(r.Context(), "materialise channel members", "channel", o.ch.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// materialiseCommunity re-derives channel_members for every channel of the
// community after a change that can move any member's eligibility (a role's
// bits or its deletion). It runs after the commit, like every materialiser.
func (h *Roles) materialiseCommunity(ctx context.Context, communityID id.ID, now int64) {
	channels, err := h.repo.ListChannels(ctx, communityID)
	if err != nil {
		h.log.ErrorContext(ctx, "materialise community", "community", communityID, "err", err)
		return
	}
	for _, ch := range channels {
		if err := materialiseChannelMembers(ctx, h.repo, ch.ID, now); err != nil {
			h.log.ErrorContext(ctx, "materialise channel members", "channel", ch.ID, "err", err)
		}
	}
}

// syncChannelEligibility rewrites channel_members for one user across every
// private channel of the community, from the resolver's verdict. Task 7 gives it
// its body and its delivery-service side; here it is a no-op so that the call
// sites are already in place.
func syncChannelEligibility(ctx context.Context, repo store.Repository, communityID, userID id.ID, now int64) error {
	return nil
}

// materialiseChannelMembers rewrites one channel's channel_members from the
// resolver's verdict for every member of its community. Task 7 gives it its
// body and its delivery-service side (the batched Adds and Removes); here it is
// a no-op so that the call sites are already in place.
func materialiseChannelMembers(ctx context.Context, repo store.Repository, channelID id.ID, now int64) error {
	return nil
}

// fail writes err as the client's refusal, logging anything that is not a
// *server.Error: those reach the client as an empty E_INTERNAL.
func (h *Roles) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	var se *server.Error
	if !errors.As(err, &se) {
		h.log.ErrorContext(r.Context(), what, "err", err)
	}
	server.WriteError(w, err)
}
