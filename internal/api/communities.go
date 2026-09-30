package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Communities serves the community routes of interfaces.md §5.2: create, read,
// patch and delete a community, list and remove its members, join and leave.
// Every body is a fixed-position CBOR array (protocol/09 § Communities).
//
// Register mounts the handlers bare: the composition root wraps the mux in the
// session middleware, and each handler still refuses a request that carries no
// enrolled session, so a mis-mounted route fails closed.
type Communities struct {
	repo store.Repository
	dsvc DS
	clk  clock.Clock
	log  *slog.Logger
}

// NewCommunities takes the delivery service a membership change reaches: a
// kick or a leave removes the user's leaves from the community's groups, and a
// community delete closes them (membership.go).
func NewCommunities(repo store.Repository, dsvc DS, clk clock.Clock, log *slog.Logger) *Communities {
	return &Communities{repo: repo, dsvc: dsvc, clk: clk, log: log}
}

func (c *Communities) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/communities", c.create)
	mux.HandleFunc("GET /v1/communities/{id}", c.get)
	mux.HandleFunc("PATCH /v1/communities/{id}", c.patch)
	mux.HandleFunc("DELETE /v1/communities/{id}", c.delete)
	mux.HandleFunc("GET /v1/communities/{id}/members", c.members)
	mux.HandleFunc("DELETE /v1/communities/{id}/members/{user_id}", c.removeMember)
	mux.HandleFunc("POST /v1/communities/{id}/join", c.join)
	mux.HandleFunc("POST /v1/communities/{id}/leave", c.leave)
}

// maxCommunityNameBytes bounds the one free-text field a community owner controls.
// It is the same bound protocol/04 puts on an attachment mime (255), for the same
// reason: a TEXT column with no bound is a storage-exhaustion primitive.
const maxCommunityNameBytes = 255

// maxPolicyBytes bounds the community policy document.
const maxPolicyBytes = 16 * 1024

// maxMinAccountAgeSeconds bounds min_account_age_seconds at a century. The
// column is a signed 64-bit integer on both engines, so an unbounded uint64
// from a client would wrap negative in the store adapter and turn the gate off.
const maxMinAccountAgeSeconds = 100 * 365 * 24 * 3600

// maxMembersPage is one page of GET /v1/communities/{id}/members.
const maxMembersPage = 200

// everyoneRoleAllow is the permission base every new community starts from:
// view, send, attach, react, read history, connect, speak, video, screen share
// and create invite. The @everyone role's id, not its position, is what task
// 3's resolver reads as the base.
const everyoneRoleAllow = PermViewChannel | PermSendMessages | PermAttachFiles |
	PermAddReactions | PermReadHistory | PermConnect | PermSpeak | PermVideo |
	PermScreenShare | PermCreateInvite

type createCommunityReq struct {
	_                    struct{} `cbor:",toarray"`
	Name                 string
	Policy               []byte
	MinAccountAgeSeconds uint64
	RequireMod2FA        uint64
}

type createCommunityResp struct {
	_             struct{} `cbor:",toarray"`
	CommunityID   id.ID
	RoleEveryone  id.ID
	PolicyVersion uint64
}

func (c *Communities) create(w http.ResponseWriter, r *http.Request) {
	s, err := enrolledSession(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req createCommunityReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := validCommunityName(req.Name); err != nil {
		server.WriteError(w, err)
		return
	}
	twofa, err := requireMod2FAFlag(req.RequireMod2FA)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if err := validMinAccountAge(req.MinAccountAgeSeconds); err != nil {
		server.WriteError(w, err)
		return
	}
	if len(req.Policy) == 0 {
		req.Policy = []byte("{}")
	}
	if _, err := ParseCommunityPolicy(req.Policy); err != nil {
		server.WriteError(w, err)
		return
	}
	nick, err := memberNick("")
	if err != nil {
		server.WriteError(w, err)
		return
	}

	now := c.clk.Now().Unix()
	out := createCommunityResp{CommunityID: id.New(), RoleEveryone: id.New(), PolicyVersion: 1}
	err = c.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.CreateCommunity(r.Context(), store.CommunityRow{
			ID:                   out.CommunityID,
			Owner:                s.UserID,
			Name:                 req.Name,
			PolicyJSON:           req.Policy,
			PolicyVersion:        1,
			MinAccountAgeSeconds: req.MinAccountAgeSeconds,
			RequireMod2FA:        twofa,
			Created:              now,
		}); err != nil {
			return err
		}
		if err := tx.PutMember(r.Context(), store.MemberOfCommunityRow{
			CommunityID: out.CommunityID, UserID: s.UserID, Joined: now, Nick: nick,
		}); err != nil {
			return err
		}
		if err := tx.PutRole(r.Context(), store.RoleRow{
			ID: out.RoleEveryone, CommunityID: out.CommunityID, Name: "@everyone",
			// store.RoleRow.Allow is uint64 (§4.2: roles.allow is a counter);
			// everyoneRoleAllow is api.Bits, a distinct named type.
			Position: 0, Allow: uint64(everyoneRoleAllow), Created: now,
		}); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "community.create",
			Target: out.CommunityID.String(), Detail: req.Name, At: now,
		})
	})
	if err != nil {
		c.fail(w, r, "create community", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusCreated, out); err != nil {
		c.log.Error("encode create community", "err", err)
	}
}

