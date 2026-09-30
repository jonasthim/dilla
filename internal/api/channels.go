package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"unicode"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Channel kinds, protocol/01 "Group kinds" for 0 and 1, interfaces.md §4.3 for
// the rest.
const (
	ChannelText     uint8 = 0
	ChannelVoice    uint8 = 1
	ChannelCategory uint8 = 2
	ChannelDM       uint8 = 3
	ChannelGroupDM  uint8 = 4
)

// Channel modes and visibilities, interfaces.md §4.3.
const (
	ModeE2EE     uint8 = 0
	ModeReadable uint8 = 1
)

const (
	VisPrivate      uint8 = 0
	VisInvite       uint8 = 1
	VisDiscoverable uint8 = 2
)

const (
	maxChannelNameBytes  = 100
	maxChannelTopicBytes = 1024
	maxSlowmodeSeconds   = 21600 // six hours
	// maxChannelPosition keeps a client's uint64 inside the signed column on
	// both engines: past 2^63 it would wrap negative in the adapter and sort
	// the channel in front of every other.
	maxChannelPosition = 1<<31 - 1
)

// TextGroupAllowed reports whether an MLS text group (protocol/01 kind 0) may be
// registered for this channel. The delivery service asks this question and
// answers 403 E_MODE_READABLE when it is false (interfaces.md §2.1).
func TextGroupAllowed(c store.ChannelRow) bool {
	if c.DeletedAt != nil {
		return false
	}
	switch c.Kind {
	case ChannelText, ChannelDM, ChannelGroupDM:
		return c.Mode == ModeE2EE
	default:
		return false
	}
}

// CallGroupAllowed reports whether a call group (kind 1) may be registered.
// protocol/01: "A call in any voice channel, including a voice channel of a
// community whose text channels are readable, always has a call group."
func CallGroupAllowed(c store.ChannelRow) bool {
	if c.DeletedAt != nil {
		return false
	}
	return c.Kind == ChannelVoice || c.Kind == ChannelDM || c.Kind == ChannelGroupDM
}

// Channels serves the channel routes of interfaces.md §5.2: create a channel in
// a community, read, patch and delete one. Every body is a fixed-position CBOR
// array (protocol/09 § Channels). Register mounts the handlers bare, as
// Communities does, and each handler requires an enrolled session itself.
// Every permission decision is the resolver's (perm.go).
type Channels struct {
	repo       store.Repository
	dsvc       DS
	clk        clock.Clock
	maxGroupDM int
	log        *slog.Logger
	res        *Resolver
}

// NewChannels takes the delivery service that closes a deleted channel's
// groups (membership.go) and brings a group DM's groups in line with its
// participants (SyncGroupMembers), and maxGroupDM, the cap NewDMs enforces at
// creation, which the member routes enforce on every add.
func NewChannels(repo store.Repository, dsvc DS, clk clock.Clock, maxGroupDM int, log *slog.Logger) *Channels {
	return &Channels{repo: repo, dsvc: dsvc, clk: clk, maxGroupDM: maxGroupDM, log: log, res: NewResolver(repo)}
}

func (c *Channels) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/communities/{id}/channels", c.create)
	mux.HandleFunc("GET /v1/channels/{id}", c.get)
	mux.HandleFunc("PATCH /v1/channels/{id}", c.patch)
	mux.HandleFunc("DELETE /v1/channels/{id}", c.delete)
}

// RegisterMembers registers the three channel-membership routes of §5.2. They are
// separate from Register because channel_members is task 6's table: a build of
// tasks 1-5 alone must not advertise a route with no storage behind it.
func (c *Channels) RegisterMembers(mux *server.Mux) {
	mux.HandleFunc("GET /v1/channels/{id}/members", c.members)
	mux.HandleFunc("PUT /v1/channels/{id}/members/{user_id}", c.addMember)
	mux.HandleFunc("DELETE /v1/channels/{id}/members/{user_id}", c.removeMember)
}

// members lists the channel's materialised membership, ordered by user id, one
// [user_id] row per member. On a community channel that is the set task 7
// derives from the resolver; on a DM or group DM it is the participant list,
// which is the only place it is stored.
func (c *Channels) members(w http.ResponseWriter, r *http.Request) {
	row, _, err := c.visible(r)
	if err != nil {
		c.fail(w, r, "list channel members", err)
		return
	}
	ids, err := c.repo.ListChannelMembers(r.Context(), row.ID)
	if err != nil {
		c.fail(w, r, "list channel members", err)
		return
	}
	out := make([][]id.ID, 0, len(ids))
	for _, u := range ids {
		out = append(out, []id.ID{u})
	}
	if err := server.EncodeBody(w, http.StatusOK, out); err != nil {
		c.log.Error("encode channel members", "err", err)
	}
}

