package auth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// ceremonyTTL is how long a Begin* result is good for. Short, because the whole
// ceremony is one user gesture.
const ceremonyTTL = 5 * 60 // seconds

const (
	ceremonyRegister uint8 = 0
	ceremonyLogin    uint8 = 1
)

// ConfigFromDilla builds go-webauthn's config from dilla.toml.
//
// EncodeUserIDAsString stays false: its own doc warns that a user.id which is
// not base64url makes PublicKeyCredential.parseCreationOptionsFromJSON throw,
// and that a coincidentally-valid one decodes to DIFFERENT bytes with nothing
// reporting it.
func ConfigFromDilla(c config.WebAuthn) *webauthn.Config {
	return &webauthn.Config{
		RPID:                 c.RPID,
		RPDisplayName:        c.RPDisplayName,
		RPOrigins:            c.RPOrigins,
		EncodeUserIDAsString: false,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.UserVerificationRequirement(c.UserVerification),
		},
	}
}

// Passkeys runs the four WebAuthn ceremonies with the session stored
// server-side, keyed by an opaque ceremony id.
type Passkeys struct {
	wa   *webauthn.WebAuthn
	repo store.Repository
	clk  clock.Clock
	rpID string
}

func NewPasskeys(cfg *webauthn.Config, repo store.Repository, clk clock.Clock) (*Passkeys, error) {
	wa, err := webauthn.New(cfg)
	if err != nil {
		return nil, fmt.Errorf("auth: webauthn config: %w", err)
	}
	return &Passkeys{wa: wa, repo: repo, clk: clk, rpID: cfg.RPID}, nil
}

// dillaUser is go-webauthn's User over dilla's rows. There are exactly four
// methods: the rendered docs list a fifth, WebAuthnIcon, which the source at
// v0.18.2 does not have.
type dillaUser struct {
	handle  []byte
	name    string
	display string
	creds   []webauthn.Credential
}

