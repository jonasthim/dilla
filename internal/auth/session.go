package auth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

type Scope uint8

const (
	ScopeEnrolled    Scope = 0
	ScopePending     Scope = 1
	ScopeProvisional Scope = 2
)

type Purpose uint8

const (
	PurposeSession     Purpose = 0
	PurposeRenew       Purpose = 1
	PurposeProvisional Purpose = 2
)

// domain is the 16-byte separator of the signature preimage. Its length is part
// of the format: the preimage is exactly 81 bytes and every field is at a fixed
// offset, so there is nothing to parse and nothing to confuse.
const domain = "dilla session v1"

const (
	nonceBytes = 32
	nonceTTL   = 60 * time.Second
	tokenBytes = 32

	// MaxPendingNonces caps the in-memory challenge map. The challenge route is
	// unauthenticated and answers identically for an unknown device, so any
	// caller can mint nonces for arbitrary 16-byte ids; sweeping only EXPIRED
	// entries leaves a steady-state size of (request rate x 60s) with no
	// ceiling, and the per-address bucket is defeated by a distributed caller
	// while the per-device bucket is keyed by an attacker-chosen id. At 56 bytes
	// a nonce entry this is about 6 MiB.
	MaxPendingNonces = 100_000
)

// TokenHash is what the sessions table stores for a bearer token: SHA-256 of
// the token's text (protocol/02 §2.2 point 3), so a database read never yields
// a credential. It is the one place the hash is spelled: minting, resolving and
// `dillad admin` (which finds a session by the token an operator was handed)
// all go through it.
func TokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// tierBrowser is `devices.tier` for a browser device; 0 is native. The schema's
// CHECK allows only these two.
const tierBrowser uint8 = 1

// SessionPreimage builds the 81 bytes a device signs:
//
//	"dilla session v1" || instance_id(16) || device_id(16) || nonce(32) || purpose(1)
func SessionPreimage(instanceID, deviceID id.ID, nonce []byte, p Purpose) []byte {
	out := make([]byte, 0, 81)
	out = append(out, domain...)
	out = append(out, instanceID[:]...)
	out = append(out, deviceID[:]...)
	out = append(out, nonce...)
	return append(out, byte(p))
}

type Token struct {
	Token       string
	Scope       Scope
	UserID      id.ID
	DeviceID    id.ID
	Expires     int64
	IdleExpires int64
	Generation  uint64
}

type EstablishRequest struct {
	DeviceID   id.ID
	Nonce      []byte
	Purpose    Purpose
	Sig        []byte
	Credential []byte
	// Login is an enrolment assertion from one of the six auth-ceremony routes.
	// When it is present the session is a `pending` one and the assertion is
	// spent here — this endpoint is the only thing that accepts one
	// (interfaces.md §5.1).
	Login []byte
	// Registration is read only with Login for a device without a row.
	Registration *DeviceRegistration
}

// AssertionSpender is what Sessions needs from the enrolment-assertion store.
// It is an interface, and the field holding it is nil-able, because the
// concrete type lives in internal/api (task 9) and internal/api imports
// internal/auth: taking the concrete type here would be an import cycle.
type AssertionSpender interface {
	Spend(token string) (userID id.ID, needsSecondFactor bool, ok bool)
}

// DeviceLister reads the newest verified device list through the delivery service.
type DeviceLister interface {
	// ListedDevices answers the unrevoked entries of the user's newest verified list.
	ListedDevices(ctx context.Context, userID id.ID) ([]ListedDevice, error)
}

// ListedDevice is one unrevoked entry of a user's newest verified device list: the
// (device_id, dsk_pub) pair the user's SSK signed. A device row is listed only when both its id
// and its key match one entry (security review F2): judged by the key alone, a row that copies a
// listed key under a new id would pass for listed, never expire, never be evicted, refuse the
// key-less DELETE and be unrevocable by the owner's client, which revokes list entries by id.
type ListedDevice struct {
	DeviceID id.ID
	DSKPub   []byte
}

// Listed reports whether the newest verified list names exactly this device: its id and its
// signing key in one unrevoked entry.
func Listed(entries []ListedDevice, deviceID id.ID, pub []byte) bool {
	for _, e := range entries {
		if e.DeviceID == deviceID && bytes.Equal(e.DSKPub, pub) {
			return true
		}
	}
	return false
}