// groupDM is visible restricted to a group DM, the one kind whose membership is
// written by hand, and the {user_id} the route names. A community channel's
// membership is derived from the permission resolver and is never written
// directly: a hand-written row would be overwritten by the next materialisation
// pass and the caller would never know. A 1:1 DM's pair is its id (P2-D31).
// Every participant may add and remove, because a group DM has no roles.
func (c *Channels) groupDM(r *http.Request) (store.ChannelRow, auth.Session, id.ID, error) {
	row, s, err := c.visible(r)
	if err != nil {
		return row, s, id.ID{}, err
	}
	if row.Kind != ChannelGroupDM {
		return row, s, id.ID{}, server.Errorf(server.CodeForbidden,
			"only a group DM's membership is set directly; a channel's follows its permissions")
	}
	target, err := server.PathID(r, "user_id")
	if err != nil {
		return row, s, id.ID{}, err
	}
	return row, s, target, nil
}

// addMember adds one participant to a group DM, then proposes the new
// participant's devices for the DM's text group.
func (c *Channels) addMember(w http.ResponseWriter, r *http.Request) {
	row, s, target, err := c.groupDM(r)
	if err != nil {
		c.fail(w, r, "add channel member", err)
		return
	}
	if err := mayReceiveDM(r.Context(), c.repo, target); err != nil {
		c.fail(w, r, "add channel member", err)
		return
	}
	now := c.clk.Now().Unix()
	// The count and the insert share one transaction, so two adds racing for
	// the last seat cannot both land on SQLite's single writer.
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		existing, err := tx.ListChannelMembers(r.Context(), row.ID)
		if err != nil {
			return err
		}
		if slices.Contains(existing, target) {
			return nil // already a participant: not growth, and not an error
		}
		if len(existing) >= c.maxGroupDM {
			return server.Errorf(server.CodeInvalidRequest,
				"a group DM holds at most %d members", c.maxGroupDM)
		}
		if err := tx.PutChannelMember(r.Context(), row.ID, target, now); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "channel.member.add", Target: row.ID.String(),
			Detail: target.String(), At: now,
		})
	}); err != nil {
		c.fail(w, r, "add channel member", err)
		return
	}
	// After the commit, never inside the transaction: SyncGroupMembers calls the
	// delivery service. See RemoveUserFromCommunityGroups on the single-writer
	// pool. A failure here leaves the row, and the next sync proposes the Adds.
	if err := SyncGroupMembers(r.Context(), c.repo, c.dsvc, row, now); err != nil {
		c.log.ErrorContext(r.Context(), "sync group members after add", "channel", row.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeMember is the mirror image: DeleteChannelMember, then SyncGroupMembers,
// which issues the Removes for every leaf the departing user held in the DM's
// text and call groups. A participant may always remove themself, and any
// participant may remove another.
func (c *Channels) removeMember(w http.ResponseWriter, r *http.Request) {
	row, s, target, err := c.groupDM(r)
	if err != nil {
		c.fail(w, r, "remove channel member", err)
		return
	}
	now := c.clk.Now().Unix()
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := tx.DeleteChannelMember(r.Context(), row.ID, target); err != nil {
			return notFound(err)
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "channel.member.remove", Target: row.ID.String(),
			Detail: target.String(), At: now,
		})
	}); err != nil {
		c.fail(w, r, "remove channel member", err)
		return
	}
	if err := SyncGroupMembers(r.Context(), c.repo, c.dsvc, row, now); err != nil {
		c.log.ErrorContext(r.Context(), "sync group members after remove", "channel", row.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

type createChannelReq struct {
	_               struct{} `cbor:",toarray"`
	Kind            uint64
	Mode            uint64
	Visibility      uint64
	ParentID        *id.ID
	Name            string
	Topic           string
	Position        uint64
	SlowmodeSeconds uint64
}

type createChannelResp struct {
	_          struct{} `cbor:",toarray"`
	ChannelID  id.ID
	Mode       uint64
	Visibility uint64
}

func (c *Channels) create(w http.ResponseWriter, r *http.Request) {
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
	var req createChannelReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	com, err := c.repo.GetCommunity(r.Context(), cid)
	if err != nil {
		c.fail(w, r, "create channel", notFound(err))
		return
	}
	if _, err := c.repo.GetMember(r.Context(), cid, s.UserID); err != nil {
		// A non-member must not learn that the community exists.
		c.fail(w, r, "create channel", notFound(err))
		return
	}
	// There is no channel yet, so there are no overwrites to apply: the
	// community-wide bits decide.
	snap, err := LoadSnapshot(r.Context(), c.repo, cid, s.UserID, nil)
	if err != nil {
		c.fail(w, r, "create channel", notFound(err))
		return
	}
	if !snap.Resolve(s.UserID).Has(PermManageChannels) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "manage channels"))
		return
	}
	// The three enums are checked as the client sent them, before they are
	// narrowed to a byte: 256 must not become 0.
	kind, err := enumByte(req.Kind, ChannelGroupDM, "kind must be 0..4")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	mode, err := enumByte(req.Mode, ModeReadable, "mode must be 0 or 1")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	visibility, err := enumByte(req.Visibility, VisDiscoverable, "visibility must be 0, 1 or 2")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	switch kind {
	case ChannelDM, ChannelGroupDM:
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"a DM is not created through a community"))
		return
	}
	row := store.ChannelRow{
		ID:                id.New(),
		CommunityID:       &cid,
		Kind:              kind,
		Mode:              mode,
		Visibility:        visibility,
		ParentID:          topLevelIfZero(req.ParentID),
		Name:              req.Name,
		Topic:             req.Topic,
		Position:          req.Position,
		SettingsJSON:      []byte("{}"),
		HostPolicyVersion: com.PolicyVersion,
		SlowmodeSeconds:   req.SlowmodeSeconds,
		Created:           c.clk.Now().Unix(),
	}
	// A visible channel is readable, and asking for e2ee is not an error: it is
	// how a client says "make this channel", and the label the user sees comes
	// from the stored mode. interfaces.md task 2: "forced to readable at
	// creation".
	if row.Visibility != VisPrivate {
		row.Mode = ModeReadable
	}
	// The parent is read and the row written in one transaction, so a category
	// deleted in between cannot end up with a live child.
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		if err := validChannel(r.Context(), tx, row); err != nil {
			return err
		}
		if err := tx.CreateChannel(r.Context(), row); err != nil {
			return err
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "channel.create", Target: row.ID.String(),
			Detail: cid.String(), At: row.Created,
		})
	}); err != nil {
		c.fail(w, r, "create channel", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusCreated, createChannelResp{
		ChannelID: row.ID, Mode: uint64(row.Mode), Visibility: uint64(row.Visibility),
	}); err != nil {
		c.log.Error("encode create channel", "err", err)
	}
}

