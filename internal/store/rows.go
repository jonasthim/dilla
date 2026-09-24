package store

import "github.com/jonasthim/dilla/internal/id"

// Every Row mirrors its table's columns one for one, in declaration order
// (interfaces.md §4.1). Timestamps are int64 unix seconds; counters are uint64;
// identifiers are id.ID, or *id.ID when the column is nullable.

type InstanceRow struct {
	InstanceID          id.ID
	ExternalSenderKeyID id.ID
	KeyHistory          []byte
	FrankingKeyID       id.ID
	Generation          uint64
	PolicyVersion       uint64
	Created             int64
}

type UserRow struct {
	ID         id.ID
	Username   string
	Display    string
	Kind       uint8
	UMKPub     []byte
	SSKPub     []byte
	SigUMKSSK  []byte
	Flags      uint64
	AgeBracket uint64
	Created    int64
	DisabledAt *int64
	DeletedAt  *int64
}

// UserFlag bits, recorded in protocol/09-http-api.md § Flags (NV8).
const (
	UserFlagInstanceAdmin uint64 = 1 << 0
	UserFlagBotOperator   uint64 = 1 << 1
)

type DeviceRow struct {
	ID               id.ID
	UserID           id.ID
	DSKPub           []byte
	Tier             uint8
	SignerTier       uint8
	CredentialBlob   []byte
	VerifiedAt       *int64
	RevokedAt        *int64
	QuarantinedAt    *int64
	QuarantineReason string
	LastSeen         int64
	Created          int64
}

type DeviceListRow struct {
	UserID       id.ID
	Version      uint64
	Blob         []byte
	SSKSignature []byte
	PrevHash     []byte
	Created      int64
}

type SessionRow struct {
	TokenHash   []byte
	DeviceID    id.ID
	UserID      id.ID
	Scope       uint8
	Tier        uint8 // copied from devices.tier at issue time (deviation ID15)
	Created     int64
	Expires     int64
	IdleExpires int64
}

type TOTPRow struct {
	UserID      id.ID
	Secret      []byte
	Digits      uint64
	Period      uint64
	Algorithm   string
	ConfirmedAt *int64
	LastCounter int64
	Created     int64
}

type WebauthnCredentialRow struct {
	CredID            []byte
	RPID              string
	UserID            id.ID
	PublicKey         []byte
	SignCount         int64
	AttestationType   string
	AttestationFormat string
	Transports        string
	Flags             []byte
	ExtensionsJSON    string
	Name              string
	Created           int64
	LastUsed          *int64
}

type CeremonyRow struct {
	ID          id.ID
	Kind        uint8
	UserID      *id.ID
	SessionJSON string
	Created     int64
	Expires     int64
}

type LoginAttemptRow struct {
	UserID *id.ID
	IP     string
	Method uint8
	OK     bool
	At     int64
}

type InviteRow struct {
	ID          id.ID
	CodeHash    []byte
	CommunityID *id.ID
	CreatedBy   *id.ID
	GrantsAdmin uint8
	MaxUses     uint64
	UsedCount   uint64
	Created     int64
	ExpiresAt   int64
	RevokedAt   *int64
}

type ReportRow struct {
	ID                 id.ID
	Reporter           id.ID
	GroupID            id.ID
	Seq                uint64
	RevealedEnvelope   []byte
	KF                 []byte
	FrankingKeyID      id.ID
	VerificationResult string
	Status             int32
	Created            int64
}

type AuditRow struct {
	Actor  *id.ID
	Action string
	Target string
	Detail string
	At     int64
}

// BackupRow mirrors `backups` (interfaces.md §4.3), whose table is 008_blobs.sql
// and therefore Plan 2 task 10's to ship. It is declared here, ahead of its
// table, only because OpsBackups below names it and store.go must compile.
// DeviceID is NOT NULL with the all-zero id meaning "not device scoped"
// (Plan 2 P2-D32).
type BackupRow struct {
	UserID      id.ID
	Kind        uint64
	DeviceID    id.ID
	ChunkSeq    uint64
	BlobID      []byte
	ManifestSig []byte
	Created     int64
}

// Row types for the tables 1a does not create — GroupRow, HandshakeRow,
// ProposalRow, MemberRow, KeyPackageRow, WelcomePayloadRow, EpochTreeRow,
// WelcomeRow, WelcomeFull, ForkReportRow, AppMessageRow, CursorRow,
// CommunityRow, MemberOfCommunityRow, ChannelRow, RoleRow, OverwriteRow,
// BanRow, VoiceSessionRow, ReadableMessageRow and BlobRow — are declared by the
// task that ships their table (ID1), in this same file.
