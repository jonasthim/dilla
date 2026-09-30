package dillad

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
)

// The call routes hand out this instance's own origin as the LiveKit URL (/rtc is proxied to the
// SFU), and the relay each TLS mode actually runs: TURN over TLS on server.listen's port in the
// direct-TLS modes, plain TURN over TCP on turn.listen's port behind a proxy, none when TURN is off.
func TestTheCallsConfigNamesTheRelayTheModeRuns(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "turn.secret")
	if err := os.WriteFile(secret, []byte("  s3cret\n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	base := func() *config.Config {
		c := config.Default()
		c.Instance.Domain = "chat.example.test"
		c.Instance.PublicIP = netip.MustParseAddr("2001:db8::7")
		c.TURN.SharedSecretFile = secret
		c.Server.Listen = ":443"
		return c
	}
	for _, tc := range []struct {
		name     string
		tune     func(*config.Config)
		url      string
		relay    string
		haveTURN bool
	}{
		{"acme_tls_alpn", func(*config.Config) {}, "wss://chat.example.test",
			"turns:chat.example.test:443?transport=tcp", true},
		{"acme_ip", func(c *config.Config) { c.TLS.Mode = config.TLSModeACMEIP }, "wss://[2001:db8::7]",
			"turns:[2001:db8::7]:443?transport=tcp", true},
		{"behind_proxy", func(c *config.Config) {
			c.TLS.Mode = config.TLSModeBehindProxy
			c.TURN.Listen = "0.0.0.0:3478"
		}, "wss://chat.example.test", "turn:chat.example.test:3478?transport=tcp", true},
		{"turn off", func(c *config.Config) { c.TURN.Enabled = false }, "wss://chat.example.test", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.tune(c)
			got, err := callsConfig(c)
			if err != nil {
				t.Fatalf("callsConfig: %v", err)
			}
			if got.LiveKitURL != tc.url || got.CredentialTTL != time.Hour {
				t.Errorf("LiveKitURL %q, ttl %s; want %q, 1h", got.LiveKitURL, got.CredentialTTL, tc.url)
			}
			if !tc.haveTURN {
				if len(got.TURNURLs) != 0 || got.TURNSecret != "" {
					t.Errorf("TURN off, yet the relay is %v", got.TURNURLs)
				}
				return
			}
			if len(got.TURNURLs) != 1 || got.TURNURLs[0] != tc.relay || got.TURNSecret != "s3cret" {
				t.Errorf("relay %v, secret %q; want [%s] and the trimmed secret", got.TURNURLs, got.TURNSecret, tc.relay)
			}
		})
	}
}

type fakeSFU struct{ url string }

func (f fakeSFU) Token(room, identity string) (string, error) { return room + "/" + identity, nil }
func (f fakeSFU) DeleteRoom(context.Context, string) error    { return nil }
func (f fakeSFU) HTTPURL() string                             { return f.url }

// /rtc and everything under it reach the SFU unchanged, with the client address the trusted-proxy
// rule resolves as the one X-Forwarded-For LiveKit sees; a forged chain from the client is dropped.
func TestTheRTCPathsAreProxiedToTheSFU(t *testing.T) {
	var gotPath, gotXFF string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotXFF = r.URL.RequestURI(), r.Header.Get("X-Forwarded-For")
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()
	mux := server.NewMux()
	if err := mountRTC(mux, fakeSFU{url: upstream.URL}, nil); err != nil {
		t.Fatalf("mountRTC: %v", err)
	}
	for _, path := range []string{"/rtc?access_token=x", "/rtc/validate?access_token=x", "/rtc/v1"} {
		req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		req.RemoteAddr = "198.51.100.9:5555"
		req.Header.Set("X-Forwarded-For", "10.0.0.1")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusTeapot || gotPath != path {
			t.Errorf("GET %s = %d, upstream saw %q", path, rec.Code, gotPath)
		}
		if gotXFF != "198.51.100.9" {
			t.Errorf("GET %s: LiveKit saw X-Forwarded-For %q, want only the resolved client", path, gotXFF)
		}
	}
}