// enumByte narrows one of the three channel enums from the uint64 the client
// sent, refusing a value above maxV with 400 E_INVALID_REQUEST and msg.
func enumByte(v uint64, maxV uint8, msg string) (uint8, error) {
	if v > uint64(maxV) {
		return 0, server.Errorf(server.CodeInvalidRequest, "%s", msg)
	}
	return uint8(v), nil //nolint:gosec // G115: v <= maxV, a uint8, on this line
}

// topLevelIfZero reads a parent_id: null or the all-zero id is "no parent".
// The all-zero id is how a PATCH moves a channel to the top level, since null
// there means "leave the parent alone".
func topLevelIfZero(p *id.ID) *id.ID {
	if p == nil || *p == (id.ID{}) {
		return nil
	}
	parent := *p
	return &parent
}

// validChannel holds every structural rule the engine also enforces, and the
// field bounds, so that the client gets a reason code instead of a constraint
// violation. repo is the transaction the write will run in.
func validChannel(ctx context.Context, repo store.Repository, row store.ChannelRow) error {
	bad := func(format string, a ...any) error {
		return server.Errorf(server.CodeInvalidRequest, format, a...)
	}
	switch row.Kind {
	case ChannelText, ChannelVoice, ChannelCategory, ChannelDM, ChannelGroupDM:
	default:
		return bad("kind must be 0..4")
	}
	if row.Mode > ModeReadable {
		return bad("mode must be 0 or 1")
	}
	if row.Visibility > VisDiscoverable {
		return bad("visibility must be 0, 1 or 2")
	}
	if row.Visibility != VisPrivate && row.Mode != ModeReadable {
		return bad("an invite-visible or discoverable channel is server-readable")
	}
	if err := validChannelText("name", row.Name, 1, maxChannelNameBytes, false); err != nil {
		return err
	}
	if err := validChannelText("topic", row.Topic, 0, maxChannelTopicBytes, true); err != nil {
		return err
	}
	if row.Position > maxChannelPosition {
		return bad("position must be at most %d", maxChannelPosition)
	}
	if row.SlowmodeSeconds > maxSlowmodeSeconds {
		return bad("slowmode_seconds must be at most %d", maxSlowmodeSeconds)
	}
	if row.Kind == ChannelCategory && row.ParentID != nil {
		return bad("a category has no parent")
	}
	if row.ParentID != nil {
		if *row.ParentID == row.ID {
			return bad("a channel is not its own parent")
		}
		parent, err := repo.GetChannel(ctx, *row.ParentID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return bad("parent_id names no live channel")
			}
			return err
		}
		if parent.Kind != ChannelCategory {
			return bad("parent_id must name a category")
		}
		if row.CommunityID == nil || parent.CommunityID == nil || *parent.CommunityID != *row.CommunityID {
			return bad("parent_id must name a category of the same community")
		}
	}
	return nil
}

