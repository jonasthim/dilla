package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/server"
)

// rewriteConfig loads cfgPath, applies tune and writes it back.
func rewriteConfig(t *testing.T, cfgPath string, tune func(*config.Config)) {
	t.Helper()
	c, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	tune(c)
	f, err := os.OpenFile(cfgPath, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatalf("reopen dilla.toml: %v", err)
	}
	if err := c.WriteConfig(f); err != nil {
		f.Close()
		t.Fatalf("rewrite dilla.toml: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close dilla.toml: %v", err)
	}
	if _, err := config.Load(cfgPath); err != nil {
		t.Fatalf("the rewritten dilla.toml does not load: %v", err)
	}
}

// freePort is a TCP port on 127.0.0.1 nothing listens on right now.
func freePort(t *testing.T) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

// behind_proxy with turn.enabled: the API on server.plain_listen, and the TURN
// relay on its own operator-configured TCP port — never 443, where the proxy
// routes only HTTP. `dillad doctor`'s own TURN leg allocates against it.
func TestServeBehindAProxyRunsTURNOnItsOwnPort(t *testing.T) {
	cfgPath := bootstrapServeConfig(t)
	turnAddr := freePort(t)
	var secretFile, realm string
	rewriteConfig(t, cfgPath, func(c *config.Config) {
		c.TURN.Enabled = true
		c.TURN.Listen = turnAddr
		c.TURN.RelayIP = "127.0.0.1"
		secretFile, realm = c.TURN.SharedSecretFile, c.TURN.Realm
	})

	var stdout, stderr syncBuffer
	served := make(chan error, 1)
	go func() { served <- dispatch([]string{"serve", "--config=" + cfgPath}, &stdout, &stderr) }()
	addr := waitForListenAddr(t, &stdout, served)
	if err := probe(addr); err != nil {
		t.Fatalf("probe /healthz: %v", err)
	}
	secret, err := ops.ReadSecret(secretFile)
	if err != nil {
		t.Fatalf("read the TURN secret: %v", err)
	}
	leg := ops.TURNLeg(t.Context(), turnAddr, realm, secret)
	if leg.Status != ops.Green {
		t.Fatalf("TURN leg against turn.listen = %+v; stderr: %s", leg, stderr.String())
	}
	stopServe(t, served)
}

// The direct-TLS front end to end: server.listen through the 443 demux with
// certmagic's certificate (loaded from tls.storage_dir, so no ACME server is
// contacted), HTTP answered over TLS once the tls gate is green, and TURN over
// TLS on the same port.
func TestServeInACMEModeServesHTTPAndTURNOnOnePort(t *testing.T) {
	cfgPath := bootstrapServeConfig(t)
	// An ACME directory that answers 500 to everything: the certificate below
	// is already in storage and far from its renewal window, so nothing may
	// need the CA; if anything tried, it would fail rather than reach the
	// Internet.
	ca := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusInternalServerError)
	}))
	defer ca.Close()

	var domain, secretFile, realm string
	var pool *x509.CertPool
	rewriteConfig(t, cfgPath, func(c *config.Config) {
		c.TLS.Mode = config.TLSModeACMETLSALPN
		c.TLS.CA = ca.URL + "/directory"
		c.Server.Listen = "127.0.0.1:0"
		c.Server.TrustedProxyCIDRs = nil
		c.TURN.Enabled = true
		c.TURN.Listen = ""
		c.TURN.RelayIP = "127.0.0.1"
		domain, secretFile, realm = c.Instance.Domain, c.TURN.SharedSecretFile, c.TURN.Realm
		pool = seedCertificate(t, c.TLS.StorageDir, c.TLS.CA, domain)
	})

	var stdout, stderr syncBuffer
	served := make(chan error, 1)
	go func() { served <- dispatch([]string{"serve", "--config=" + cfgPath}, &stdout, &stderr) }()
	addr := waitForListenAddr(t, &stdout, served)

	tlsCfg := &tls.Config{RootCAs: pool, ServerName: domain, MinVersion: tls.VersionTLS12}
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: tlsCfg}}
	deadline := time.Now().Add(20 * time.Second)
	for {
		code, body, err := get(client, "https://"+addr+"/readyz")
		if err == nil && code == http.StatusOK {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/readyz over TLS never went green: %d %s %v; stderr: %s", code, body, err, stderr.String())
		}
		time.Sleep(100 * time.Millisecond)
	}

	secret, err := ops.ReadSecret(secretFile)
	if err != nil {
		t.Fatalf("read the TURN secret: %v", err)
	}
	conn, err := (&tls.Dialer{Config: tlsCfg}).DialContext(t.Context(), "tcp", addr)
	if err != nil {
		t.Fatalf("dial TURN over TLS: %v", err)
	}
	user, pass := server.TURNCredential(secret, id.New(), time.Hour, time.Now())
	tc, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: addr, Username: user, Password: pass, Realm: realm,
		Conn: turn.NewSTUNConn(conn), RTO: time.Second,
	})
	if err != nil {
		t.Fatalf("turn.NewClient: %v", err)
	}
	defer tc.Close()
	if err := tc.Listen(); err != nil {
		t.Fatalf("turn Listen: %v", err)
	}
	relay, err := tc.Allocate()
	if err != nil {
		t.Fatalf("a TURN allocation through the 443 demux failed: %v", err)
	}
	relay.Close()
	stopServe(t, served)
}

