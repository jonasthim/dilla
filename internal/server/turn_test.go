package server_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

func TestTURNCredentialIsHMACOverExpiryColonDevice(t *testing.T) {
	dev := id.New()
	now := time.Unix(1_790_000_000, 0)
	user, pass := server.TURNCredential("s3cret", dev, time.Hour, now)
	wantUser := fmt.Sprintf("%d:%s", now.Add(time.Hour).Unix(), dev.String())
	if user != wantUser {
		t.Fatalf("username = %q, want %q", user, wantUser)
	}
	mac := hmac.New(sha1.New, []byte("s3cret"))
	mac.Write([]byte(wantUser))
	if want := base64.StdEncoding.EncodeToString(mac.Sum(nil)); pass != want {
		t.Fatalf("password = %q, want %q", pass, want)
	}
	// dillad's auth handler is pion's LongTermTURNRESTAuthHandler on the
	// instance clock: it splits on ':' and rejects a past expiry.
	clk := clock.NewFake(now)
	auth := server.TURNAuthForTest("s3cret", clk)
	gotDev, key, ok := auth(&turn.RequestAttributes{Username: user, Realm: "chat.example.test"})
	if !ok {
		t.Fatal("dillad refused a credential it minted")
	}
	if gotDev != dev.String() {
		t.Fatalf("user id = %q, want the device id %s", gotDev, dev)
	}
	if want := turn.GenerateAuthKey(user, "chat.example.test", pass); string(key) != string(want) {
		t.Fatal("the long-term key is not MD5(username:realm:password) over the minted password")
	}
	old, _ := server.TURNCredential("s3cret", dev, -time.Hour, now)
	if _, _, ok := auth(&turn.RequestAttributes{Username: old}); ok {
		t.Fatal("an expired credential was accepted")
	}
	if _, _, ok := auth(&turn.RequestAttributes{Username: "not-a-number:" + dev.String()}); ok {
		t.Fatal("a username without an expiry was accepted")
	}
	// And pion's own handler, on the wall clock, accepts the same shape: the
	// format is pion's, not a dilla dialect of it.
	fresh, _ := server.TURNCredential("s3cret", dev, time.Hour, time.Now())
	if _, _, ok := turn.LongTermTURNRESTAuthHandler("s3cret", nil)(&turn.RequestAttributes{Username: fresh}); !ok {
		t.Fatal("pion refused a credential dillad minted")
	}
}

func TestAtMostTwoAllocationsPerDevice(t *testing.T) {
	q := server.NewAllocationQuota(2)
	dev := id.New().String()
	for i := range 2 {
		if !q.Allow(dev) {
			t.Fatalf("allocation %d was refused", i)
		}
	}
	if q.Allow(dev) {
		t.Fatal("a third allocation was allowed")
	}
	if !q.Allow(id.New().String()) {
		t.Fatal("another device was refused")
	}
	q.Release(dev)
	if !q.Allow(dev) {
		t.Fatal("a slot did not free after Release")
	}
}

// pion v5.0.13 hands both handlers the user id the auth handler returned —
// the device id — not the REST username (internal/server/turn.go:212 and
// allocation_manager.go:279-281). The wired handlers take either spelling, and
// the release half is wired too: without it a device would be capped for the
// life of the process after allocations_per_device calls.
func TestTheQuotaHandlerParsesTheRESTUsername(t *testing.T) {
	dev := id.New().String()
	for _, name := range []string{dev, fmt.Sprintf("%d:%s", time.Now().Add(time.Hour).Unix(), dev)} {
		quota, events := server.TURNHandlersForTest(2)
		for i := range 2 {
			if !quota(name, "chat.example.test", nil) {
				t.Fatalf("%q: allocation %d was refused", name, i)
			}
		}
		if quota(name, "chat.example.test", nil) {
			t.Fatalf("%q: a third allocation was allowed", name)
		}
		events.OnAllocationDeleted(nil, nil, "tcp", name, "chat.example.test")
		if !quota(name, "chat.example.test", nil) {
			t.Fatalf("%q: closing an allocation did not free its slot", name)
		}
	}
}

// End to end over the 443 demux: a TURN client speaks STUN inside TLS, the
// demux hands the stream to pion, and the quota holds per device across
// separate connections until an allocation is released.
func TestTURNAllocatesThroughTheDemuxAndHoldsTheQuota(t *testing.T) {
	raw, tlsCfg := selfSignedListener(t)
	d := server.NewDemux(raw, tlsCfg, 10*time.Second)
	go d.Serve()
	defer d.Close()

	secret := "0123456789abcdef0123456789abcdef"
	c := config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "127.0.0.1",
		SharedSecretFile: writeFile(t, "turn.secret", secret+"\n"),
		CredentialTTL:    "1h", AllocationsPerDevice: 2,
	}
	srv, err := server.StartTURN(c, d.TURN(), clock.System(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("StartTURN: %v", err)
	}
	defer srv.Close()

	dev := id.New()
	user, pass := server.TURNCredential(secret, dev, time.Hour, time.Now())
	allocate := func() (net.PacketConn, *turn.Client, error) {
		conn, err := (&tls.Dialer{Config: &tls.Config{RootCAs: testCertPool(t), ServerName: "localhost"}}).DialContext(t.Context(), "tcp", raw.Addr().String())
		if err != nil {
			return nil, nil, err
		}
		client, err := turn.NewClient(&turn.ClientConfig{
			TURNServerAddr: raw.Addr().String(), Username: user, Password: pass,
			Realm: "chat.example.test", Conn: turn.NewSTUNConn(conn), RTO: time.Second,
		})
		if err != nil {
			conn.Close()
			return nil, nil, err
		}
		if err := client.Listen(); err != nil {
			client.Close()
			return nil, nil, err
		}
		relay, err := client.Allocate()
		if err != nil {
			client.Close()
			return nil, nil, err
		}
		return relay, client, nil
	}
	first, c1, err := allocate()
	if err != nil {
		t.Fatalf("first allocation: %v", err)
	}
	defer c1.Close()
	if host, _, _ := net.SplitHostPort(first.LocalAddr().String()); host != "127.0.0.1" {
		t.Fatalf("relayed address %s is not on turn.relay_ip", first.LocalAddr())
	}
	second, c2, err := allocate()
	if err != nil {
		t.Fatalf("second allocation: %v", err)
	}
	defer c2.Close()
	defer second.Close()
	if _, _, err := allocate(); err == nil || !strings.Contains(err.Error(), "486") {
		t.Fatalf("third allocation = %v, want 486 Allocation Quota Reached", err)
	}
	// Closing a relay refreshes it to lifetime 0, which deletes the allocation
	// and must hand the slot back.
	if err := first.Close(); err != nil {
		t.Fatalf("close relay: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		relay, c3, err := allocate()
		if err == nil {
			relay.Close()
			c3.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("an allocation after a release was still refused: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestStartTURNRefusesAMissingSecret(t *testing.T) {
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	_, err = server.StartTURN(config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "127.0.0.1",
		SharedSecretFile: filepath.Join(t.TempDir(), "missing"), CredentialTTL: "1h", AllocationsPerDevice: 2,
	}, ln, clock.System(), slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("StartTURN ran without its shared secret")
	}
}

func writeFile(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}
