// Package store is dillad's one persistence contract: a hand-written repository
// over two generated query sets. Nothing above this package ever sees a *sql.DB,
// because sqlc's two DBTX interfaces do not unify (facts-storage §1.4).
package store

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/id"
)

var (
	ErrNotFound  = errors.New("store: not found")
	ErrConflict  = errors.New("store: conflict")  // unique violation, optimistic-lock miss
	ErrExhausted = errors.New("store: exhausted") // invite max_uses, quota
)

// Repository is what dillad persists through. Tx runs fn in one transaction and
// the Repository fn receives IS that transaction; nesting is an error. Close
// releases both pools.
//
// The embed list grows as the schema does, one named step per task (ID1):
// task 19 step 1a adds MLS with 00002_mls.sql, task 23 step 1a adds Messages and
// Cursors with 00003_messages.sql, Plan 2 task 1 step 9 adds Structure, and
// Plan 2's tasks 8 and 10 add Readable, Blobs and OpsBackups.
type Repository interface {
	Tx(ctx context.Context, fn func(Repository) error) error
	Close() error
	Instance
	Accounts
	Devices
	Sessions
	Auth
	Invites
	Ops
}

type Instance interface {
	GetInstance(ctx context.Context) (InstanceRow, error)
	CreateInstance(ctx context.Context, in InstanceRow) error
	BumpGeneration(ctx context.Context) (uint64, error)
	GetSetting(ctx context.Context, key string) ([]byte, error)
	// PutSetting carries its own timestamp: instance_settings.updated is
	// NOT NULL, and a repository with no clock has nothing to write there
	// (deviation ID11).
	PutSetting(ctx context.Context, key string, value []byte, updated int64) error
}

type Accounts interface {
	CreateUser(ctx context.Context, u UserRow) error
	GetUser(ctx context.Context, userID id.ID) (UserRow, error)
	GetUserByUsername(ctx context.Context, username string) (UserRow, error)
	ListUsers(ctx context.Context, after id.ID, limit int32) ([]UserRow, error)
	SetUserDisabled(ctx context.Context, userID id.ID, at *int64) error
	TombstoneUser(ctx context.Context, userID id.ID, at int64) error // keeps username (R36)
}

type Devices interface {
	CreateDevice(ctx context.Context, d DeviceRow) error
	GetDevice(ctx context.Context, deviceID id.ID) (DeviceRow, error)
	ListDevicesByUser(ctx context.Context, userID id.ID) ([]DeviceRow, error)
	TouchDevice(ctx context.Context, deviceID id.ID, lastSeen int64) error
	RevokeDevice(ctx context.Context, deviceID id.ID, at int64) error
	PutDeviceList(ctx context.Context, l DeviceListRow) error
	GetDeviceList(ctx context.Context, userID id.ID) (DeviceListRow, error)
}

type Sessions interface {
	CreateSession(ctx context.Context, s SessionRow) error
	GetSessionByHash(ctx context.Context, tokenHash []byte, now int64) (SessionRow, error)
	TouchSession(ctx context.Context, tokenHash []byte, idleExpires int64) error
	DeleteSession(ctx context.Context, tokenHash []byte) error
	DeleteSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error)
	DeleteSessionsByUser(ctx context.Context, userID id.ID) (int64, error)
	CountSessionsByDevice(ctx context.Context, deviceID id.ID) (int64, error)
	DeleteOldestSessionForDevice(ctx context.Context, deviceID id.ID) error
	PruneSessions(ctx context.Context, now int64) (int64, error)
}