type communityResp struct {
	_                    struct{} `cbor:",toarray"`
	CommunityID          id.ID
	Owner                id.ID
	Name                 string
	Policy               []byte
	PolicyVersion        uint64
	MinAccountAgeSeconds uint64
	RequireMod2FA        uint64
	Created              int64
}

func (c *Communities) get(w http.ResponseWriter, r *http.Request) {
	row, _, err := c.memberOnly(r)
	if err != nil {
		c.fail(w, r, "get community", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, communityResp{
		CommunityID: row.ID, Owner: row.Owner, Name: row.Name, Policy: row.PolicyJSON,
		PolicyVersion: row.PolicyVersion, MinAccountAgeSeconds: row.MinAccountAgeSeconds,
		RequireMod2FA: uint64(row.RequireMod2FA), Created: row.Created,
	}); err != nil {
		c.log.Error("encode community", "err", err)
	}
}

type patchCommunityReq struct {
	_                    struct{} `cbor:",toarray"`
	Name                 *string
	Policy               []byte
	MinAccountAgeSeconds *uint64
	RequireMod2FA        *uint64
}

func (c *Communities) patch(w http.ResponseWriter, r *http.Request) {
	row, s, err := c.managerOnly(r)
	if err != nil {
		c.fail(w, r, "patch community", err)
		return
	}
	var req patchCommunityReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	// Every field is validated before the transaction opens, so a refused
	// PATCH changes nothing.
	var changed []string
	if req.Name != nil {
		if err := validCommunityName(*req.Name); err != nil {
			server.WriteError(w, err)
			return
		}
		changed = append(changed, "name")
	}
	if len(req.Policy) > 0 {
		if _, err := ParseCommunityPolicy(req.Policy); err != nil {
			server.WriteError(w, err)
			return
		}
		changed = append(changed, "policy")
	}
	if req.MinAccountAgeSeconds != nil {
		if err := validMinAccountAge(*req.MinAccountAgeSeconds); err != nil {
			server.WriteError(w, err)
			return
		}
		changed = append(changed, "min_account_age_seconds")
	}
	var twofa *uint8
	if req.RequireMod2FA != nil {
		v, err := requireMod2FAFlag(*req.RequireMod2FA)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		twofa = &v
		changed = append(changed, "require_mod_2fa")
	}

	version := row.PolicyVersion
	if len(changed) > 0 {
		err = c.repo.Tx(r.Context(), func(tx store.Repository) error {
			// Re-read inside the transaction: the row memberOnly returned is a
			// snapshot from before it, and the policy version must follow the
			// stored one, not that snapshot.
			cur, err := tx.GetCommunity(r.Context(), row.ID)
			if err != nil {
				return notFound(err)
			}
			version = cur.PolicyVersion
			if len(req.Policy) > 0 {
				version = cur.PolicyVersion + 1
				//nolint:gosec // G115: policy_version starts at 1 and moves by one per PATCH; it cannot reach 2^63
				if err := tx.UpdateCommunityPolicy(r.Context(), cur.ID, req.Policy, int64(version)); err != nil {
					return err
				}
			}
			if req.Name != nil || req.MinAccountAgeSeconds != nil || twofa != nil {
				name, age, flag := cur.Name, cur.MinAccountAgeSeconds, cur.RequireMod2FA
				if req.Name != nil {
					name = *req.Name
				}
				if req.MinAccountAgeSeconds != nil {
					age = *req.MinAccountAgeSeconds
				}
				if twofa != nil {
					flag = *twofa
				}
				if err := tx.UpdateCommunityMeta(r.Context(), cur.ID, name, age, flag); err != nil {
					return err
				}
			}
			return tx.Audit(r.Context(), store.AuditRow{
				Actor: &s.UserID, Action: "community.patch", Target: cur.ID.String(),
				Detail: strings.Join(changed, ","), At: c.clk.Now().Unix(),
			})
		})
		if err != nil {
			c.fail(w, r, "patch community", err)
			return
		}
	}
	if err := server.EncodeBody(w, http.StatusOK, []uint64{version}); err != nil {
		c.log.Error("encode patch community", "err", err)
	}
}

type joinReq struct {
	_ struct{} `cbor:",toarray"`
	// Invite is task 5's: at task 1 a community is joinable by any
	// authenticated account that passes the join gate, and the field is read
	// and not used.
	Invite *string
}

func (c *Communities) join(w http.ResponseWriter, r *http.Request) {
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
	var req joinReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	row, err := c.repo.GetCommunity(r.Context(), cid)
	if err != nil {
		c.fail(w, r, "join", notFound(err))
		return
	}
	// Joining is idempotent: a member who joins again keeps the row, and with
	// it the nick and the join time, rather than being rewritten by the upsert.
	switch _, err := c.repo.GetMember(r.Context(), cid, s.UserID); {
	case err == nil:
		if err := server.EncodeBody(w, http.StatusOK, []id.ID{cid}); err != nil {
			c.log.Error("encode join", "err", err)
		}
		return
	case !errors.Is(err, store.ErrNotFound):
		c.fail(w, r, "join", err)
		return
	}
	if err := c.joinGate(r.Context(), row, s.UserID); err != nil {
		c.fail(w, r, "join", err)
		return
	}
	nick, err := memberNick("")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// Task 5 adds invite redemption here; at task 1 a community with no gate
	// is joinable by any authenticated account.
	if err := c.repo.PutMember(r.Context(), store.MemberOfCommunityRow{
		CommunityID: cid, UserID: s.UserID, Joined: c.clk.Now().Unix(), Nick: nick,
	}); err != nil {
		c.fail(w, r, "join", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, []id.ID{cid}); err != nil {
		c.log.Error("encode join", "err", err)
	}
}

// joinGate enforces R17's stored gates: the account must not be banned from the
// community (a ban whose expiry has passed no longer gates), must be live, and
// at least min_account_age_seconds old. Invite-only communities and the
// screening flag are task 5's.
func (c *Communities) joinGate(ctx context.Context, row store.CommunityRow, userID id.ID) error {
	if ban, err := c.repo.GetBan(ctx, row.ID, userID); err == nil {
		if BanStands(ban, c.clk.Now().Unix()) {
			return server.Errorf(server.CodeForbidden, "banned from this community")
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return err
	}
	u, err := c.repo.GetUser(ctx, userID)
	if err != nil {
		return err
	}
	if u.DisabledAt != nil || u.DeletedAt != nil {
		return server.Errorf(server.CodeForbidden, "account disabled")
	}
	if row.MinAccountAgeSeconds > 0 {
		age := c.clk.Now().Unix() - u.Created
		// MinAccountAgeSeconds is bounded by maxMinAccountAgeSeconds on the way
		// in, so it fits an int64.
		if age < int64(min(row.MinAccountAgeSeconds, maxMinAccountAgeSeconds)) {
			return server.Errorf(server.CodeForbidden,
				"account must be at least %d seconds old", row.MinAccountAgeSeconds)
		}
	}
	return nil
}

// memberOnly resolves {id} and requires the session's user to be a member.
func (c *Communities) memberOnly(r *http.Request) (store.CommunityRow, auth.Session, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return store.CommunityRow{}, s, err
	}
	cid, err := server.PathID(r, "id")
	if err != nil {
		return store.CommunityRow{}, s, err
	}
	row, err := c.repo.GetCommunity(r.Context(), cid)
	if err != nil {
		return store.CommunityRow{}, s, notFound(err)
	}
	if _, err := c.repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return store.CommunityRow{}, s, err
		}
		// A non-member must not learn that the community exists.
		return store.CommunityRow{}, s, server.Errorf(server.CodeNotFound, "no such object")
	}
	return row, s, nil
}