// validChannelText bounds a channel's name or topic in bytes, requires UTF-8,
// and refuses control characters: a NUL is legal in a SQLite TEXT column and
// refused by Postgres, so without the check one request would succeed on one
// engine and fail as a 500 on the other. A topic may carry line breaks and tabs.
func validChannelText(field, s string, minBytes, maxBytes int, multiline bool) error {
	if len(s) < minBytes || len(s) > maxBytes {
		return server.Errorf(server.CodeInvalidRequest, "%s must be %d..%d bytes", field, minBytes, maxBytes)
	}
	if !utf8.ValidString(s) {
		return server.Errorf(server.CodeInvalidRequest, "%s is not UTF-8", field)
	}
	for _, r := range s {
		if multiline && (r == '\n' || r == '\t') {
			continue
		}
		if unicode.IsControl(r) {
			return server.Errorf(server.CodeInvalidRequest, "%s contains a control character", field)
		}
	}
	return nil
}

type patchChannelReq struct {
	_               struct{} `cbor:",toarray"`
	Name            *string
	Topic           *string
	Mode            *uint64
	Visibility      *uint64
	ParentID        *id.ID
	Position        *uint64
	SlowmodeSeconds *uint64
}

func (c *Channels) patch(w http.ResponseWriter, r *http.Request) {
	current, s, err := c.manageable(r)
	if err != nil {
		c.fail(w, r, "patch channel", err)
		return
	}
	var req patchChannelReq
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	// Mode and visibility may not move in the same request: whichever is applied
	// first decides whether the other is legal, so the outcome would depend on
	// the server's evaluation order rather than on what the operator asked for.
	if req.Mode != nil && req.Visibility != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"change mode and visibility in separate requests"))
		return
	}
	var mode, visibility *uint8
	if req.Mode != nil {
		m, err := enumByte(*req.Mode, ModeReadable, "mode must be 0 or 1")
		if err != nil {
			server.WriteError(w, err)
			return
		}
		mode = &m
	}
	if req.Visibility != nil {
		v, err := enumByte(*req.Visibility, VisDiscoverable, "visibility must be 0, 1 or 2")
		if err != nil {
			server.WriteError(w, err)
			return
		}
		visibility = &v
	}
	now := c.clk.Now().Unix()
	// The row is read again inside the transaction and the request applied to
	// that, so two concurrent PATCHes of different fields both land.
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		row, err := tx.GetChannel(r.Context(), current.ID)
		if err != nil {
			return notFound(err)
		}
		if req.Name != nil {
			row.Name = *req.Name
		}
		if req.Topic != nil {
			row.Topic = *req.Topic
		}
		if mode != nil {
			row.Mode = *mode
		}
		if visibility != nil {
			row.Visibility = *visibility
			if row.Visibility != VisPrivate {
				row.Mode = ModeReadable
			}
		}
		if req.ParentID != nil {
			row.ParentID = topLevelIfZero(req.ParentID)
		}
		if req.Position != nil {
			row.Position = *req.Position
		}
		if req.SlowmodeSeconds != nil {
			row.SlowmodeSeconds = *req.SlowmodeSeconds
		}
		if err := validChannel(r.Context(), tx, row); err != nil {
			return err
		}
		if err := tx.UpdateChannel(r.Context(), row); err != nil {
			return notFound(err)
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "channel.update", Target: row.ID.String(),
			Detail: row.Name, At: now,
		})
	}); err != nil {
		c.fail(w, r, "patch channel", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type channelResp struct {
	_               struct{} `cbor:",toarray"`
	ChannelID       id.ID
	CommunityID     *id.ID
	Kind            uint64
	Mode            uint64
	Visibility      uint64
	ParentID        *id.ID
	Name            string
	Topic           string
	Position        uint64
	SlowmodeSeconds uint64
	Seq             uint64
}

func (c *Channels) get(w http.ResponseWriter, r *http.Request) {
	row, _, err := c.visible(r)
	if err != nil {
		c.fail(w, r, "get channel", err)
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, channelResp{
		ChannelID: row.ID, CommunityID: row.CommunityID, Kind: uint64(row.Kind),
		Mode: uint64(row.Mode), Visibility: uint64(row.Visibility), ParentID: row.ParentID,
		Name: row.Name, Topic: row.Topic, Position: row.Position,
		SlowmodeSeconds: row.SlowmodeSeconds, Seq: row.Seq,
	}); err != nil {
		c.log.Error("encode channel", "err", err)
	}
}

func (c *Channels) delete(w http.ResponseWriter, r *http.Request) {
	row, s, err := c.manageable(r)
	if err != nil {
		c.fail(w, r, "delete channel", err)
		return
	}
	now := c.clk.Now().Unix()
	var toClose []id.ID
	if err := c.repo.Tx(r.Context(), func(tx store.Repository) error {
		// Read the channel's open groups inside the transaction; close them after it.
		var err error
		if toClose, err = openChannelGroups(r.Context(), tx, []id.ID{row.ID}); err != nil {
			return err
		}
		if err := tx.DeleteChannel(r.Context(), row.ID, now); err != nil {
			return notFound(err)
		}
		// A deleted category's channels stay, at the top level: the tombstone
		// keeps its row, so ON DELETE SET NULL never fires, and a child left
		// naming it could never be edited again (its parent is not live).
		if row.Kind == ChannelCategory && row.CommunityID != nil {
			siblings, err := tx.ListChannels(r.Context(), *row.CommunityID)
			if err != nil {
				return err
			}
			for _, child := range siblings {
				if child.ParentID == nil || *child.ParentID != row.ID {
					continue
				}
				child.ParentID = nil
				if err := tx.UpdateChannel(r.Context(), child); err != nil {
					return err
				}
			}
		}
		return tx.Audit(r.Context(), store.AuditRow{
			Actor: &s.UserID, Action: "channel.delete", Target: row.ID.String(),
			Detail: row.Name, At: now,
		})
	}); err != nil {
		c.fail(w, r, "delete channel", err)
		return
	}
	// The channel's MLS groups are closed by the delivery service, which owns
	// mls_groups, AFTER the commit: ds.Close writes through the single-connection
	// write pool the transaction held (see RemoveUserFromCommunityGroups). A
	// group left open by a crash here is bound to a deleted channel, which the
	// Add and join ACL refuses.
	if err := closeGroups(r.Context(), c.dsvc, toClose); err != nil {
		c.log.ErrorContext(r.Context(), "close the groups of a deleted channel",
			"channel", row.ID, "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// visible loads {id} for a caller who holds PermViewChannel in it. Anyone else,
// a non-member included, gets the 404 an unknown channel gets.
func (c *Channels) visible(r *http.Request) (store.ChannelRow, auth.Session, error) {
	s, err := enrolledSession(r)
	if err != nil {
		return store.ChannelRow{}, s, err
	}
	chID, err := server.PathID(r, "id")
	if err != nil {
		return store.ChannelRow{}, s, err
	}
	row, err := c.repo.GetChannel(r.Context(), chID)
	if err != nil {
		return store.ChannelRow{}, s, notFound(err)
	}
	// Require answers 404 to a non-member and to a member an overwrite has
	// taken the channel from: neither learns that it exists. For a DM or group
	// DM the members are its participants (channel_members), which is what
	// makes a 1:1 DM's derived id a name rather than a capability (P2-D31).
	if err := c.res.Require(r.Context(), s.UserID, row, PermViewChannel); err != nil {
		return store.ChannelRow{}, s, err
	}
	return row, s, nil
}

// manageable is visible plus PermManageChannels in that channel, overwrites
// applied.
func (c *Channels) manageable(r *http.Request) (store.ChannelRow, auth.Session, error) {
	row, s, err := c.visible(r)
	if err != nil {
		return row, s, err
	}
	if row.CommunityID == nil {
		return row, s, server.Errorf(server.CodeForbidden, "a DM has no manager")
	}
	if err := c.res.Require(r.Context(), s.UserID, row, PermManageChannels); err != nil {
		return row, s, err
	}
	return row, s, nil
}

// fail writes err as the client's refusal. Anything that is not a
// *server.Error is logged here and reaches the client as an empty E_INTERNAL.
func (c *Channels) fail(w http.ResponseWriter, r *http.Request, what string, err error) {
	var se *server.Error
	if !errors.As(err, &se) {
		c.log.ErrorContext(r.Context(), what, "err", err)
	}
	server.WriteError(w, err)
}