// ErrNoDeviceList marks the no-list clause of protocol/02 device sessions.
var ErrNoDeviceList = errors.New("auth: the user has published no device list")

// DeviceRegistration is establish element 3 when login is present.
type DeviceRegistration struct {
	DeviceID         id.ID
	DSKPub           []byte
	Tier, SignerTier uint8
	Credential       []byte
}

// Session is a resolved bearer token.
type Session struct {
	UserID    id.ID
	DeviceID  id.ID
	Scope     Scope
	TokenHash []byte
	// PairingGroup is the one group a ScopeProvisional session may act on; it is nil for every
	// other scope (deviation B9). Without it nothing enforces E_PROVISIONAL_OUTSIDE_PAIRING and a
	// provisional session can harvest the Welcomes of every group its device was ever added to —
	// the escalation interfaces.md §2.2 point 4 forbids.
	//
	// TASK 24 ENFORCED THE RULE AND DID NOT ADD THE COLUMN. `DS.PublishKeyPackages`, `DS.Welcomes`
	// and `DS.AckWelcome` refuse a provisional session that reaches outside this field, and refuse
	// outright when it is nil — so the surface the three "E or V" routes open is closed from the
	// day they exist. What is still missing is the `sessions.pairing_group` column this would be
	// read from and the writer that sets it, which needs a migration on both engines and a pairing
	// flow to set it from; neither is in task 24's file list, and Plan 1 mints no provisional
	// session that names a group, so the field is nil for every session today and the delivery
	// service refuses accordingly. That is the FAIL-CLOSED end of the gap: a paired device cannot
	// yet collect its Welcome with a provisional session, and must be enrolled first.
	//
	// The column, the sqlc regeneration, `mint`/`Resolve` carrying the value and the pairing flow
	// that sets it are owed by an explicit task, recorded as plan deviation B27; until it lands,
	// rows 10, 15 and 16 are enrolled-only in practice.
	PairingGroup *id.ID
	Expires      int64
	IdleExpires  int64
}

// InPairingGroup reports whether this session may act on a group. An enrolled or admin session is
// unrestricted; a provisional session may act only inside the one group it was paired for, and a
// provisional session with no pairing group may act on nothing.
func (s Session) InPairingGroup(group id.ID) bool {
	if s.Scope != ScopeProvisional {
		return true
	}
	return s.PairingGroup != nil && *s.PairingGroup == group
}

type nonceEntry struct {
	device  id.ID
	expires time.Time
}

// Sessions issues and resolves device sessions. Nonces live in memory only:
// they are single-use, 60 seconds old at most, and writing them to the database
// would buy nothing but write amplification on the unauthenticated path.
type Sessions struct {
	repo       store.Repository
	clk        clock.Clock
	cfg        config.Session
	instanceID id.ID
	generation uint64

	// nonces holds the live challenges; order is the same keys in insertion
	// order, with head the index of the oldest one still worth looking at.
	//
	// The queue is not decoration. Every nonce is minted with the SAME 60-second
	// TTL from a monotonic clock, so insertion order IS expiry order: the sweep
	// and the eviction at the cap both only ever touch the front, and each
	// Challenge costs amortised O(1). Sweeping by iterating the whole map, as an
	// earlier draft of this file did, is O(len(nonces)) per Challenge, and the
	// map is allowed to hold MaxPendingNonces = 100 000 entries — a quadratic
	// cost on exactly the unauthenticated path the cap exists to protect.
	// An `order` entry whose key is no longer in the map was consumed by
	// takeNonce and is skipped.
	mu     sync.Mutex
	nonces map[string]nonceEntry
	order  []string
	head   int

	verifies atomic.Int64

	// Assertions is the enrolment-assertion store. It is set by dillad.New and
	// may be nil, in which case every request carrying a Login is refused
	// rather than quietly downgraded to an enrolled session.
	Assertions AssertionSpender
	// DeviceLists is set by the composition root. Nil fails every ordinary establish closed.
	DeviceLists DeviceLister

	// OnRevoke is called inside RevokeDevice/RevokeUser so the gateway closes
	// the device's connections in the same operation the rows are deleted.
	OnRevoke func(deviceID id.ID)
}

