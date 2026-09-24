package api_test

import (
	"net/http"
	"testing"

	"github.com/pquerna/otp/totp"

	"github.com/jonasthim/dilla/internal/cborx"
)

// The whole ceremony, both legs, on the real routes: register a discoverable
// credential and then log in with it, username-less.
//
// This is the first test in the task that reaches CreateCredential,
// ValidatePasskeyLogin and the store write-back at all. It is also the
// end-to-end check on the flag codec: validateLogin refuses a login whose
// BackupEligible flag differs from the STORED one (webauthn@v0.18.2
// webauthn/login.go:402-405), so the login below can only succeed if the BE bit
// flagBytes wrote is the bit flagsFromByte reads.
func TestAPasskeyRegistersAndThenLogsInWithoutAUsername(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	user, _, token := seedAPISession(t, deps)
	device := newVirtualAuthenticator(t, deps.Domain, true)

	credID := enrolPasskey(t, h, token, device)
	if len(credID) == 0 {
		t.Fatal("register/finish reported no credential id")
	}

	// The stored row is what a later login is validated against, so every
	// column FinishRegistration writes is worth an assertion here.
	stored, err := deps.Repo.GetWebauthnCredential(t.Context(), credID)
	if err != nil {
		t.Fatalf("GetWebauthnCredential: %v", err)
	}
	if stored.UserID != user.ID {
		t.Fatalf("the credential is owned by %s, want %s", stored.UserID, user.ID)
	}
	if stored.RPID != deps.Domain {
		t.Fatalf("rp_id = %q, want %q", stored.RPID, deps.Domain)
	}
	if stored.Transports != "internal,hybrid" {
		t.Fatalf("transports = %q, want the two the authenticator reported", stored.Transports)
	}
	if stored.AttestationFormat != "none" {
		t.Fatalf("attestation_format = %q, want %q", stored.AttestationFormat, "none")
	}
	if len(stored.Flags) != 1 || stored.Flags[0] == 0 {
		t.Fatalf("flags = %#v; the ceremony's UP/UV/BE/BS were not persisted", stored.Flags)
	}

	creds, err := deps.Passkeys.CredentialsForTest(t.Context(), user.ID)
	if err != nil {
		t.Fatalf("CredentialsForTest: %v", err)
	}
	if len(creds) != 1 {
		t.Fatalf("the account holds %d credentials, want 1", len(creds))
	}
	flags := creds[0].Flags
	if !flags.UserPresent || !flags.UserVerified || !flags.BackupEligible || !flags.BackupState {
		t.Fatalf("the stored flags read back as %+v, not the ones the authenticator set", flags)
	}

	assertion := passkeyLogin(t, h, device)
	got, needsSecondFactor := spendAssertion(t, deps, assertion)
	if got != user.ID {
		t.Fatalf("the passkey login named %s, want %s", got, user.ID)
	}
	// No second factor is enrolled on this account, so the passkey is the whole
	// login and the assertion is complete.
	if needsSecondFactor {
		t.Fatal("an account with no second factor was asked for one")
	}

	// The sign count the authenticator reported is written back; without it a
	// cloned authenticator could replay for ever undetected.
	after, err := deps.Repo.GetWebauthnCredential(t.Context(), credID)
	if err != nil {
		t.Fatalf("GetWebauthnCredential: %v", err)
	}
	if after.SignCount != 1 {
		t.Fatalf("sign_count = %d after one login, want 1", after.SignCount)
	}
}

// A passkey is not a licence to skip a confirmed TOTP.
//
// auth.webauthn.user_verification defaults to "preferred" (config/defaults.go),
// so `validateLogin`'s shouldVerifyUser is false and a ceremony that proves
// possession ONLY is accepted — which is exactly what the authenticator below
// performs. facts-auth.md §3.6: a passkey counts as two factors only when user
// verification actually happened, "the requirement is a request, the flag is
// the evidence". An account that confirmed TOTP is forced through
// /v1/auth/totp/verify on the password path, and the passkey path must not be
// the way around it.
//
// The route's response shape is untouched — protocol/09 gives it one element,
// [assertion], with no needs_totp — so this is asserted where the client feels
// it: the assertion the login hands back is one /v1/auth/totp/verify accepts.
func TestAPasskeyLoginDoesNotSkipAConfirmedTOTP(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	user, _, token := seedAPISession(t, deps)
	// A possession-only authenticator: UP set, UV clear.
	device := newVirtualAuthenticator(t, deps.Domain, false)
	enrolPasskey(t, h, token, device)
	secret, _ := enrolTOTP(t, h, deps, token)

	assertion := passkeyLogin(t, h, device)

	code, err := totp.GenerateCode(secret, deps.Clock.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	body, _ := cborx.Marshal([]any{assertion, code})
	res := postCBOR(h, "/v1/auth/totp/verify", body)
	if res.Code != http.StatusOK {
		t.Fatalf("totp/verify answered %d for a passkey assertion: the passkey login "+
			"skipped the account's confirmed second factor", res.Code)
	}
	var out []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode totp/verify: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("totp/verify returned %d elements, want [assertion]", len(out))
	}
	upgraded, ok := out[0].(string)
	if !ok || upgraded == "" {
		t.Fatalf("totp/verify assertion = %#v", out[0])
	}
	got, needsSecondFactor := spendAssertion(t, deps, upgraded)
	if got != user.ID {
		t.Fatalf("the upgraded assertion names %s, want %s", got, user.ID)
	}
	if needsSecondFactor {
		t.Fatal("the assertion still owes a second factor after totp/verify")
	}
}

// The same, one level down: the assertion the passkey route issues for an
// account with a confirmed TOTP is marked as owing a second factor. Asserted
// directly, so a regression names the cause rather than a 401 three routes
// later.
func TestAPasskeyAssertionOwesASecondFactorWhenTOTPIsConfirmed(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	user, _, token := seedAPISession(t, deps)
	device := newVirtualAuthenticator(t, deps.Domain, false)
	enrolPasskey(t, h, token, device)
	enrolTOTP(t, h, deps, token)

	got, needsSecondFactor := spendAssertion(t, deps, passkeyLogin(t, h, device))
	if got != user.ID {
		t.Fatalf("the passkey login named %s, want %s", got, user.ID)
	}
	if !needsSecondFactor {
		t.Fatal("a passkey login issued a complete assertion for an account with a confirmed TOTP")
	}
}
