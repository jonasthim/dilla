package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
)

// Wave B task 3 (Jonas): POST /v1/auth/passkey/login/begin is metered on its own passkey_begin bucket, so the sign-in
// page's autofill begins never spend the address's password attempts; the finish still spends `login` and a refused
// one is a recorded failure, so a passkey is no way around the login throttle.

func passkeyBegin(h http.Handler) int {
	empty, _ := cborx.Marshal([]any{})
	return postCBOR(h, "/v1/auth/passkey/login/begin", empty).Code
}

func TestPasskeyBeginsDoNotSpendPasswordAttempts(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	u, _, _ := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	burst := deps.Config.Limits.Rate.PasskeyBeginBurst
	if login := deps.Config.Limits.Rate.LoginBurst; burst <= login {
		t.Fatalf("the test needs more begins (%d) than login tokens (%d)", burst, login)
	}
	for i := 0; i < burst; i++ {
		if code := passkeyBegin(h); code != http.StatusOK {
			t.Fatalf("begin %d = %d, want 200", i+1, code)
		}
	}
	if status, _ := login(t, h, u.Username, pw); status != http.StatusOK {
		t.Fatalf("a password login after %d begins = %d, want 200: begins spent login tokens", burst, status)
	}
}

func TestPasskeyBeginsAreLimitedByTheirOwnBucket(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	burst := deps.Config.Limits.Rate.PasskeyBeginBurst
	if burst <= 0 || burst > 10 || deps.Config.Limits.Rate.PasskeyBeginPerSecond > 1 {
		t.Fatalf("passkey_begin defaults %v/%d are looser than the session challenge's 1/10",
			deps.Config.Limits.Rate.PasskeyBeginPerSecond, burst)
	}
	for i := 0; i < burst; i++ {
		if code := passkeyBegin(h); code != http.StatusOK {
			t.Fatalf("begin %d = %d, want 200", i+1, code)
		}
	}
	empty, _ := cborx.Marshal([]any{})
	over := postCBOR(h, "/v1/auth/passkey/login/begin", empty)
	if over.Code != http.StatusTooManyRequests || errorCode(t, over) != "E_RATE_LIMITED" {
		t.Fatalf("begin %d = %d %s, want 429 E_RATE_LIMITED", burst+1, over.Code, errorCode(t, over))
	}
}

func TestAFailedPasskeyFinishChargesTheLoginBudget(t *testing.T) {
	h, deps := newPasskeyAPI(t)
	u, _, _ := seedAPISession(t, deps)
	pw := seedPassword(t, deps, u, "correct horse battery staple")
	failures := deps.Config.Limits.Rate.LoginFailedBurst
	for i := 0; i < failures; i++ {
		body, _ := cborx.Marshal([]any{id.New(), "{}"})
		if res := postCBOR(h, "/v1/auth/passkey/login/finish", body); res.Code != http.StatusUnauthorized {
			t.Fatalf("a refused finish %d = %d, want 401", i+1, res.Code)
		}
	}
	// The refused finishes filled the address's failure budget, exactly as wrong passwords would: the right password
	// is now refused too.
	if status, _ := login(t, h, u.Username, pw); status != http.StatusTooManyRequests {
		t.Fatalf("a password login after %d refused passkey finishes = %d, want 429", failures, status)
	}
}

// Security review I1: an instance-wide cap on open login ceremonies. Past it a begin is 429; an expired or pruned
// ceremony frees its place.
func TestOpenLoginCeremoniesAreCapped(t *testing.T) {
	h, deps, _ := newPasskeyAPITuned(t, "", false, func(c *config.Config) { c.Auth.WebAuthn.MaxOpenLogins = 3 })
	for i := 0; i < 3; i++ {
		if code := passkeyBegin(h); code != http.StatusOK {
			t.Fatalf("begin %d = %d, want 200", i+1, code)
		}
	}
	empty, _ := cborx.Marshal([]any{})
	over := postCBOR(h, "/v1/auth/passkey/login/begin", empty)
	if over.Code != http.StatusTooManyRequests || errorCode(t, over) != "E_RATE_LIMITED" {
		t.Fatalf("a begin past the cap = %d %s, want 429 E_RATE_LIMITED", over.Code, errorCode(t, over))
	}
	// Expired ceremonies no longer count, even before they are pruned.
	advance(t, deps, 5*time.Minute+time.Second)
	if code := passkeyBegin(h); code != http.StatusOK {
		t.Fatalf("a begin once the open ceremonies expired = %d, want 200", code)
	}
	// And a prune removes them from the table.
	if n, err := deps.Passkeys.PruneCeremonies(t.Context()); err != nil || n != 3 {
		t.Fatalf("PruneCeremonies = %d, %v; want the 3 expired rows", n, err)
	}
}

func TestTheOpenLoginCapIsConfiguredAndValidated(t *testing.T) {
	c := config.Default()
	if c.Auth.WebAuthn.MaxOpenLogins != 10000 {
		t.Fatalf("auth.webauthn.max_open_logins defaults to %d, want 10000", c.Auth.WebAuthn.MaxOpenLogins)
	}
}