// NewSessions takes the instance generation because it is element 6 of every
// 201 from POST /v1/devices/{device_id}/sessions, and it must be the same number
// the X-Dilla-Generation header carries: a client that sees 0 in one and 3 in
// the other cannot tell a restore from a bug (R29, D12).
func NewSessions(repo store.Repository, clk clock.Clock, c config.Session, instanceID id.ID, generation uint64) *Sessions {
	return &Sessions{repo: repo, clk: clk, cfg: c, instanceID: instanceID,
		generation: generation, nonces: map[string]nonceEntry{}}
}

// PendingNonces is the number of live challenges, which one test uses to prove
// the map is capped.
func (s *Sessions) PendingNonces() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.nonces)
}

func (s *Sessions) InstanceID() id.ID { return s.instanceID }

// VerifyCount is the number of Ed25519 verifications performed, which one test
// uses to prove the nonce is consumed before the signature is checked.
func (s *Sessions) VerifyCount() int64 { return s.verifies.Load() }

// Challenge mints a nonce. The answer is identical for an unknown device, so
// the endpoint is not a device-enumeration oracle.
func (s *Sessions) Challenge(ctx context.Context, deviceID id.ID) ([]byte, int64, error) {
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return nil, 0, err
	}
	expires := s.clk.Now().Add(nonceTTL)
	s.mu.Lock()
	s.sweepNoncesLocked()
	for len(s.nonces) >= MaxPendingNonces && s.evictOldestNonceLocked() {
	}
	s.nonces[string(nonce)] = nonceEntry{device: deviceID, expires: expires}
	s.order = append(s.order, string(nonce))
	s.mu.Unlock()
	return nonce, expires.Unix(), nil
}

// evictOldestNonceLocked drops the oldest live challenge and reports whether it
// found one. The caller loops on that answer rather than on the map's size
// alone: an order queue and a map that ever disagreed would otherwise spin
// forever on the instance's unauthenticated path.
func (s *Sessions) evictOldestNonceLocked() bool {
	evicted := false
	for s.head < len(s.order) {
		k := s.order[s.head]
		s.head++
		if _, live := s.nonces[k]; live {
			delete(s.nonces, k)
			evicted = true
			break
		}
	}
	s.compactOrderLocked()
	return evicted
}

// takeNonce consumes a nonce. It runs BEFORE the signature check, so a replay
// costs a map lookup rather than an Ed25519 verification.
func (s *Sessions) takeNonce(nonce []byte, deviceID id.ID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.nonces[string(nonce)]
	if !ok {
		return false
	}
	delete(s.nonces, string(nonce))
	if entry.device != deviceID {
		return false
	}
	return !s.clk.Now().After(entry.expires)
}

// sweepNoncesLocked drops the expired and already-consumed entries at the front
// of the queue. It stops at the first live, unexpired one: everything behind it
// was minted later and therefore expires later.
func (s *Sessions) sweepNoncesLocked() {
	now := s.clk.Now()
	for s.head < len(s.order) {
		k := s.order[s.head]
		e, live := s.nonces[k]
		if live && !now.After(e.expires) {
			break
		}
		if live {
			delete(s.nonces, k)
		}
		s.head++
	}
	s.compactOrderLocked()
}

// compactOrderLocked reclaims the consumed prefix of the queue once it is at
// least half of it, which keeps the slice O(len(nonces)) without copying on
// every call.
func (s *Sessions) compactOrderLocked() {
	if s.head == 0 || s.head*2 < len(s.order) {
		return
	}
	s.order = append(s.order[:0], s.order[s.head:]...)
	s.head = 0
}

// ProveDeviceKey checks that the caller holds the private half of dskPub, the key a device row is
// about to be registered under, by the establish route's own proof: a nonce from
// POST /v1/devices/{device_id}/sessions/challenge for that device_id, consumed here, and an Ed25519
// signature by dskPub over SessionPreimage(instance_id, device_id, nonce, purpose 0) (security
// review F2). Without it POST /v1/devices took any dsk_pub, and a stolen enrolled session could
// plant rows under a key it does not hold. A nonce is single use, so a proof spent here cannot be
// replayed as an establish. It answers 403 E_FORBIDDEN: the caller's session is good, its claim
// on the key is not.
func (s *Sessions) ProveDeviceKey(deviceID id.ID, dskPub, nonce, sig []byte) error {
	refused := server.Errorf(server.CodeForbidden, "possession of dsk_pub is not proven")
	if len(dskPub) != ed25519.PublicKeySize || len(nonce) != nonceBytes || len(sig) != ed25519.SignatureSize {
		return refused
	}
	if !s.takeNonce(nonce, deviceID) {
		return refused
	}
	s.verifies.Add(1)
	if !ed25519.Verify(ed25519.PublicKey(dskPub), SessionPreimage(s.instanceID, deviceID, nonce, PurposeSession), sig) {
		return refused
	}
	return nil
}

