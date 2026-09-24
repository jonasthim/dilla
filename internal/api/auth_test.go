package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/pquerna/otp/totp"
)

// seedPassword gives a seeded user a password credential, hashed with the same
// testHasher the Deps carries, and returns the plaintext.
func seedPassword(t *testing.T, d api.Deps, u store.UserRow, pw string) string {
	t.Helper()
	phc, err := d.Hasher.Hash(context.Background(), pw)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	if err := d.Repo.PutPasswordCredential(context.Background(), u.ID, phc, d.Clock.Now().Unix()); err != nil {
		t.Fatalf("PutPasswordCredential: %v", err)
	}
	return pw
}

// login posts the password login and returns the status and the decoded body.
func login(t *testing.T, h http.Handler, username, pw string) (int, []any) {
	t.Helper()
	body, err := cborx.Marshal([]any{username, pw})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res := postCBOR(h, "/v1/auth/password/login", body)
	var out []any
	if res.Code == http.StatusOK {
		if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode login body: %v", err)
		}
	}
	return res.Code, out
}

// enrolTOTP walks the two enrolled routes and returns the base32 secret and the
// recovery codes the confirm hands back.
func enrolTOTP(t *testing.T, h http.Handler, d api.Deps, token string) (string, []string) {
	t.Helper()
	body, _ := cborx.Marshal([]any{})
	res := postCBORAuth(h, "/v1/auth/totp/enroll", body, token)
	if res.Code != http.StatusOK {
		t.Fatalf("enroll status = %d, body %x", res.Code, res.Body.Bytes())
	}
	var out []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode enroll: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("enroll returned %d elements, want [secret, otpauth_url]", len(out))
	}
	secret, ok := out[0].(string)
	if !ok || secret == "" {
		t.Fatalf("enroll secret = %#v", out[0])
	}
	if url, ok := out[1].(string); !ok || url == "" {
		t.Fatalf("enroll otpauth_url = %#v", out[1])
	}

	code, err := totp.GenerateCode(secret, d.Clock.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	body, _ = cborx.Marshal([]any{code})
	res = postCBORAuth(h, "/v1/auth/totp/confirm", body, token)
	if res.Code != http.StatusOK {
		t.Fatalf("confirm status = %d, body %x", res.Code, res.Body.Bytes())
	}
	var confirmed []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &confirmed); err != nil {
		t.Fatalf("decode confirm: %v", err)
	}
	if len(confirmed) != 1 {
		t.Fatalf("confirm returned %d elements, want [recovery_codes]", len(confirmed))
	}
	raw, ok := confirmed[0].([]any)
	if !ok {
		t.Fatalf("confirm recovery_codes = %#v", confirmed[0])
	}
	codes := make([]string, 0, len(raw))
	for _, c := range raw {
		s, ok := c.(string)
		if !ok {
			t.Fatalf("recovery code %#v is not a string", c)
		}
		codes = append(codes, s)
	}
	if len(codes) != 10 {
		t.Fatalf("confirm returned %d recovery codes, want 10", len(codes))
	}
	// The confirm consumed its own counter, so the code that proved the
	// enrolment can never also clear a login. Step one period on so the next
	// code the test mints is a counter the store has not seen.
	advance(t, d, 30*time.Second)
	return secret, codes
}

// advance moves the harness's fake clock.
func advance(t *testing.T, d api.Deps, by time.Duration) {
	t.Helper()
	f, ok := d.Clock.(*clock.Fake)
	if !ok {
		t.Fatalf("the harness clock is %T, not a *clock.Fake", d.Clock)
	}
	f.Advance(by)
}

func TestPasswordLoginReturnsAnAssertionAndNeedsTOTP(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")

	status, out := login(t, h, u.Username, pw)
	if status != http.StatusOK {
		t.Fatalf("login status = %d, want 200", status)
	}
	if len(out) != 2 {
		t.Fatalf("login returned %d elements, want [assertion, needs_totp]", len(out))
	}
	assertion, ok := out[0].(string)
	if !ok || assertion == "" {
		t.Fatalf("assertion = %#v", out[0])
	}
	if needs, ok := out[1].(uint64); !ok || needs != 0 {
		t.Fatalf("needs_totp = %#v, want 0 before TOTP is enrolled", out[1])
	}

	// Once TOTP is confirmed the same login says so.
	enrolTOTP(t, h, deps, token)
	status, out = login(t, h, u.Username, pw)
	if status != http.StatusOK {
		t.Fatalf("login status after enrolment = %d, want 200", status)
	}
	if needs, ok := out[1].(uint64); !ok || needs != 1 {
		t.Fatalf("needs_totp = %#v, want 1 once TOTP is confirmed", out[1])
	}
}