type Auth interface {
	PutPasswordCredential(ctx context.Context, userID id.ID, phc string, updated int64) error
	GetPasswordCredential(ctx context.Context, userID id.ID) (string, error)
	PutTOTP(ctx context.Context, t TOTPRow) error
	GetTOTP(ctx context.Context, userID id.ID) (TOTPRow, error)
	ConsumeTOTPCounter(ctx context.Context, userID id.ID, counter int64) error
	PutRecoveryCodes(ctx context.Context, userID id.ID, hashes [][]byte, created int64) error
	ConsumeRecoveryCode(ctx context.Context, userID id.ID, hash []byte, at int64) error
	CountRecoveryCodes(ctx context.Context, userID id.ID) (int64, error)
	// PutWebauthnUser is INSERT ... ON CONFLICT (rp_id, user_id) DO NOTHING: a
	// handle is minted once and never rotated, because the authenticator keeps
	// the handle it saw at registration and a rotation makes discoverable login
	// impossible for that account. GetWebauthnUserHandle is the read that makes
	// minting idempotent (deviation ID11).
	PutWebauthnUser(ctx context.Context, userID id.ID, rpID string, handle []byte, created int64) error
	GetWebauthnUserHandle(ctx context.Context, rpID string, userID id.ID) ([]byte, error)
	GetWebauthnUserByHandle(ctx context.Context, rpID string, handle []byte) (id.ID, error)
	PutWebauthnCredential(ctx context.Context, c WebauthnCredentialRow) error
	ListWebauthnCredentials(ctx context.Context, userID id.ID, rpID string) ([]WebauthnCredentialRow, error)
	GetWebauthnCredential(ctx context.Context, credID []byte) (WebauthnCredentialRow, error)
	UpdateWebauthnCredential(ctx context.Context, credID []byte, signCount int64, flags []byte, lastUsed int64) error
	PutCeremony(ctx context.Context, c CeremonyRow) error
	TakeCeremony(ctx context.Context, ceremonyID id.ID, now int64) (CeremonyRow, error) // single use
	PruneCeremonies(ctx context.Context, now int64) (int64, error)
	PutOIDCIdentity(ctx context.Context, issuer, subject string, userID id.ID, created int64) error
	GetOIDCIdentity(ctx context.Context, issuer, subject string) (id.ID, error)
	RecordLoginAttempt(ctx context.Context, a LoginAttemptRow) error
	CountLoginFailures(ctx context.Context, userID id.ID, since int64) (int64, error)
	ClearLoginFailures(ctx context.Context, userID id.ID) error
}

type Invites interface {
	CreateInvite(ctx context.Context, i InviteRow) error
	GetInviteByHash(ctx context.Context, codeHash []byte) (InviteRow, error)
	// RedeemInvite: one UPDATE guarded by used_count < max_uses AND revoked_at IS NULL
	// AND expires_at > now; ErrExhausted unless RowsAffected == 1.
	RedeemInvite(ctx context.Context, codeHash []byte, now int64) (InviteRow, error)
	RevokeInvite(ctx context.Context, inviteID id.ID, at int64) error
	ListInvites(ctx context.Context, communityID *id.ID) ([]InviteRow, error)
}

type Ops interface {
	PutReport(ctx context.Context, r ReportRow) error
	GetReport(ctx context.Context, reportID id.ID) (ReportRow, error)
	UpdateReportStatus(ctx context.Context, reportID id.ID, status int32, result string) error
	Audit(ctx context.Context, a AuditRow) error
	ListAudit(ctx context.Context, since int64, limit int32) ([]AuditRow, error)
	SchemaVersion(ctx context.Context) (int64, error)
}

// OpsBackups is §4.1's backup half of Ops. Its table is 008_blobs.sql, so
// Plan 2 task 10 implements it and adds it to Repository (deviation ID2).
type OpsBackups interface {
	PutBackup(ctx context.Context, b BackupRow) error
	ListBackups(ctx context.Context, userID id.ID, kind int32) ([]BackupRow, error)
}

// The remaining six sub-interfaces of §4.1 — MLS, Messages, Cursors, Structure,
// Readable (with ReadableSearch, ReadableSearchQuery and ReadableSearchHit) and
// Blobs — are declared by the task that ships their tables and their Row types,
// in this same file: task 19 (MLS), task 23 (Messages, Cursors) and Plan 2's
// tasks 1, 8 and 10 (Structure, Readable, Blobs). Declaring them here is not
// possible: each names Row types this plan's schema does not yet define, and
// ReadableSearchQuery additionally names ParsedQuery, a type Plan 2's search
// task introduces — so a verbatim declaration now would not compile, and ID1's
// own rule is that `go build ./...` is green at the end of every task. The
// method names are fixed by interfaces.md §4.1 either way, so no later task
// invents one.