func (s *Sessions) Establish(ctx context.Context, r EstablishRequest) (Token, error) {
	return s.issue(ctx, r)
}

// Renew is Establish behind the purpose check. Beyond that byte the two paths
// are deliberately identical: protocol/02 § Device sessions item 5 renews a
// session by establishing a new one against a fresh nonce, and the purpose is
// bound into the signature so a renew signature cannot be replayed as an
// establish.
func (s *Sessions) Renew(ctx context.Context, r EstablishRequest) (Token, error) {
	if r.Purpose != PurposeRenew {
		return Token{}, server.Errorf(server.CodeUnauthenticated, "renew requires purpose 1")
	}
	return s.issue(ctx, r)
}

// NewDeviceSession mints a session for a device created in the SAME
// transaction, which is the one carve-out from the proof-of-possession rule:
// protocol/02 § Device sessions item 7 and deviation ID18 —
// POST /v1/accounts registers the device's key and its first session together,
// so there is no prior key to prove possession of and no nonce the client could
// have asked for yet. Every later session for that device goes through
// Challenge and Establish.
//
// tx is the transaction the user, the device and the redeemed invite were
// written in, so a rolled-back registration leaves no session behind.
func (s *Sessions) NewDeviceSession(ctx context.Context, tx store.Repository, userID, deviceID id.ID, tier uint8) (Token, error) {
	return s.mint(ctx, tx, userID, deviceID, tier, ScopeEnrolled)
}

func (s *Sessions) issue(ctx context.Context, r EstablishRequest) (Token, error) {
	unauth := server.Errorf(server.CodeUnauthenticated, "")
	if len(r.Nonce) != nonceBytes || len(r.Sig) != ed25519.SignatureSize {
		return Token{}, unauth
	}
	if !s.takeNonce(r.Nonce, r.DeviceID) {
		return Token{}, unauth
	}
	device, err := s.repo.GetDevice(ctx, r.DeviceID)
	if errors.Is(err, store.ErrNotFound) && len(r.Login) > 0 {
		return s.register(ctx, r)
	}
	if err != nil {
		return Token{}, unauth
	}
	if device.RevokedAt != nil {
		return Token{}, unauth
	}
	// ed25519.Verify PANICS on a key that is not exactly 32 bytes.
	if len(device.DSKPub) != ed25519.PublicKeySize {
		return Token{}, unauth
	}
	pre := SessionPreimage(s.instanceID, r.DeviceID, r.Nonce, r.Purpose)
	s.verifies.Add(1)
	if !ed25519.Verify(ed25519.PublicKey(device.DSKPub), pre, r.Sig) {
		return Token{}, unauth
	}
	user, err := s.repo.GetUser(ctx, device.UserID)
	if err != nil {
		return Token{}, unauth
	}
	if user.DisabledAt != nil || user.DeletedAt != nil {
		return Token{}, server.Errorf(server.CodeForbidden, "account disabled")
	}
	if len(r.Login) > 0 && s.DeviceLists != nil && device.Created <= s.clk.Now().Unix()-86400 {
		entries, listErr := s.DeviceLists.ListedDevices(ctx, device.UserID)
		if listErr != nil && !errors.Is(listErr, ErrNoDeviceList) {
			return Token{}, ListError(listErr)
		}
		if listErr == nil {
			if !Listed(entries, device.ID, device.DSKPub) {
				if err := s.RevokeDevice(ctx, device.ID); err != nil {
					return Token{}, err
				}
				return Token{}, unauth
			}
		}
	}
	scope, err := s.scopeFor(ctx, r, device)
	if err != nil {
		return Token{}, err
	}
	var tok Token
	if err := s.repo.Tx(ctx, func(tx store.Repository) error {
		var err error
		tok, err = s.mint(ctx, tx, device.UserID, r.DeviceID, device.Tier, scope)
		return err
	}); err != nil {
		return Token{}, err
	}
	return tok, nil
}