// managerOnly is memberOnly plus PermManageCommunity, which the owner always
// holds. It gates PATCH; deleting the community stays the owner's (ownerOnly).
func (c *Communities) managerOnly(r *http.Request) (store.CommunityRow, auth.Session, error) {
	row, s, err := c.memberOnly(r)
	if err != nil {
		return row, s, err
	}
	snap, err := LoadSnapshot(r.Context(), c.repo, row.ID, s.UserID, nil)
	if err != nil {
		return row, s, notFound(err)
	}
	if !snap.Resolve(s.UserID).Has(PermManageCommunity) {
		return row, s, server.Errorf(server.CodeForbidden, "manage community")
	}
	return row, s, nil
}

// ownerOnly is memberOnly plus ownership: deleting the community.
func (c *Communities) ownerOnly(r *http.Request) (store.CommunityRow, auth.Session, error) {
	row, s, err := c.memberOnly(r)
	if err != nil {
		return row, s, err
	}
	if row.Owner != s.UserID {
		return row, s, server.Errorf(server.CodeForbidden, "owner only")
	}
	return row, s, nil
}

type memberResp struct {
	_      struct{} `cbor:",toarray"`
	UserID id.ID
	Joined int64
	Nick   string
	Roles  []id.ID
}

func (c *Communities) members(w http.ResponseWriter, r *http.Request) {
	row, _, err := c.memberOnly(r)
	if err != nil {
		c.fail(w, r, "list members", err)
		return
	}
	var after id.ID
	if raw := r.URL.Query().Get("after"); raw != "" {
		if after, err = id.Parse(raw); err != nil {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "after: %v", err))
			return
		}
	}
	rows, err := c.repo.ListMembersOfCommunity(r.Context(), row.ID, after, maxMembersPage)
	if err != nil {
		c.fail(w, r, "list members", err)
		return
	}
	out := make([]memberResp, 0, len(rows))
	for _, m := range rows {
		roles, err := c.repo.ListMemberRoles(r.Context(), row.ID, m.UserID)
		if err != nil {
			c.fail(w, r, "list members", err)
			return
		}
		if roles == nil {
			roles = []id.ID{} // an array on the wire, never null
		}
		out = append(out, memberResp{UserID: m.UserID, Joined: m.Joined, Nick: m.Nick, Roles: roles})
	}
	if err := server.EncodeBody(w, http.StatusOK, out); err != nil {
		c.log.Error("encode members", "err", err)
	}
}

