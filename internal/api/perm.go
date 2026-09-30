package api

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"slices"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// Bits is the permission vector stored in roles.allow / roles.deny and in
// channel_overwrites.allow / .deny. The values are fixed by this plan and
// recorded in protocol/09-http-api.md § Permissions; they are never renumbered,
// because a stored role row is a number, not a name. Bits stop at 62 because
// Postgres stores allow/deny in a signed BIGINT.
type Bits uint64

const (
	PermViewChannel     Bits = 1 << 0
	PermSendMessages    Bits = 1 << 1
	PermManageMessages  Bits = 1 << 2
	PermPinMessages     Bits = 1 << 3
	PermAttachFiles     Bits = 1 << 4
	PermAddReactions    Bits = 1 << 5
	PermReadHistory     Bits = 1 << 6
	PermConnect         Bits = 1 << 7
	PermSpeak           Bits = 1 << 8
	PermVideo           Bits = 1 << 9
	PermScreenShare     Bits = 1 << 10
	PermCreateInvite    Bits = 1 << 11
	PermKickMembers     Bits = 1 << 12
	PermBanMembers      Bits = 1 << 13
	PermManageChannels  Bits = 1 << 14
	PermManageRoles     Bits = 1 << 15
	PermManageCommunity Bits = 1 << 16
	PermViewAuditLog    Bits = 1 << 17
	PermMentionEveryone Bits = 1 << 18
	PermBypassSlowmode  Bits = 1 << 19
	PermAdministrator   Bits = 1 << 20
	PermMuteMembers     Bits = 1 << 21
	PermMoveMembers     Bits = 1 << 22
	PermManageNicknames Bits = 1 << 23

	// PermAll is every defined bit. A stored value is masked with it on read, so
	// a bit written by a newer binary is ignored rather than silently granted.
	PermAll = PermViewChannel | PermSendMessages | PermManageMessages | PermPinMessages |
		PermAttachFiles | PermAddReactions | PermReadHistory | PermConnect | PermSpeak |
		PermVideo | PermScreenShare | PermCreateInvite | PermKickMembers | PermBanMembers |
		PermManageChannels | PermManageRoles | PermManageCommunity | PermViewAuditLog |
		PermMentionEveryone | PermBypassSlowmode | PermAdministrator | PermMuteMembers |
		PermMoveMembers | PermManageNicknames

	// communityBits are the permissions a channel overwrite may not touch: they
	// are about the community, not about one channel, so an overwrite that
	// removed them would silently disarm moderation in the one channel a
	// troll controls.
	communityBits = PermKickMembers | PermBanMembers | PermManageCommunity |
		PermManageRoles | PermViewAuditLog | PermAdministrator | PermManageNicknames
)

// Has reports whether every bit of want is set in b.
func (b Bits) Has(want Bits) bool { return b&want == want }

// Snapshot is everything the resolver reads, loaded once per request.
//
// Roles must be ordered by (position, id). Resolve sorts defensively rather than
// trusting the caller, because EligibleUsers (task 7) and the tests build a
// Snapshot by hand and an unsorted slice silently inverts the deny/allow
// precedence the whole permission model rests on.
type Snapshot struct {
	Owner     id.ID
	Everyone  id.ID           // the community's @everyone role; held by every member
	Roles     []store.RoleRow // ordered by (position, id); @everyone sorts first
	Held      map[id.ID]bool  // role ids this user was explicitly granted
	Overwrite []store.OverwriteRow
}

// byPositionThenID is the one ordering of roles. LoadSnapshot, Resolve and the
// test fixture all use it, so "the roles are sorted" is a property of the type
// rather than of one loader.
func byPositionThenID(a, b store.RoleRow) int {
	if c := cmp.Compare(a.Position, b.Position); c != 0 {
		return c
	}
	return bytes.Compare(a.ID[:], b.ID[:])
}

// holds reports whether userID's snapshot applies role r: the community's
// @everyone role applies to every member by IDENTITY, every other role only when
// explicitly granted.
//
// Identity, not position: keying on `r.Position == 0` would let any holder of
// PermManageRoles move a role to position 0 and hand its bits — PermAdministrator
// included — to the whole community. The role routes additionally refuse
// position == 0 on both create and patch, so the set of position-0 roles is
// fixed at community creation and s.Everyone is unambiguous.
func (s Snapshot) holds(r store.RoleRow) bool {
	return r.ID == s.Everyone || s.Held[r.ID]
}

// Resolve returns the community-wide permissions of userID: the owner
// short-circuit, then @everyone, then each held role in ascending position with
// deny applied before allow.
func (s Snapshot) Resolve(userID id.ID) Bits {
	if userID == s.Owner {
		return PermAll
	}
	if !slices.IsSortedFunc(s.Roles, byPositionThenID) {
		slices.SortFunc(s.Roles, byPositionThenID)
	}
	var bits Bits
	for _, r := range s.Roles {
		if !s.holds(r) {
			continue
		}
		bits &^= Bits(r.Deny) & PermAll
		bits |= Bits(r.Allow) & PermAll
	}
	if bits.Has(PermAdministrator) {
		return PermAll
	}
	if !bits.Has(PermViewChannel) {
		return 0
	}
	return bits
}