// ListError maps a verified-list failure to the session/API refusal.
func ListError(err error) error {
	var abi *mlswasi.ABIError
	if errors.As(err, &abi) && abi.Code == "E_CREDENTIAL" {
		return server.Errorf(server.CodeUnauthenticated, "")
	}
	return server.Unavailable(1000, "device list unavailable")
}

func (s *Sessions) scopeFor(ctx context.Context, r EstablishRequest, device store.DeviceRow) (Scope, error) {
	unauth := server.Errorf(server.CodeUnauthenticated, "")
	if len(r.Login) > 0 {
		if s.Assertions == nil {
			return 0, unauth
		}
		user, second, ok := s.Assertions.Spend(string(r.Login))
		if !ok || second || user != device.UserID {
			return 0, unauth
		}
		return ScopePending, nil
	}
	if r.Purpose == PurposeProvisional {
		return ScopeProvisional, nil
	}
	if s.DeviceLists == nil {
		return 0, unauth
	}
	entries, err := s.DeviceLists.ListedDevices(ctx, device.UserID)
	if errors.Is(err, ErrNoDeviceList) {
		return ScopeEnrolled, nil
	}
	if err != nil {
		return 0, ListError(err)
	}
	if Listed(entries, device.ID, device.DSKPub) {
		return ScopeEnrolled, nil
	}
	if device.Created <= s.clk.Now().Unix()-86400 {
		if err := s.RevokeDevice(ctx, device.ID); err != nil {
			return 0, err
		}
		return 0, unauth
	}
	return ScopePending, nil
}

// register spends an assertion after shape and signature checks, then admits only a listed
// account's browser device. Past the cap or the hourly rate it replaces the oldest unlisted row
// (AdmitDevice) rather than refuse, so a password holder cannot lock out a recovering owner.
func (s *Sessions) register(ctx context.Context, r EstablishRequest) (Token, error) {
	unauth := server.Errorf(server.CodeUnauthenticated, "")
	if s.Assertions == nil {
		return Token{}, unauth
	}
	reg := r.Registration
	if reg == nil {
		return Token{}, server.Errorf(server.CodeInvalidRequest, "registration array required")
	}
	if reg.DeviceID != r.DeviceID {
		return Token{}, server.Errorf(server.CodeInvalidRequest, "device_id does not match")
	}
	if reg.Tier != 1 || reg.SignerTier != 1 {
		return Token{}, server.Errorf(server.CodeInvalidRequest, "assertion registration is for browser devices")
	}
	if len(reg.DSKPub) != 32 {
		return Token{}, server.Errorf(server.CodeInvalidRequest, "dsk_pub is 32 bytes")
	}
	s.verifies.Add(1)
	if !ed25519.Verify(reg.DSKPub, SessionPreimage(s.instanceID, r.DeviceID, r.Nonce, r.Purpose), r.Sig) {
		return Token{}, unauth
	}
	userID, second, ok := s.Assertions.Spend(string(r.Login))
	if !ok || second {
		return Token{}, unauth
	}
	user, err := s.repo.GetUser(ctx, userID)
	if err != nil {
		return Token{}, unauth
	}
	if user.DisabledAt != nil || user.DeletedAt != nil {
		return Token{}, server.Errorf(server.CodeForbidden, "account disabled")
	}
	if s.DeviceLists == nil {
		return Token{}, unauth
	}
	entries, err := s.DeviceLists.ListedDevices(ctx, userID)
	if errors.Is(err, ErrNoDeviceList) {
		return Token{}, unauth
	}
	if err != nil {
		return Token{}, ListError(err)
	}
	now := s.clk.Now().Unix()
	var tok Token
	var evicted id.ID
	err = s.repo.Tx(ctx, func(tx store.Repository) error {
		var err error
		evicted, err = s.AdmitDevice(ctx, tx, userID, entries, false, reg.DSKPub, now)
		if err != nil {
			return err
		}
		if err := tx.CreateDevice(ctx, store.DeviceRow{ID: r.DeviceID, UserID: userID, DSKPub: reg.DSKPub,
			Tier: 1, SignerTier: 1, CredentialBlob: reg.Credential, LastSeen: now, Created: now}); err != nil {
			if errors.Is(err, store.ErrConflict) {
				return server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest, "device_id already exists"))
			}
			return err
		}
		tok, err = s.mint(ctx, tx, userID, r.DeviceID, 1, ScopePending)
		return err
	})
	if err != nil {
		return Token{}, err
	}
	if !evicted.IsZero() && s.OnRevoke != nil {
		s.OnRevoke(evicted)
	}
	return tok, nil
}