func get(c *http.Client, url string) (int, string, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	res, err := c.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b), nil
}

// seedCertificate writes a self-signed certificate for domain where certmagic
// v0.25.4's FileStorage keeps an issued one (StorageKeys.SiteCert,
// SitePrivateKey and SiteMeta under the CA's issuer key), and returns a pool
// holding it.
func seedCertificate(t *testing.T, storageDir, ca, domain string) *x509.CertPool {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(90 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IsCA:         true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("MarshalECPrivateKey: %v", err)
	}
	issuerKey := (&certmagic.ACMEIssuer{CA: ca}).IssuerKey()
	write := func(k string, body []byte) {
		p := filepath.Join(storageDir, filepath.FromSlash(k))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatalf("write %s: %v", p, err)
		}
	}
	write(certmagic.StorageKeys.SiteCert(issuerKey, domain), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	write(certmagic.StorageKeys.SitePrivateKey(issuerKey, domain), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}))
	write(certmagic.StorageKeys.SiteMeta(issuerKey, domain), fmt.Appendf(nil, `{"sans":[%q],"issuer_data":null}`, domain))
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(leaf)
	return pool
}

// freeUDPPort is a UDP port on 127.0.0.1 nothing is bound to right now.
func freeUDPPort(t *testing.T) int {
	t.Helper()
	pc, err := (&net.ListenConfig{}).ListenPacket(t.Context(), "udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen udp: %v", err)
	}
	port := pc.LocalAddr().(*net.UDPAddr).Port
	pc.Close()
	return port
}

// livekit.enabled starts LiveKit in this process through internal/sfu, and
// the livekit readiness gate is green only once it accepts connections; serve
// stops it on the way out.
func TestServeStartsTheSFU(t *testing.T) {
	cfgPath := bootstrapServeConfig(t)
	port := freeTCPPort(t)
	rewriteConfig(t, cfgPath, func(c *config.Config) {
		c.LiveKit.Enabled = true
		c.LiveKit.BindAddress = "127.0.0.1"
		c.LiveKit.NodeIP = "127.0.0.1"
		c.LiveKit.Port = port
		c.LiveKit.UDPPort = freeUDPPort(t)
	})

	var stdout, stderr syncBuffer
	served := make(chan error, 1)
	go func() { served <- dispatch([]string{"serve", "--config=" + cfgPath}, &stdout, &stderr) }()
	addr := waitForListenAddr(t, &stdout, served)
	client := &http.Client{Timeout: 5 * time.Second}
	code, body, err := get(client, "http://"+addr+"/readyz")
	if err != nil || code != http.StatusOK {
		t.Fatalf("/readyz = %d %s %v", code, body, err)
	}
	if code, _, err := get(client, fmt.Sprintf("http://127.0.0.1:%d/", port)); err != nil || code != http.StatusOK {
		t.Fatalf("the SFU on livekit.port answered %d, %v", code, err)
	}
	// Plan 2 is served by the binary (task 19): a community route is behind the session
	// middleware, not missing, and LiveKit's signalling path answers on the instance's own
	// listener, proxied to the SFU — LiveKit's own refusal of a validate with no token, not the
	// mux's 404.
	if code, body, err := get(client, "http://"+addr+"/v1/communities/0102030405060708090a0b0c0d0e0f10"); err != nil ||
		code != http.StatusUnauthorized {
		t.Fatalf("GET /v1/communities/{id} through serve = %d %q %v, want 401", code, body, err)
	}
	if code, body, err := get(client, "http://"+addr+"/rtc/validate"); err != nil || code == http.StatusNotFound {
		t.Fatalf("GET /rtc/validate through serve = %d %q %v, want LiveKit's answer", code, body, err)
	}
	stopServe(t, served)
	if _, _, err := get(&http.Client{Timeout: time.Second}, fmt.Sprintf("http://127.0.0.1:%d/", port)); err == nil {
		t.Fatal("the SFU is still listening after serve returned")
	}
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	_, p, err := net.SplitHostPort(freePort(t))
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	port, err := strconv.Atoi(p)
	if err != nil {
		t.Fatalf("port: %v", err)
	}
	return port
}