// ResolveChannel applies the channel's overwrites on top of Resolve: every role
// overwrite the user's roles match, in ascending role position, then the user's
// own overwrite. Community-scoped bits are restored afterwards, and a user who
// cannot view the channel holds nothing in it.
func (s Snapshot) ResolveChannel(userID id.ID) Bits {
	base := s.Resolve(userID)
	if base == PermAll || base == 0 {
		return base
	}
	bits := base
	for _, r := range s.Roles {
		if !s.holds(r) {
			continue
		}
		for _, o := range s.Overwrite {
			if o.TargetKind != 0 || o.TargetID != r.ID {
				continue
			}
			bits &^= Bits(o.Deny) & PermAll
			bits |= Bits(o.Allow) & PermAll
		}
	}
	for _, o := range s.Overwrite {
		if o.TargetKind != 1 || o.TargetID != userID {
			continue
		}
		bits &^= Bits(o.Deny) & PermAll
		bits |= Bits(o.Allow) & PermAll
	}
	// Community-scoped bits are restored from the base: a channel overwrite can
	// neither grant nor remove them. PermAdministrator is one of them, so an
	// overwrite cannot mint a channel-scoped administrator — which would be a
	// channel-scoped escalation to PermAll.
	bits = (bits &^ communityBits) | (base & communityBits)
	if bits.Has(PermAdministrator) {
		return PermAll
	}
	if !bits.Has(PermViewChannel) {
		return 0
	}
	return bits
}

// Highest returns the position of the user's highest held role, and false when
// the user holds only @everyone. It is what bounds a role grant, create, patch
// and delete: the owner is above every role.
func (s Snapshot) Highest(userID id.ID) (uint64, bool) {
	if userID == s.Owner {
		return ^uint64(0), true
	}
	var top uint64
	var found bool
	for _, r := range s.Roles {
		if r.ID != s.Everyone && s.Held[r.ID] && r.Position >= top {
			top, found = r.Position, true
		}
	}
	return top, found
}

// LoadSnapshot reads the community, its roles, the user's role grants and, when
// channelID is non-nil, that channel's overwrites: four queries, never N+1.
// store.ErrNotFound means the community is unknown or deleted.
func LoadSnapshot(ctx context.Context, repo store.Repository, communityID, userID id.ID, channelID *id.ID) (Snapshot, error) {
	com, err := repo.GetCommunity(ctx, communityID)
	if err != nil {
		return Snapshot{}, err
	}
	roles, err := repo.ListRoles(ctx, communityID)
	if err != nil {
		return Snapshot{}, err
	}
	slices.SortFunc(roles, byPositionThenID)
	held, err := repo.ListMemberRoles(ctx, communityID, userID)
	if err != nil {
		return Snapshot{}, err
	}
	s := Snapshot{Owner: com.Owner, Roles: roles, Held: make(map[id.ID]bool, len(held))}
	// @everyone is the role created with the community; it is the only role ever
	// stored at position 0 (the role routes refuse position 0 on create and on
	// patch), and the sort above puts it first.
	if len(roles) > 0 && roles[0].Position == 0 {
		s.Everyone = roles[0].ID
	}
	for _, r := range held {
		s.Held[r] = true
	}
	if channelID != nil {
		if s.Overwrite, err = repo.ListOverwrites(ctx, *channelID); err != nil {
			return Snapshot{}, err
		}
	}
	return s, nil
}

// Resolver is the request-scoped front end handlers use. It is the one place a
// channel permission is decided: every later permission check calls it.
type Resolver struct{ repo store.Repository }

func NewResolver(repo store.Repository) *Resolver { return &Resolver{repo: repo} }

// Resolve answers for one channel. A user who is not a member of the channel's
// community holds nothing, and so does anyone once the community is deleted.
//
// A DM or group DM has no community and no roles; its participants are
// channel_members, which Plan 2 task 6 creates. Until then nobody holds anything
// in one, which is the conservative answer and matches Channels.visible, not a
// permanent one: task 6 answers a participant here with the fixed DM set (view,
// send, attach, react, read history, pin, connect, speak, video, screen share).
func (r *Resolver) Resolve(ctx context.Context, userID id.ID, ch store.ChannelRow) (Bits, error) {
	if ch.CommunityID == nil {
		return 0, nil
	}
	if _, err := r.repo.GetMember(ctx, *ch.CommunityID, userID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return 0, nil // not a member: no permissions, and Require answers 404
		}
		// A closed pool, a cancelled context or a disk error is NOT an
		// authorisation decision; returning 0 here would turn a transient fault
		// into a silent 404 with no log line and no metric.
		return 0, err
	}
	s, err := LoadSnapshot(ctx, r.repo, *ch.CommunityID, userID, &ch.ID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, nil // the community was deleted under us
	}
	if err != nil {
		return 0, err
	}
	return s.ResolveChannel(userID), nil
}

// Require is the one-line form handlers use: nil when userID holds every bit of
// want in ch, 404 E_NOT_FOUND when they cannot even view it (never confirm that
// a channel the caller cannot see exists), and 403 E_FORBIDDEN otherwise.
func (r *Resolver) Require(ctx context.Context, userID id.ID, ch store.ChannelRow, want Bits) error {
	got, err := r.Resolve(ctx, userID, ch)
	if err != nil {
		return err
	}
	if !got.Has(want) {
		if !got.Has(PermViewChannel) {
			return server.Errorf(server.CodeNotFound, "no such object")
		}
		return server.Errorf(server.CodeForbidden, "missing permission")
	}
	return nil
}