// removeMember is the kick: it needs kick_members community-wide and a target
// strictly below the caller (the pair Bans uses), deletes the membership row,
// and then removes the user's leaves from the community's groups. It writes no
// ban row, so a kicked user may join again at once.
func (c *Communities) removeMember(w http.ResponseWriter, r *http.Request) {
	m, err := moderate(r, c.repo, PermKickMembers)
	if err != nil {
		c.fail(w, r, "kick", err)
		return
	}
	// A target who is not a member answers 404, before the rank check, so the
	// answer does not depend on who the caller is.
	if _, err := c.repo.GetMember(r.Context(), m.community, m.target); err != nil {
		c.fail(w, r, "kick", notFound(err))
		return
	}
	if err := outranks(r.Context(), c.repo, m.snap, m.session.UserID, m.target, m.community); err != nil {
		c.fail(w, r, "kick", err)
		return
	}
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteMember(r.Context(), m.community, m.target); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &m.session.UserID, Action: "member.kick",
			Target: m.target.String(), Detail: m.community.String(), At: c.clk.Now().Unix(),
		})
	}); err != nil {
		c.fail(w, r, "kick", notFound(err))
		return
	}
	// After the commit, never inside it: see RemoveUserFromCommunityGroups.
	c.removeFromGroups(r, m.community, m.target)
	w.WriteHeader(http.StatusNoContent)
}

// removeFromGroups issues the delivery-service Removes of a membership change
// that has already committed. A failure is logged, not answered: the membership
// row is gone, so the Add and join ACL (ResolverACL) already refuses the user,
// and the change itself cannot be undone by a refused proposal.
func (c *Communities) removeFromGroups(r *http.Request, cid, userID id.ID) {
	if err := RemoveUserFromCommunityGroups(r.Context(), c.repo, c.dsvc, cid, userID); err != nil {
		c.log.ErrorContext(r.Context(), "remove user from the community's groups",
			"community", cid, "user", userID, "err", err)
	}
}