// AdmitDevice applies the common device cap, expiry and hourly rate inside the
// caller's transaction. Neither the cap nor the rate refuses while an unlisted live
// row exists: past either, the oldest unlisted live row is evicted. Only a cap of
// listed rows refuses (403). The caller inserts its new row in that same
// transaction and closes any evicted device's gateway connections after commit.
func (s *Sessions) AdmitDevice(ctx context.Context, tx store.Repository, userID id.ID, entries []ListedDevice, noList bool, dskPub []byte, now int64) (id.ID, error) {
	if err := tx.LockUserForDeviceRegistration(ctx, userID); err != nil {
		return id.ID{}, err
	}
	rows, err := tx.ListDevicesByUser(ctx, userID)
	if err != nil {
		return id.ID{}, err
	}
	listed := make([]id.ID, 0, len(rows))
	for _, row := range rows {
		if noList || Listed(entries, row.ID, row.DSKPub) {
			listed = append(listed, row.ID)
		}
	}
	cutoff := now - 86399
	for _, row := range rows {
		if row.RevokedAt == nil && row.Created < cutoff && !slices.Contains(listed, row.ID) {
			if err := tx.RevokeDevice(ctx, row.ID, now); err != nil {
				return id.ID{}, err
			}
			if _, err := tx.DeleteSessionsByDevice(ctx, row.ID); err != nil {
				return id.ID{}, err
			}
		}
	}
	// One live row per signing key (security review F2): a second row under a key a live row of
	// the user already holds would share that row's proof of possession and, judged by key, its
	// listing. Rows the sweep above just revoked hold their key no longer.
	for _, row := range rows {
		expired := row.Created < cutoff && !slices.Contains(listed, row.ID)
		if row.RevokedAt == nil && !expired && bytes.Equal(row.DSKPub, dskPub) {
			return id.ID{}, server.WithStatus(http.StatusConflict,
				server.Errorf(server.CodeInvalidRequest, "dsk_pub is already registered to a live device"))
		}
	}
	live, err := tx.CountLiveDevicesByUser(ctx, userID)
	if err != nil {
		return id.ID{}, err
	}
	creations, err := tx.ListLiveDeviceCreationsSince(ctx, userID, listed, now-3599, cutoff)
	if err != nil {
		return id.ID{}, err
	}
	atCap := live >= int64(s.cfg.MaxDevicesPerUser)
	if !atCap && len(creations) < s.cfg.EnrolmentsPerHour {
		return id.ID{}, nil
	}
	// The cap and the hourly rate decide WHICH row this registration replaces, never WHETHER it is
	// admitted (security review F1): the oldest live unlisted row, whatever its age. At registration
	// the instance cannot tell the owner from a holder of the password alone — the recovery key that
	// tells them apart is used only after it — so a refusal that a password holder can keep
	// saturated (three logins an hour against the rate, or young unlisted rows against the cap) would
	// lock the owner's recovery out. The owner's own new row is exposed only for the seconds between
	// its registration and the list PUT that names it, at one password login per eviction, and the
	// per-address `login` and `establish` buckets bound that churn. The one refusal left is a cap of
	// rows every one of which the user's signed list names.
	var evicted id.ID
	var oldest int64
	for _, row := range rows {
		if row.RevokedAt == nil && row.Created >= cutoff && !slices.Contains(listed, row.ID) &&
			(evicted.IsZero() || row.Created < oldest || (row.Created == oldest && bytes.Compare(row.ID[:], evicted[:]) < 0)) {
			evicted, oldest = row.ID, row.Created
		}
	}
	if evicted.IsZero() {
		if atCap {
			return id.ID{}, server.Errorf(server.CodeForbidden, "device cap reached")
		}
		// Past the rate with every live row listed: nothing to replace, and an honest person
		// enrolling a fourth listed device in an hour is not refused.
		return id.ID{}, nil
	}
	if err := tx.RevokeDevice(ctx, evicted, now); err != nil {
		return id.ID{}, err
	}
	if _, err := tx.DeleteSessionsByDevice(ctx, evicted); err != nil {
		return id.ID{}, err
	}
	return evicted, nil
}