func (u dillaUser) WebAuthnID() []byte                         { return u.handle }
func (u dillaUser) WebAuthnName() string                       { return u.name }
func (u dillaUser) WebAuthnDisplayName() string                { return u.display }
func (u dillaUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

var _ webauthn.User = dillaUser{}

// user loads the WebAuthn view of a dilla account, minting the 64-byte handle
// on first use. The handle is fresh random bytes, NOT the user id: the id is
// 16 bytes and is used elsewhere, and the spec's own advice is that the handle
// "uses the entire 64 bytes".
func (p *Passkeys) user(ctx context.Context, userID id.ID) (dillaUser, error) {
	row, err := p.repo.GetUser(ctx, userID)
	if err != nil {
		return dillaUser{}, err
	}
	handle, err := p.handle(ctx, userID)
	if err != nil {
		return dillaUser{}, err
	}
	creds, err := p.credentials(ctx, userID)
	if err != nil {
		return dillaUser{}, err
	}
	return dillaUser{handle: handle, name: row.Username, display: row.Display, creds: creds}, nil
}

// handle reads the account's WebAuthn user handle and mints one only when none
// exists. It MUST be idempotent: the authenticator stores the handle it saw at
// registration, and user() is called again by FinishRegistration and by
// FinishLogin's DiscoverableUserHandler, so a handle minted on every call would
// rotate the row out from under the authenticator and make
// GetWebauthnUserByHandle miss for ever. PutWebauthnUser's SQL is
// ON CONFLICT (rp_id, user_id) DO NOTHING for the same reason, so two
// concurrent ceremonies converge on the first handle rather than the last.
func (p *Passkeys) handle(ctx context.Context, userID id.ID) ([]byte, error) {
	existing, err := p.repo.GetWebauthnUserHandle(ctx, p.rpID, userID)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	fresh := make([]byte, 64)
	if _, err := rand.Read(fresh); err != nil {
		return nil, err
	}
	if err := p.repo.PutWebauthnUser(ctx, userID, p.rpID, fresh, p.clk.Now().Unix()); err != nil {
		return nil, err
	}
	// Re-read: a concurrent ceremony may have won the insert, and the handle the
	// authenticator will see is whichever one is in the row.
	return p.repo.GetWebauthnUserHandle(ctx, p.rpID, userID)
}

func (p *Passkeys) credentials(ctx context.Context, userID id.ID) ([]webauthn.Credential, error) {
	rows, err := p.repo.ListWebauthnCredentials(ctx, userID, p.rpID)
	if err != nil {
		return nil, err
	}
	out := make([]webauthn.Credential, 0, len(rows))
	for _, r := range rows {
		// Every stored column is round-tripped, not just the four the library
		// needs to verify a signature. CredentialFlags carries BackupEligible
		// ("This should NEVER change"), BackupState and the latched UserVerified
		// (webauthn@v0.18.2 webauthn/credential.go:446-465); validation cannot
		// enforce the BE-never-changes invariant against a record whose flags
		// are always zero. Extensions matter because
		// Config.ExtensionsUnsolicitedOutputPolicy defaults to reject.
		c := webauthn.Credential{
			ID:                r.CredID,
			PublicKey:         r.PublicKey,
			AttestationType:   r.AttestationType,
			AttestationFormat: r.AttestationFormat,
			Transport:         splitTransports(r.Transports),
			Flags:             flagsFromByte(r.Flags),
			Authenticator:     webauthn.Authenticator{SignCount: uint32(r.SignCount)}, //nolint:gosec // G115: the WebAuthn signature counter is a uint32 by the specification; the row stores it widened
		}
		if r.ExtensionsJSON != "" {
			if err := json.Unmarshal([]byte(r.ExtensionsJSON), &c.Extensions); err != nil {
				return nil, fmt.Errorf("auth: decode credential extensions: %w", err)
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// splitTransports is joinTransports' inverse.
func splitTransports(s string) []protocol.AuthenticatorTransport {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]protocol.AuthenticatorTransport, 0, len(parts))
	for _, p := range parts {
		out = append(out, protocol.AuthenticatorTransport(p))
	}
	return out
}

// flagsFromByte is flagBytes' inverse.
func flagsFromByte(b []byte) webauthn.CredentialFlags {
	if len(b) == 0 {
		return webauthn.CredentialFlags{}
	}
	return webauthn.CredentialFlags{
		UserPresent:    b[0]&(1<<0) != 0,
		UserVerified:   b[0]&(1<<1) != 0,
		BackupEligible: b[0]&(1<<2) != 0,
		BackupState:    b[0]&(1<<3) != 0,
	}
}

// storeSession persists SessionData as JSON. It is never sent to the client and
// the MessagePack codecs are never used on it.
func (p *Passkeys) storeSession(ctx context.Context, kind uint8, userID *id.ID, s *webauthn.SessionData) (id.ID, error) {
	body, err := json.Marshal(s)
	if err != nil {
		return id.ID{}, fmt.Errorf("auth: encode session: %w", err)
	}
	now := p.clk.Now().Unix()
	ceremonyID := id.New()
	row := store.CeremonyRow{
		ID: ceremonyID, Kind: kind, UserID: userID,
		SessionJSON: string(body), Created: now, Expires: now + ceremonyTTL,
	}
	if err := p.repo.PutCeremony(ctx, row); err != nil {
		return id.ID{}, err
	}
	return ceremonyID, nil
}

func (p *Passkeys) takeSession(ctx context.Context, ceremonyID id.ID, want uint8) (webauthn.SessionData, *id.ID, error) {
	row, err := p.repo.TakeCeremony(ctx, ceremonyID, p.clk.Now().Unix())
	if err != nil {
		return webauthn.SessionData{}, nil, err
	}
	if row.Kind != want {
		return webauthn.SessionData{}, nil, errors.New("auth: ceremony kind mismatch")
	}
	var s webauthn.SessionData
	if err := json.Unmarshal([]byte(row.SessionJSON), &s); err != nil {
		return webauthn.SessionData{}, nil, fmt.Errorf("auth: decode session: %w", err)
	}
	return s, row.UserID, nil
}

func (p *Passkeys) BeginRegistration(ctx context.Context, userID id.ID) (id.ID, []byte, error) {
	u, err := p.user(ctx, userID)
	if err != nil {
		return id.ID{}, nil, err
	}
	creation, session, err := p.wa.BeginRegistration(u)
	if err != nil {
		return id.ID{}, nil, fmt.Errorf("auth: begin registration: %w", err)
	}
	ceremonyID, err := p.storeSession(ctx, ceremonyRegister, &userID, session)
	if err != nil {
		return id.ID{}, nil, err
	}
	options, err := json.Marshal(creation)
	if err != nil {
		return id.ID{}, nil, err
	}
	return ceremonyID, options, nil
}

func (p *Passkeys) FinishRegistration(ctx context.Context, ceremonyID id.ID, response []byte) ([]byte, error) {
	session, userID, err := p.takeSession(ctx, ceremonyID, ceremonyRegister)
	if err != nil {
		return nil, err
	}
	if userID == nil {
		return nil, errors.New("auth: registration ceremony without a user")
	}
	u, err := p.user(ctx, *userID)
	if err != nil {
		return nil, err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBody(strings.NewReader(string(response)))
	if err != nil {
		return nil, fmt.Errorf("auth: parse registration response: %w", err)
	}
	cred, err := p.wa.CreateCredential(u, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("auth: create credential: %w", err)
	}
	extensions, err := marshalExtensions(cred.Extensions)
	if err != nil {
		return nil, err
	}
	now := p.clk.Now().Unix()
	row := store.WebauthnCredentialRow{
		CredID: cred.ID, RPID: p.rpID, UserID: *userID, PublicKey: cred.PublicKey,
		SignCount: int64(cred.Authenticator.SignCount), AttestationType: cred.AttestationType,
		AttestationFormat: cred.AttestationFormat, Transports: joinTransports(cred.Transport),
		Flags: flagBytes(cred.Flags), ExtensionsJSON: extensions, Created: now,
	}
	if err := p.repo.PutWebauthnCredential(ctx, row); err != nil {
		return nil, err
	}
	return cred.ID, nil
}

// marshalExtensions is credentials()' inverse: the curated CredentialExtensions
// struct as JSON, or "" when the authenticator reported nothing worth keeping.
// Writing "{}" instead would make every row carry an object the read path then
// has to decode for no result.
func marshalExtensions(e webauthn.CredentialExtensions) (string, error) {
	body, err := json.Marshal(e)
	if err != nil {
		return "", fmt.Errorf("auth: encode credential extensions: %w", err)
	}
	if string(body) == "{}" {
		return "", nil
	}
	return string(body), nil
}

func (p *Passkeys) BeginLogin(ctx context.Context) (id.ID, []byte, error) {
	assertion, session, err := p.wa.BeginDiscoverableLogin()
	if err != nil {
		return id.ID{}, nil, fmt.Errorf("auth: begin discoverable login: %w", err)
	}
	ceremonyID, err := p.storeSession(ctx, ceremonyLogin, nil, session)
	if err != nil {
		return id.ID{}, nil, err
	}
	options, err := json.Marshal(assertion)
	if err != nil {
		return id.ID{}, nil, err
	}
	return ceremonyID, options, nil
}

// FinishLogin uses ValidatePasskeyLogin, which hands back the resolved user as
// well as the credential, so dillad never has to ask for a handle first. The
// plain discoverable variant returns only the credential.
func (p *Passkeys) FinishLogin(ctx context.Context, ceremonyID id.ID, response []byte) (id.ID, error) {
	session, _, err := p.takeSession(ctx, ceremonyID, ceremonyLogin)
	if err != nil {
		return id.ID{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(strings.NewReader(string(response)))
	if err != nil {
		return id.ID{}, fmt.Errorf("auth: parse assertion: %w", err)
	}
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		userID, err := p.repo.GetWebauthnUserByHandle(ctx, p.rpID, userHandle)
		if err != nil {
			return nil, err
		}
		u, err := p.user(ctx, userID)
		if err != nil {
			return nil, err
		}
		return u, nil
	}
	_, cred, err := p.wa.ValidatePasskeyLogin(handler, session, parsed)
	if err != nil {
		return id.ID{}, fmt.Errorf("auth: validate passkey login: %w", err)
	}
	row, err := p.repo.GetWebauthnCredential(ctx, cred.ID)
	if err != nil {
		return id.ID{}, err
	}
	if row.RPID != p.rpID {
		return id.ID{}, errors.New("auth: credential belongs to another relying party")
	}
	if err := p.repo.UpdateWebauthnCredential(ctx, cred.ID, int64(cred.Authenticator.SignCount),
		flagBytes(cred.Flags), p.clk.Now().Unix()); err != nil {
		return id.ID{}, err
	}
	return row.UserID, nil
}

// PruneCeremonies drops expired rows. It is also what the upgrade path calls:
// SessionData.Extensions changes shape across go-webauthn releases, so
// in-flight ceremonies must be dropped on a version bump rather than carried.
func (p *Passkeys) PruneCeremonies(ctx context.Context) (int64, error) {
	return p.repo.PruneCeremonies(ctx, p.clk.Now().Unix())
}

// CredentialsForTest exposes the stored-to-library conversion so a test can
// assert the round trip. It reads nothing the ceremony paths do not already
// read, and it is the only exported seam in this file.
func (p *Passkeys) CredentialsForTest(ctx context.Context, userID id.ID) ([]webauthn.Credential, error) {
	return p.credentials(ctx, userID)
}

func joinTransports(ts []protocol.AuthenticatorTransport) string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, string(t))
	}
	return strings.Join(out, ",")
}

func flagBytes(f webauthn.CredentialFlags) []byte {
	var b byte
	if f.UserPresent {
		b |= 1 << 0
	}
	if f.UserVerified {
		b |= 1 << 1
	}
	if f.BackupEligible {
		b |= 1 << 2
	}
	if f.BackupState {
		b |= 1 << 3
	}
	return []byte{b}
}