func (c *Communities) leave(w http.ResponseWriter, r *http.Request) {
	row, s, err := c.memberOnly(r)
	if err != nil {
		c.fail(w, r, "leave", err)
		return
	}
	if row.Owner == s.UserID {
		server.WriteError(w, server.Errorf(server.CodeForbidden,
			"the owner must transfer ownership or delete the community"))
		return
	}
	if err := c.repo.DeleteMember(r.Context(), row.ID, s.UserID); err != nil {
		c.fail(w, r, "leave", notFound(err))
		return
	}
	// A member who leaves stops receiving the community's keys: the instance
	// removes their leaves exactly as for a kick, after the row is gone.
	c.removeFromGroups(r, row.ID, s.UserID)
	w.WriteHeader(http.StatusNoContent)
}

func (c *Communities) delete(w http.ResponseWriter, r *http.Request) {
	row, s, err := c.ownerOnly(r)
	if err != nil {
		c.fail(w, r, "delete community", err)
		return
	}
	now := c.clk.Now().Unix()
	// Inside the transaction: read what will be closed, then tombstone.
	// ListChannels filters deleted_at IS NULL, so it runs BEFORE
	// DeleteChannelsOfCommunity or it returns nothing.
	var toClose []id.ID
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		channels, err := tx.ListChannels(r.Context(), row.ID)
		if err != nil {
			return err
		}
		ids := make([]id.ID, 0, len(channels))
		for _, ch := range channels {
			ids = append(ids, ch.ID)
		}
		if toClose, err = openChannelGroups(r.Context(), tx, ids); err != nil {
			return err
		}
		// The community's channels go with it, in the same transaction.
		if _, err := tx.DeleteChannelsOfCommunity(r.Context(), row.ID, now); err != nil {
			return err
		}
		if err := tx.SoftDeleteCommunity(r.Context(), row.ID, now); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "community.delete", Target: row.ID.String(),
			Detail: "", At: now,
		})
	}); err != nil {
		c.fail(w, r, "delete community", notFound(err))
		return
	}
	// After the commit, for RemoveUserFromCommunityGroups' reason: ds.Close
	// writes through the single-connection write pool the transaction held. A
	// crash between the two leaves the community tombstoned and its groups open;
	// they carry no live channel, so the Add and join ACL refuses everyone.
	if err := closeGroups(r.Context(), c.dsvc, toClose); err != nil {
		c.log.ErrorContext(r.Context(), "close the groups of a deleted community",
			"community", row.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// fail writes err as the client's refusal. A store.ErrConflict is the policy
// version guard: a concurrent PATCH got there first. Anything that is not a
// *server.Error is logged here and reaches the client as an empty E_INTERNAL.
func (c *Communities) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	var se *server.Error
	switch {
	case errors.As(err, &se):
	case errors.Is(err, store.ErrConflict):
		err = server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest,
			"the community changed concurrently: read it again and retry"))
	default:
		c.log.ErrorContext(r.Context(), what, "err", err)
	}
	server.WriteError(w, err)
}

// enrolledSession is the session every community and role route requires:
// protocol/09 marks them all "E". The middleware already enforces the scope;
// this is the handler's own check, so a route mounted without it fails closed.
func enrolledSession(r *http.Request) (auth.Session, error) {
	s, ok := auth.SessionFrom(r.Context())
	if !ok {
		return s, server.Errorf(server.CodeUnauthenticated, "no device session")
	}
	if s.Scope != auth.ScopeEnrolled {
		return s, server.Errorf(server.CodeForbidden, "an enrolled session is required")
	}
	return s, nil
}

func notFound(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return server.Errorf(server.CodeNotFound, "no such object")
	}
	return err
}

// validCommunityName is 1..255 bytes of UTF-8 with no control character. A
// NUL is legal in a Go string and in a SQLite TEXT column but refused by
// Postgres, so without the check the same request would succeed on one engine
// and fail as a 500 on the other.
func validCommunityName(name string) error {
	if name == "" || len(name) > maxCommunityNameBytes {
		return server.Errorf(server.CodeInvalidRequest, "name must be 1..%d bytes", maxCommunityNameBytes)
	}
	if !utf8.ValidString(name) {
		return server.Errorf(server.CodeInvalidRequest, "name is not UTF-8")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return server.Errorf(server.CodeInvalidRequest, "name contains a control character")
		}
	}
	return nil
}