// mint writes one session row through tx and returns the bearer token. It is
// the single place a session's token, lifetime and idle window are decided, so
// the registration carve-out and the ordinary challenge path cannot drift.
func (s *Sessions) mint(ctx context.Context, tx store.Repository, userID, deviceID id.ID, tier uint8, scope Scope) (Token, error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return Token{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	sum := TokenHash(token)

	now := s.clk.Now()
	lifetime := s.cfg.NativeLifetime.Value()
	idle := lifetime
	if tier == tierBrowser {
		lifetime = s.cfg.BrowserLifetime.Value()
		idle = s.cfg.BrowserIdle.Value()
	}
	row := store.SessionRow{
		TokenHash: sum, DeviceID: deviceID, UserID: userID, Scope: uint8(scope),
		// The tier is carried on the session so Resolve can slide the idle
		// window by it without a second query (deviation ID15).
		Tier:    tier,
		Created: now.Unix(), Expires: now.Add(lifetime).Unix(), IdleExpires: now.Add(idle).Unix(),
	}
	n, err := tx.CountSessionsByDevice(ctx, deviceID)
	if err != nil {
		return Token{}, err
	}
	for ; n >= int64(s.cfg.MaxPerDevice); n-- {
		if err := tx.DeleteOldestSessionForDevice(ctx, deviceID); err != nil {
			return Token{}, err
		}
	}
	if err := tx.CreateSession(ctx, row); err != nil {
		return Token{}, err
	}
	return Token{
		Token: token, Scope: scope, UserID: userID, DeviceID: deviceID,
		Expires: row.Expires, IdleExpires: row.IdleExpires, Generation: s.generation,
	}, nil
}

// touchGranularity is how far, in seconds, Resolve lets a session's idle expiry lag behind its
// maximum before it writes the slide.
const touchGranularity = 60

// Resolve turns a bearer token into a session and slides its idle window.
func (s *Sessions) Resolve(ctx context.Context, bearer string) (Session, error) {
	if bearer == "" {
		return Session{}, server.Errorf(server.CodeUnauthenticated, "")
	}
	sum := TokenHash(bearer)
	now := s.clk.Now()
	row, err := s.repo.GetSessionByHash(ctx, sum, now.Unix())
	if err != nil {
		return Session{}, server.Errorf(server.CodeUnauthenticated, "")
	}
	// The lookup is by a unique index, so this compare is redundant today; it
	// stays so that a future non-unique index cannot reintroduce a timing side
	// channel without someone deleting this line on purpose.
	if subtle.ConstantTimeCompare(row.TokenHash, sum) != 1 {
		return Session{}, server.Errorf(server.CodeUnauthenticated, "")
	}
	if Scope(row.Scope) == ScopePending && s.DeviceLists != nil {
		device, err := s.repo.GetDevice(ctx, row.DeviceID)
		if err != nil || device.RevokedAt != nil {
			return Session{}, server.Errorf(server.CodeUnauthenticated, "")
		}
		if device.Created <= now.Unix()-86400 {
			entries, err := s.DeviceLists.ListedDevices(ctx, row.UserID)
			if err != nil && !errors.Is(err, ErrNoDeviceList) {
				return Session{}, ListError(err)
			}
			if err == nil && !Listed(entries, device.ID, device.DSKPub) {
				if err := s.RevokeDevice(ctx, device.ID); err != nil {
					return Session{}, err
				}
				return Session{}, server.Errorf(server.CodeUnauthenticated, "")
			}
		}
	}
	// The idle window follows the DEVICE TIER, exactly as issue() picks it, and
	// never the session scope: a browser device holds an ordinary `enrolled`
	// session, so keying on the scope would slide it 30 days on every request
	// and defeat protocol/02 § Device sessions item 5. The new value is clamped
	// to the session's hard expiry, so idle_expires can never run past expires.
	idle := s.cfg.NativeLifetime.Value()
	if row.Tier == tierBrowser {
		idle = s.cfg.BrowserIdle.Value()
	}
	idleExpires := now.Add(idle).Unix()
	if idleExpires > row.Expires {
		idleExpires = row.Expires
	}
	// One write per request would put every authenticated read on the single SQLite writer; the
	// window only has to move when it moves by more than touchGranularity, and an idle window
	// that is a minute short of its maximum is still hours or days long.
	if idleExpires-row.IdleExpires > touchGranularity {
		_ = s.repo.TouchSession(ctx, sum, idleExpires)
	} else {
		idleExpires = row.IdleExpires
	}
	return Session{
		UserID: row.UserID, DeviceID: row.DeviceID, Scope: Scope(row.Scope),
		TokenHash: row.TokenHash, Expires: row.Expires, IdleExpires: idleExpires,
	}, nil
}

func (s *Sessions) RevokeDevice(ctx context.Context, deviceID id.ID) error {
	if err := s.repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.RevokeDevice(ctx, deviceID, s.clk.Now().Unix()); err != nil {
			return err
		}
		_, err := tx.DeleteSessionsByDevice(ctx, deviceID)
		return err
	}); err != nil {
		return err
	}
	if s.OnRevoke != nil {
		s.OnRevoke(deviceID)
	}
	return nil
}

