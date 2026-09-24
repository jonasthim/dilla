package auth_test

import (
	"net/netip"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
)

func TestLockoutScheduleFollowsTheConfiguredCurve(t *testing.T) {
	c := config.Default()
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	th := auth.NewThrottle(c.Limits.Rate, c.Auth.Lockout, clk)
	user := id.New()
	ip := netip.MustParseAddr("203.0.113.9")

	for i := 0; i < c.Auth.Lockout.FreeAttempts; i++ {
		if d := th.RecordFailure(user, ip); d != 0 {
			t.Fatalf("failure %d locked out after %s; the first %d are free", i+1, d, c.Auth.Lockout.FreeAttempts)
		}
	}
	first := th.RecordFailure(user, ip)
	if first != c.Auth.Lockout.FirstLockout.Value() {
		t.Fatalf("first lockout = %s, want %s", first, c.Auth.Lockout.FirstLockout.Value())
	}
	second := th.RecordFailure(user, ip)
	if second <= first {
		t.Fatalf("the lockout did not grow: %s then %s", first, second)
	}
	for i := 0; i < 20; i++ {
		last := th.RecordFailure(user, ip)
		if last > c.Auth.Lockout.LockoutCeiling.Value() {
			t.Fatalf("lockout %s exceeded the ceiling %s", last, c.Auth.Lockout.LockoutCeiling.Value())
		}
	}
}

func TestFailuresAreCountedPerAccountAndPerAddress(t *testing.T) {
	c := config.Default()
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	th := auth.NewThrottle(c.Limits.Rate, c.Auth.Lockout, clk)
	victim := id.New()
	attacker := netip.MustParseAddr("203.0.113.9")
	for i := 0; i < 50; i++ {
		th.RecordFailure(id.New(), attacker) // fifty different accounts, one address
	}
	if ok, _ := th.Allow("login_failed", attacker.String()); ok {
		t.Fatal("an address that failed fifty logins across fifty accounts is still allowed")
	}
	// The victim's own account is untouched by someone else's address.
	if d := th.RecordFailure(victim, netip.MustParseAddr("198.51.100.4")); d != 0 {
		t.Fatalf("an unrelated account was locked out after one failure: %s", d)
	}
}

func TestClearResetsTheAccountOnSuccess(t *testing.T) {
	c := config.Default()
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	th := auth.NewThrottle(c.Limits.Rate, c.Auth.Lockout, clk)
	user := id.New()
	ip := netip.MustParseAddr("203.0.113.9")
	for i := 0; i < 6; i++ {
		th.RecordFailure(user, ip)
	}
	th.Clear(user)
	if d := th.RecordFailure(user, ip); d != 0 {
		t.Fatalf("a successful login did not reset the counter: %s", d)
	}
}

func TestObservationWindowExpiresFailures(t *testing.T) {
	c := config.Default()
	clk := clock.NewFake(time.Unix(1_700_000_000, 0))
	th := auth.NewThrottle(c.Limits.Rate, c.Auth.Lockout, clk)
	user := id.New()
	ip := netip.MustParseAddr("203.0.113.9")
	for i := 0; i < 6; i++ {
		th.RecordFailure(user, ip)
	}
	clk.Advance(c.Auth.Lockout.ObservationWindow.Value() + time.Minute)
	th.Sweep()
	if d := th.RecordFailure(user, ip); d != 0 {
		t.Fatalf("failures outside the observation window still locked the account: %s", d)
	}
}