func validMinAccountAge(v uint64) error {
	if v > maxMinAccountAgeSeconds {
		return server.Errorf(server.CodeInvalidRequest,
			"min_account_age_seconds is at most %d", maxMinAccountAgeSeconds)
	}
	return nil
}

func requireMod2FAFlag(v uint64) (uint8, error) {
	switch v {
	case 0:
		return 0, nil
	case 1:
		return 1, nil
	}
	return 0, server.Errorf(server.CodeInvalidRequest, "require_mod_2fa is 0 or 1")
}

// memberNick normalises a member nickname. R16: a nick is a display name, not a
// handle, so it takes auth.NormalizeDisplay's rules (free Unicode, NFC, at most
// 64 characters, no control or bidi character) rather than the ASCII handle
// rules. Every members row this package writes goes through it.
func memberNick(s string) (string, error) {
	out, err := auth.NormalizeDisplay(s)
	if err != nil {
		return "", server.Errorf(server.CodeInvalidRequest, "nick: %v", err)
	}
	return out, nil
}

// CommunityPolicy is the community policy document: communities.policy_json,
// a JSON object recorded in protocol/09 § Communities. Every key is optional
// and an absent key is its default, so `{}` is an open, unscreened community
// that keeps its history indefinitely. It is stored byte for byte as the owner
// wrote it; this type is how the instance reads it.
type CommunityPolicy struct {
	// Join is "open" (the default, also spelled by omission) or "invite".
	// Task 5 enforces "invite" on POST /v1/communities/{id}/join.
	Join string `json:"join"`
	// Screening is R17's membership-screening flag: stored and served, not
	// enforced by this version of the instance.
	Screening bool `json:"screening"`
	// RetentionDays is ARCHIVAL retention (R28, protocol/02 § Retention): how
	// long application messages every cursor has passed are kept. 0 means
	// indefinitely, the default.
	RetentionDays uint64 `json:"retention_days"`
	// DeliveryRetentionDays shortens DELIVERY retention, the window a device
	// that was away can still fetch in. 0 means the instance's own 30 days; a
	// community may shorten it and never lengthen it, because protocol/02
	// forbids a handshake window past 30 days.
	DeliveryRetentionDays uint64 `json:"delivery_retention_days"`
}

// The policy's two retention bounds, in days.
const (
	maxRetentionDays         = 36500 // a century: days * 86400 stays far inside an int64
	maxDeliveryRetentionDays = 30
)

// InviteOnly reports whether the community admits a join only with an invite.
func (p CommunityPolicy) InviteOnly() bool { return p.Join == "invite" }

// ParseCommunityPolicy decodes and validates a policy document. It refuses a
// document that is not bounded UTF-8 JSON, not exactly one object, carries a key
// this version does not know (a misspelt retention key silently ignored would
// keep history the owner asked to delete), or a value out of range. The error
// is a 400 E_INVALID_REQUEST.
func ParseCommunityPolicy(b []byte) (CommunityPolicy, error) {
	var p CommunityPolicy
	if len(b) > maxPolicyBytes {
		return p, server.Errorf(server.CodeInvalidRequest,
			"policy is %d bytes, at most %d", len(b), maxPolicyBytes)
	}
	if !utf8.Valid(b) {
		return p, server.Errorf(server.CodeInvalidRequest, "policy is not UTF-8")
	}
	trimmed := bytes.TrimLeft(b, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return p, server.Errorf(server.CodeInvalidRequest, "policy must be a JSON object")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return CommunityPolicy{}, server.Errorf(server.CodeInvalidRequest, "policy: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return CommunityPolicy{}, server.Errorf(server.CodeInvalidRequest,
			"policy must be exactly one JSON object")
	}
	switch p.Join {
	case "", "open", "invite":
	default:
		return CommunityPolicy{}, server.Errorf(server.CodeInvalidRequest,
			`policy join is "open" or "invite"`)
	}
	if p.RetentionDays > maxRetentionDays {
		return CommunityPolicy{}, server.Errorf(server.CodeInvalidRequest,
			"policy retention_days is at most %d", maxRetentionDays)
	}
	if p.DeliveryRetentionDays > maxDeliveryRetentionDays {
		return CommunityPolicy{}, server.Errorf(server.CodeInvalidRequest,
			"policy delivery_retention_days is at most %d: a community may shorten delivery retention, never lengthen it",
			maxDeliveryRetentionDays)
	}
	return p, nil
}