// turn.proxy_protocol: a trusted proxy's PROXY header names the client; a peer
// outside server.trusted_proxy_cidrs is refused rather than allowed to name
// any address it likes.
func TestTheTURNListenerTakesPROXYHeadersOnlyFromTrustedProxies(t *testing.T) {
	for _, tc := range []struct {
		name    string
		trusted string
		want    string // the remote address Accept reports, or "" for a refusal
	}{
		{"trusted", "127.0.0.1/32", "198.51.100.7:4242"},
		{"untrusted", "10.0.0.0/8", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatalf("listen: %v", err)
			}
			ln := proxyProtocolListener(raw, []netip.Prefix{netip.MustParsePrefix(tc.trusted)})
			defer ln.Close()
			got := make(chan string, 1)
			go func() {
				c, err := ln.Accept()
				if err != nil {
					got <- ""
					return
				}
				defer c.Close()
				buf := make([]byte, 4)
				if _, err := io.ReadFull(c, buf); err != nil {
					got <- ""
					return
				}
				got <- c.RemoteAddr().String()
			}()
			c, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", raw.Addr().String())
			if err != nil {
				t.Fatalf("dial: %v", err)
			}
			defer c.Close()
			fmt.Fprintf(c, "PROXY TCP4 198.51.100.7 203.0.113.1 4242 443\r\nstun")
			select {
			case addr := <-got:
				if addr != tc.want {
					t.Fatalf("accepted from %q, want %q", addr, tc.want)
				}
			case <-time.After(5 * time.Second):
				if tc.want != "" {
					t.Fatal("the connection was never accepted")
				}
			}
		})
	}
}

func TestServeRefusesAnUnknownLiveKitMode(t *testing.T) {
	cfgPath := bootstrapServeConfig(t)
	rewriteConfig(t, cfgPath, func(c *config.Config) {
		c.LiveKit.Enabled = true
		c.LiveKit.Mode = "external"
	})
	_, _, err := run(t, "serve", "--config="+cfgPath)
	if err == nil || !strings.Contains(err.Error(), "livekit.mode") {
		t.Fatalf("serve with livekit.mode = external: %v", err)
	}
}

// I13 (fix wave): every livekit.* key dilla.toml validates reaches the SFU's config, not only the
// ports and the key pair.
func TestTheSFUConfigCarriesTheLiveKitKeys(t *testing.T) {
	lk := config.Default().LiveKit
	lk.NodeIP = "203.0.113.7"
	lk.STUNServers = []string{"chat.example:3478"}
	lk.MaxVoiceParticipants = 12
	got := sfuConfig(lk, "  secret\n")
	if got.NodeIP != "203.0.113.7" || got.EnableLoopbackCandidate {
		t.Errorf("node ip %q, loopback candidate %t; want the public ip without the loopback candidate",
			got.NodeIP, got.EnableLoopbackCandidate)
	}
	if !got.AdvertiseInternalIP {
		t.Error("advertise_internal_ip (default true) did not reach the SFU config")
	}
	if len(got.STUNServers) != 1 || got.STUNServers[0] != "chat.example:3478" {
		t.Errorf("stun servers = %v, want [chat.example:3478]", got.STUNServers)
	}
	if got.MaxParticipants != 12 {
		t.Errorf("max participants = %d, want livekit.max_voice_participants 12", got.MaxParticipants)
	}
	if got.APISecret != "secret" || got.APIKey != lk.APIKey {
		t.Errorf("key pair = %q/%q", got.APIKey, got.APISecret)
	}
	lk.NodeIP, lk.AdvertiseInternalIP = "", false
	got = sfuConfig(lk, "secret")
	if got.NodeIP != "127.0.0.1" || !got.EnableLoopbackCandidate || got.AdvertiseInternalIP {
		t.Errorf("unset node_ip: %+v, want 127.0.0.1 with the loopback candidate and no internal ip", got)
	}
}
