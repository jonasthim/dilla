package api

// Bits is the permission vector stored in roles.allow / roles.deny and in
// channel_overwrites.allow / .deny. The values are fixed by this plan and
// recorded in protocol/09-http-api.md by task 3; they are never renumbered,
// because a stored role row is a number, not a name. Bits stop at 62 because
// Postgres stores allow/deny in a signed BIGINT. Task 3 adds the resolver and
// the masks to this file.
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
)

// Has reports whether every bit of want is set in b.
func (b Bits) Has(want Bits) bool { return b&want == want }