func TestAWrongPasswordAndAnUnknownAccountAreTheSameRefusal(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, _ := seedAPISession(t, deps)
	seedPassword(t, deps, u, "correct horse battery staple")

	wrong, _ := login(t, h, u.Username, "not the password")
	if wrong != http.StatusUnauthorized {
		t.Fatalf("a wrong password answered %d, want 401", wrong)
	}
	unknown, _ := login(t, h, "nosuchaccount", "not the password")
	if unknown != wrong {
		t.Fatalf("an unknown account answered %d and a wrong password %d; the two must not be distinguishable",
			unknown, wrong)
	}
}

func TestTheAssertionIsSpentExactlyOnce(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	secret, _ := enrolTOTP(t, h, deps, token)

	_, out := login(t, h, u.Username, pw)
	assertion := out[0].(string)

	code, err := totp.GenerateCode(secret, deps.Clock.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	body, _ := cborx.Marshal([]any{assertion, code})
	if res := postCBOR(h, "/v1/auth/totp/verify", body); res.Code != http.StatusOK {
		t.Fatalf("first verify status = %d, body %x", res.Code, res.Body.Bytes())
	}

	// Replay the SPENT assertion with a FRESH code, one period on. Nothing but
	// the assertion can refuse this: the code has never been presented, so its
	// counter is still ahead of the stored one.
	advance(t, deps, 30*time.Second)
	fresh, err := totp.GenerateCode(secret, deps.Clock.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	replay, _ := cborx.Marshal([]any{assertion, fresh})
	if res := postCBOR(h, "/v1/auth/totp/verify", replay); res.Code == http.StatusOK {
		t.Fatal("a spent assertion was accepted a second time")
	}
	// And the fresh code itself is still good behind a fresh assertion, which is
	// what proves the refusal above was the assertion and not the code.
	_, out = login(t, h, u.Username, pw)
	good, _ := cborx.Marshal([]any{out[0].(string), fresh})
	if res := postCBOR(h, "/v1/auth/totp/verify", good); res.Code != http.StatusOK {
		t.Fatalf("the fresh code was refused behind a fresh assertion: %d", res.Code)
	}
}

func TestAReplayedTOTPCounterIsRefusedInsideTheSkewWindow(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	secret, _ := enrolTOTP(t, h, deps, token)

	code, err := totp.GenerateCode(secret, deps.Clock.Now())
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}

	_, out := login(t, h, u.Username, pw)
	body, _ := cborx.Marshal([]any{out[0].(string), code})
	res := postCBOR(h, "/v1/auth/totp/verify", body)
	if res.Code != http.StatusOK {
		t.Fatalf("first verify status = %d, body %x", res.Code, res.Body.Bytes())
	}
	var verified []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &verified); err != nil {
		t.Fatalf("decode verify: %v", err)
	}
	if len(verified) != 1 {
		t.Fatalf("verify returned %d elements, want [assertion]", len(verified))
	}
	if s, ok := verified[0].(string); !ok || s == "" {
		t.Fatalf("verify assertion = %#v", verified[0])
	}

	// A FRESH assertion and the SAME code, at the same instant: the code is
	// still inside the skew window, and the only thing that refuses it is the
	// stored counter.
	_, out = login(t, h, u.Username, pw)
	body, _ = cborx.Marshal([]any{out[0].(string), code})
	if res := postCBOR(h, "/v1/auth/totp/verify", body); res.Code == http.StatusOK {
		t.Fatal("a TOTP code was accepted twice inside the skew window; the counter is not consumed")
	}
}

func TestARecoveryCodeWorksOnceAndThenDoesNot(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	_, codes := enrolTOTP(t, h, deps, token)

	_, out := login(t, h, u.Username, pw)
	body, _ := cborx.Marshal([]any{out[0].(string), codes[3]})
	res := postCBOR(h, "/v1/auth/recovery/verify", body)
	if res.Code != http.StatusOK {
		t.Fatalf("recovery verify status = %d, body %x", res.Code, res.Body.Bytes())
	}
	var verified []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &verified); err != nil {
		t.Fatalf("decode recovery verify: %v", err)
	}
	if s, ok := verified[0].(string); !ok || s == "" {
		t.Fatalf("recovery assertion = %#v", verified[0])
	}

	_, out = login(t, h, u.Username, pw)
	body, _ = cborx.Marshal([]any{out[0].(string), codes[3]})
	if res := postCBOR(h, "/v1/auth/recovery/verify", body); res.Code == http.StatusOK {
		t.Fatal("a recovery code was spent twice")
	}

	// A different, untouched code still works.
	_, out = login(t, h, u.Username, pw)
	body, _ = cborx.Marshal([]any{out[0].(string), codes[4]})
	if res := postCBOR(h, "/v1/auth/recovery/verify", body); res.Code != http.StatusOK {
		t.Fatalf("an unspent recovery code was refused: %d", res.Code)
	}
}

