package ops_test

import (
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ops"
)

func webauthnConfig(rpID string, origins ...string) config.Config {
	c := config.Default()
	c.Instance.Domain = "chat.example"
	c.Auth.WebAuthn.RPID = rpID
	c.Auth.WebAuthn.RPOrigins = origins
	c.Derive()
	return *c
}

func TestTheWebAuthnLegFlagsAnIPRelyingPartyAndAForeignOrigin(t *testing.T) {
	for _, tc := range []struct {
		name    string
		cfg     config.Config
		want    ops.Status
		contain string
	}{
		{"control: the instance's own origin, with its port", webauthnConfig("chat.example", "https://chat.example:8443"), ops.Green, ""},
		{"control: a subdomain of rp_id", webauthnConfig("chat.example", "https://app.chat.example"), ops.Green, ""},
		{"control: the desktop shell's custom scheme is not a web origin", webauthnConfig("chat.example", "https://chat.example", "dilla://app"), ops.Green, ""},
		{"an IPv4 rp_id", webauthnConfig("10.0.0.1", "https://10.0.0.1"), ops.Red, "IP address"},
		{"an IPv6 rp_id", webauthnConfig("::1", "https://[::1]"), ops.Red, "IP address"},
		{"an origin on another domain", webauthnConfig("chat.example", "https://chat.example", "https://other.example"), ops.Red, "other.example"},
		{"a look-alike suffix is not a subdomain", webauthnConfig("chat.example", "https://notchat.example"), ops.Red, "notchat.example"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			leg := ops.WebAuthnLeg(tc.cfg)
			if leg.Name != "webauthn" || leg.Status != tc.want {
				t.Fatalf("leg = %+v, want status %v", leg, tc.want)
			}
			if !strings.Contains(leg.Detail, tc.contain) {
				t.Fatalf("detail %q does not mention %q", leg.Detail, tc.contain)
			}
			if tc.want != ops.Green && leg.Fix == "" {
				t.Fatal("a failing leg must say how to fix it")
			}
		})
	}
}

func TestTheWebAuthnLegWarnsBehindAProxyAndWithoutTOTP(t *testing.T) {
	behind := webauthnConfig("chat.example", "https://chat.example:8443")
	behind.TLS.Mode = config.TLSModeBehindProxy
	leg := ops.WebAuthnLeg(behind)
	if leg.Status != ops.Yellow || !strings.Contains(leg.Detail+leg.Fix, "set auth.webauthn.rp_origins to the public origin, with its port") {
		t.Fatalf("behind_proxy leg = %+v", leg)
	}

	passkeyOnly := webauthnConfig("chat.example", "https://chat.example")
	passkeyOnly.Auth.Methods = []string{"password", "passkey"}
	leg = ops.WebAuthnLeg(passkeyOnly)
	if leg.Status != ops.Yellow || !strings.Contains(leg.Detail, "passkeys are the only second factor") {
		t.Fatalf("no-totp leg = %+v", leg)
	}

	// A failure outranks a warning, and both are said.
	both := webauthnConfig("10.0.0.1", "https://10.0.0.1")
	both.Auth.Methods = []string{"password", "passkey"}
	leg = ops.WebAuthnLeg(both)
	if leg.Status != ops.Red || !strings.Contains(leg.Detail, "IP address") || !strings.Contains(leg.Detail, "passkeys are the only second factor") {
		t.Fatalf("combined leg = %+v", leg)
	}
}