// DeleteDeviceSessions drops every session row of one device and closes its
// gateway connections, WITHOUT revoking the device: it is "log this device
// out", where RevokeDevice is "this device is no longer trusted". It returns
// how many session rows went.
//
// It exists so the two logout paths cannot drift. protocol/02 § Device sessions
// item 6 ties deleting session rows to closing the sockets those rows
// authenticated; a caller that reached store.DeleteSessionsByDevice directly
// would remove the HTTP credential and leave the gateway connection open.
func (s *Sessions) DeleteDeviceSessions(ctx context.Context, deviceID id.ID) (int64, error) {
	n, err := s.repo.DeleteSessionsByDevice(ctx, deviceID)
	if err != nil {
		return 0, err
	}
	if s.OnRevoke != nil {
		s.OnRevoke(deviceID)
	}
	return n, nil
}

func (s *Sessions) RevokeUser(ctx context.Context, userID id.ID) error {
	devices, err := s.repo.ListDevicesByUser(ctx, userID)
	if err != nil {
		return err
	}
	if err := s.repo.Tx(ctx, func(tx store.Repository) error {
		now := s.clk.Now().Unix()
		if err := tx.SetUserDisabled(ctx, userID, &now); err != nil {
			return err
		}
		_, err := tx.DeleteSessionsByUser(ctx, userID)
		return err
	}); err != nil {
		return err
	}
	if s.OnRevoke != nil {
		for _, d := range devices {
			s.OnRevoke(d.ID)
		}
	}
	return nil
}

type ctxKey struct{}

// Middleware resolves the bearer token and enforces the wanted scope.
func (s *Sessions) Middleware(next http.Handler, want Scope) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		sess, err := s.Resolve(r.Context(), bearer)
		if err != nil {
			server.WriteError(w, err)
			return
		}
		if sess.Scope != want && sess.Scope != ScopeEnrolled {
			server.WriteError(w, scopeRefusal(sess.Scope))
			return
		}
		if want == ScopeEnrolled && sess.Scope != ScopeEnrolled {
			server.WriteError(w, scopeRefusal(sess.Scope))
			return
		}
		next.ServeHTTP(w, r.WithContext(WithSession(r.Context(), sess)))
	})
}

// FromContext returns the session a Middleware put there. Parts 1b and 2 read
// the session through this, not through a server.SessionOf: internal/auth
// imports internal/server, so the reverse would be an import cycle (ID14).
func FromContext(ctx context.Context) (Session, bool) {
	s, ok := ctx.Value(ctxKey{}).(Session)
	return s, ok
}

// SessionFrom is FromContext under the name internal/api uses (interfaces.md
// §6.3). One of the two spellings had to win; both are kept so neither plan has
// to rewrite every handler.
func SessionFrom(ctx context.Context) (Session, bool) { return FromContext(ctx) }

// WithSession puts a session in a context. It is the exported setter a handler
// test needs to exercise a route without minting a bearer token first.
func WithSession(ctx context.Context, s Session) context.Context {
	return context.WithValue(ctx, ctxKey{}, s)
}

// scopeRefusal names the code protocol/02 § Device sessions item 4 fixes for a
// provisional session outside its pairing surface, and E_FORBIDDEN otherwise. A
// document that names a code the instance never emits is worse than no document.
func scopeRefusal(got Scope) *server.Error {
	if got == ScopeProvisional {
		return server.Errorf(server.CodeProvisionalOutsidePairing,
			"a provisional session reaches only its pairing group")
	}
	return server.Errorf(server.CodeForbidden, "session scope %d cannot reach this endpoint", got)
}