func TestEnrollingOverAConfirmedAuthenticatorIsRefused(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	enrolTOTP(t, h, deps, token)

	body, _ := cborx.Marshal([]any{})
	res := postCBORAuth(h, "/v1/auth/totp/enroll", body, token)
	if res.Code != http.StatusForbidden {
		t.Fatalf("a second enrolment answered %d, want 403: overwriting the row would clear confirmed_at", res.Code)
	}
	// And the account's second factor is still required.
	_, out := login(t, h, u.Username, pw)
	if needs, ok := out[1].(uint64); !ok || needs != 1 {
		t.Fatalf("needs_totp = %#v after a refused re-enrolment, want 1", out[1])
	}
}

func TestPasswordChangeNeedsTheOldPasswordAndReplacesTheCredential(t *testing.T) {
	h, deps := newTestAPI(t)
	u, _, token := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")

	body, _ := cborx.Marshal([]any{"wrong old password", "a brand new password"})
	if res := postCBORAuth(h, "/v1/auth/password", body, token); res.Code == http.StatusNoContent {
		t.Fatal("the password changed without the old one")
	}
	body, _ = cborx.Marshal([]any{pw, "a brand new password"})
	if res := postCBORAuth(h, "/v1/auth/password", body, token); res.Code != http.StatusNoContent {
		t.Fatalf("password change status = %d, want 204", res.Code)
	}
	if status, _ := login(t, h, u.Username, pw); status == http.StatusOK {
		t.Fatal("the old password still logs in")
	}
	if status, _ := login(t, h, u.Username, "a brand new password"); status != http.StatusOK {
		t.Fatalf("the new password does not log in: %d", status)
	}
}

// The `login_failed` bucket is the per-ADDRESS half of throttling, and the
// reason it exists is the attacker who spreads guesses over many handles: the
// `login` bucket is keyed by address AND by handle spelling, so a thousand
// guesses against a thousand handles never empties a single handle's bucket.
// RecordFailure is the one writer of login_failed; this route only PEEKS at it,
// so a correct password never spends the failure budget — but it is refused
// while the budget an attacker sharing the address burnt is still empty.
func TestFailuresFromOneAddressThrottleEveryAccountBehindIt(t *testing.T) {
	h, deps := newTestAPIWithConfig(t, func(c *config.Config) {
		// Take the per-attempt `login` bucket out of the picture: what is under
		// test is the failure budget, not the arrival rate.
		c.Limits.Rate.LoginBurst = 100
	})
	victim, _, _ := seedAPISession(t, deps)
	pw := seedPassword(t, deps, victim, "correct horse battery staple")

	// Spend the address's whole failure budget on OTHER accounts. Each one is a
	// single failure, well inside free_attempts, so no per-account lockout fires.
	for i := 0; i < deps.Config.Limits.Rate.LoginFailedBurst; i++ {
		other, _, _ := seedAPISession(t, deps)
		seedPassword(t, deps, other, "correct horse battery staple")
		if status, _ := login(t, h, other.Username, "not the password"); status != http.StatusUnauthorized {
			t.Fatalf("failure %d against a fresh account answered %d, want 401", i+1, status)
		}
	}

	if status, _ := login(t, h, victim.Username, pw); status != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429: this address spent its whole login_failed budget on %d other accounts",
			status, deps.Config.Limits.Rate.LoginFailedBurst)
	}

	// One token's worth of refill later the same request is allowed, which is
	// what proves the refusal was the failure bucket and not something durable.
	advance(t, deps, time.Duration(float64(time.Second)/deps.Config.Limits.Rate.LoginFailedPerSecond)+time.Second)
	if status, _ := login(t, h, victim.Username, pw); status != http.StatusOK {
		t.Fatalf("status = %d, want 200 once the failure budget refilled", status)
	}
}
