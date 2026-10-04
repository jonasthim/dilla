package server_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/stun/v3"
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
	// dillad's auth handler checks the HMAC and the "<expiry>:<device>" shape on every request,
	// and the expiry on Allocate only (G33).
	clk := clock.NewFake(now)
	auth := server.TURNAuthForTest("s3cret", clk, time.Hour, 2*time.Hour)
	gotDev, key, ok := auth(&turn.RequestAttributes{Username: user, Realm: "chat.example.test", Method: stun.MethodAllocate})
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
	if _, _, ok := auth(&turn.RequestAttributes{Username: old, Method: stun.MethodAllocate}); ok {
		t.Fatal("an expired credential allocated")
	}
	if _, _, ok := auth(&turn.RequestAttributes{Username: "not-a-number:" + dev.String(), Method: stun.MethodRefresh}); ok {
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
		quota, events := server.TURNHandlersForTest(2, nil)
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
	srv, err := server.StartTURN(c, d.TURN(), netip.Addr{}, nil, nil, clock.System(), slog.New(slog.DiscardHandler))
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

// plainTURNClient allocates a relay over a plain TCP connection to addr.
func plainTURNClient(t *testing.T, addr, secret string) net.PacketConn {
	t.Helper()
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", addr)
	if err != nil {
		t.Fatalf("dial TURN: %v", err)
	}
	user, pass := server.TURNCredential(secret, id.New(), time.Hour, time.Now())
	client, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: addr, Username: user, Password: pass,
		Realm: "chat.example.test", Conn: turn.NewSTUNConn(conn), RTO: time.Second,
	})
	if err != nil {
		t.Fatalf("TURN client: %v", err)
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatalf("client listen: %v", err)
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	return relay
}

// udpPeer is a UDP socket on addr that reports the first datagram it receives.
func udpPeer(t *testing.T, addr string) (net.PacketConn, <-chan string) {
	t.Helper()
	pc, err := (&net.ListenConfig{}).ListenPacket(t.Context(), "udp4", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	got := make(chan string, 1)
	go func() {
		buf := make([]byte, 1500)
		n, _, err := pc.ReadFrom(buf)
		if err == nil {
			got <- string(buf[:n])
		}
	}()
	return pc, got
}

func startPlainTURN(t *testing.T, secret string, peers []netip.Addr) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv, err := server.StartTURN(config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "127.0.0.1",
		SharedSecretFile: writeFile(t, "turn.secret", secret), CredentialTTL: "1h", AllocationsPerDevice: 2,
	}, ln, netip.Addr{}, peers, nil, clock.System(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("StartTURN: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// C9 (fix wave): the relay's only legitimate peer is the co-located SFU. A member holding a call
// credential must not be able to relay into another loopback service or the LAN: CreatePermission
// (and so every send) to any other address is refused, and nothing is delivered there.
func TestTheRelayReachesOnlyTheSFU(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	sfu, toSFU := udpPeer(t, "127.0.0.2:0")
	victim, toVictim := udpPeer(t, "127.0.0.1:0")
	addr := startPlainTURN(t, secret, []netip.Addr{netip.MustParseAddr("127.0.0.2")})
	relay := plainTURNClient(t, addr, secret)

	if _, err := relay.WriteTo([]byte("media"), sfu.LocalAddr()); err != nil {
		t.Fatalf("a write to the SFU at %s: %v", sfu.LocalAddr(), err)
	}
	select {
	case got := <-toSFU:
		if got != "media" {
			t.Fatalf("the SFU received %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the SFU received nothing through the relay")
	}

	if _, err := relay.WriteTo([]byte("hello internal service"), victim.LocalAddr()); err == nil {
		t.Errorf("a write to the loopback service at %s was accepted", victim.LocalAddr())
	}
	lan := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 53}
	if _, err := relay.WriteTo([]byte("dns"), lan); err == nil {
		t.Errorf("a write to %s was accepted", lan)
	}
	select {
	case got := <-toVictim:
		t.Fatalf("the loopback service received %q through the relay", got)
	case <-time.After(500 * time.Millisecond):
	}
}

// With LiveKit off there is no SFU on the host, so the relay admits no peer at all.
func TestWithoutAnSFUTheRelayAdmitsNoPeer(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	peer, got := udpPeer(t, "127.0.0.2:0")
	relay := plainTURNClient(t, startPlainTURN(t, secret, nil), secret)
	if _, err := relay.WriteTo([]byte("media"), peer.LocalAddr()); err == nil {
		t.Error("a write was accepted by a relay with no SFU to reach")
	}
	select {
	case m := <-got:
		t.Fatalf("the peer received %q", m)
	case <-time.After(500 * time.Millisecond):
	}
}

// M4: when the IPv4 route probe fails, the "auto" fallback stays in node_ip's address family (or,
// with no node_ip, in the family of the address that did resolve) and is a config error when the
// host has no address of that family.
func TestAutoRelayIPKeepsNodeIPsAddressFamily(t *testing.T) {
	ipn := func(s string) net.Addr {
		p := netip.MustParsePrefix(s)
		return &net.IPNet{IP: p.Addr().AsSlice(), Mask: net.CIDRMask(p.Bits(), p.Addr().BitLen())}
	}
	v6, v4 := ipn("2001:db8::5/64"), ipn("10.0.0.5/24")
	for _, tc := range []struct {
		name   string
		probed net.IP
		addrs  []net.Addr
		prefer string
		want   string // "" = a config error
	}{
		{"v4 node, v6 listed first", nil, []net.Addr{v6, v4}, "203.0.113.7", "10.0.0.5"},
		{"v6 node, v4 listed first", nil, []net.Addr{v4, v6}, "2001:db8::1", "2001:db8::5"},
		{"v4 node, only v6 on the host", nil, []net.Addr{ipn("127.0.0.1/8"), v6}, "203.0.113.7", ""},
		{"v6 node, only v4 on the host", nil, []net.Addr{v4}, "2001:db8::1", ""},
		{"no node_ip, first usable wins", nil, []net.Addr{v6, v4}, "", "2001:db8::5"},
		{"v4 probe of the node's family wins", net.ParseIP("10.9.9.9"), []net.Addr{v6}, "203.0.113.7", "10.9.9.9"},
		{"v4 probe against a v6 node is not taken", net.ParseIP("10.9.9.9"), []net.Addr{v6}, "2001:db8::1", "2001:db8::5"},
		{"link-local and loopback never count", nil, []net.Addr{ipn("fe80::1/64"), ipn("::1/128")}, "2001:db8::1", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var prefer netip.Addr
			if tc.prefer != "" {
				prefer = netip.MustParseAddr(tc.prefer)
			}
			got, err := server.ChooseRelayIPForTest(tc.probed, tc.addrs, prefer)
			if tc.want == "" {
				if err == nil || !server.IsTURNConfigError(err) {
					t.Fatalf("got %v, %v; want a config error", got, err)
				}
				return
			}
			if err != nil || got.String() != tc.want {
				t.Fatalf("got %v, %v; want %s", got, err, tc.want)
			}
		})
	}
}

// I12 (fix wave): turn.relay_ip = "auto" is what init writes, because the public IP is not a local
// address on bridged Docker or a NATed LXC and every Allocate would fail to bind there. "auto" is
// the source address of this host's outbound route (or its first non-loopback interface address),
// which the relay can bind; an explicit IP is taken as written.
func TestAnAutoRelayIPIsALocalAddressTheRelayBinds(t *testing.T) {
	ip, err := server.ResolveRelayIP("auto", netip.Addr{})
	if err != nil {
		t.Fatalf(`ResolveRelayIP("auto"): %v`, err)
	}
	pc, err := (&net.ListenConfig{}).ListenPacket(t.Context(), "udp", net.JoinHostPort(ip.String(), "0"))
	if err != nil {
		t.Fatalf("the auto relay address %s is not bindable: %v", ip, err)
	}
	_ = pc.Close()
	if got, err := server.ResolveRelayIP("203.0.113.7", netip.Addr{}); err != nil || got.String() != "203.0.113.7" {
		t.Errorf("an explicit relay_ip = %v, %v", got, err)
	}
	if _, err := server.ResolveRelayIP("chat.example", netip.Addr{}); err == nil {
		t.Error("a relay_ip that is neither an IP nor auto was accepted")
	}

	const secret = "0123456789abcdef0123456789abcdef"
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	srv, err := server.StartTURN(config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "auto",
		SharedSecretFile: writeFile(t, "turn.secret", secret), CredentialTTL: "1h", AllocationsPerDevice: 2,
	}, ln, netip.Addr{}, nil, nil, clock.System(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf(`StartTURN with relay_ip "auto": %v`, err)
	}
	defer srv.Close()
	relay := plainTURNClient(t, ln.Addr().String(), secret)
	if host, _, _ := net.SplitHostPort(relay.LocalAddr().String()); host != ip.String() {
		t.Errorf("relayed address %s, want one on the auto address %s", relay.LocalAddr(), ip)
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
	}, ln, netip.Addr{}, nil, nil, clock.System(), slog.New(slog.DiscardHandler))
	if err == nil {
		t.Fatal("StartTURN ran without its shared secret")
	}
	if !server.IsTURNConfigError(err) {
		t.Errorf("a missing shared secret = %v, want a configuration error", err)
	}
}

// C8 (fix wave): a relay that cannot set up its network (no netlink under a sandbox that blocks
// AF_NETLINK) is not a dilla.toml mistake: StartTURN's error says so, and serve reports it as
// unavailable rather than as a configuration error that systemd never restarts.
func TestANetworkSetupFailureIsNotAConfigError(t *testing.T) {
	restore := server.FailTURNNetForTest(errors.New("netlinkrib: address family not supported by protocol"))
	defer restore()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	_, err = server.StartTURN(config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "127.0.0.1",
		SharedSecretFile: writeFile(t, "turn.secret", "0123456789abcdef0123456789abcdef"),
		CredentialTTL:    "1h", AllocationsPerDevice: 2,
	}, ln, netip.Addr{}, nil, nil, clock.System(), slog.New(slog.DiscardHandler))
	if err == nil || !strings.Contains(err.Error(), "netlinkrib") {
		t.Fatalf("StartTURN with no network = %v, want the network error", err)
	}
	if server.IsTURNConfigError(err) {
		t.Errorf("a network setup failure = %v, classified as a configuration error", err)
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

// fakeTURNMetrics records what the relay reports.
type fakeTURNMetrics struct {
	mu                        sync.Mutex
	refused, toClient, toPeer int
	allocations               []int
}

func (m *fakeTURNMetrics) QuotaRefused() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.refused++
}

func (m *fakeTURNMetrics) RelayBytes(toClient bool, n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if toClient {
		m.toClient += n
	} else {
		m.toPeer += n
	}
}
func (m *fakeTURNMetrics) Allocations(n int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.allocations = append(m.allocations, n)
}

func (m *fakeTURNMetrics) snapshot() (refused, toClient, toPeer int, allocations []int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.refused, m.toClient, m.toPeer, slices.Clone(m.allocations)
}

// G33: the expiry binds Allocate only; Refresh, CreatePermission and ChannelBind keep working after
// it until turn.max_allocation_age has passed since the credential was issued.
func TestTheCredentialExpiryBindsAllocateOnly(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	clk := clock.NewFake(now)
	user, _ := server.TURNCredential("s3cret", id.New(), time.Hour, now) // issued now, expires now+1h
	auth := server.TURNAuthForTest("s3cret", clk, time.Hour, 2*time.Hour)
	ok := func(m stun.Method) bool {
		_, _, ok := auth(&turn.RequestAttributes{Username: user, Realm: "chat.example.test", Method: m})
		return ok
	}
	others := []stun.Method{stun.MethodRefresh, stun.MethodCreatePermission, stun.MethodChannelBind}
	if !ok(stun.MethodAllocate) {
		t.Fatal("a fresh credential could not allocate")
	}
	clk.Advance(90 * time.Minute) // expired, inside the max age
	if ok(stun.MethodAllocate) {
		t.Fatal("an expired credential allocated")
	}
	for _, m := range others {
		if !ok(m) {
			t.Fatalf("%s with an expired credential inside max_allocation_age was refused", m)
		}
	}
	clk.Advance(31 * time.Minute) // 2 h 1 min after issue
	for _, m := range others {
		if ok(m) {
			t.Fatalf("%s past max_allocation_age was accepted", m)
		}
	}
}

// startMeteredTURN is startPlainTURN with a TURN config and metrics of the test's own.
func startMeteredTURN(t *testing.T, secret string, c config.TURN, peers []netip.Addr, m server.TURNMetrics, clk clock.Clock) string {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	c.Enabled, c.Realm, c.RelayIP = true, "chat.example.test", "127.0.0.1"
	c.SharedSecretFile = writeFile(t, "turn.secret", secret)
	srv, err := server.StartTURN(c, ln, netip.MustParseAddr("127.0.0.1"), peers, m, clk, slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("StartTURN: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// allocateAs allocates a relay over a plain TCP connection with the given credential.
func allocateAs(t *testing.T, addr, user, pass string) (net.PacketConn, error) {
	t.Helper()
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", addr)
	if err != nil {
		return nil, err
	}
	client, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: addr, Username: user, Password: pass,
		Realm: "chat.example.test", Conn: turn.NewSTUNConn(conn), RTO: time.Second,
	})
	if err != nil {
		conn.Close()
		return nil, err
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		return nil, err
	}
	relay, err := client.Allocate()
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { _ = relay.Close() })
	return relay, nil
}

// SP-25 (Go half): an allocation made before the credential expired keeps binding new permissions
// after it; a fresh Allocate with it is refused; past turn.max_allocation_age nothing binds.
func TestAnExpiredCredentialStillBindsButCannotAllocate(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	now := time.Now()
	clk := clock.NewFake(now)
	peerA, gotA := udpPeer(t, "127.0.0.2:0")
	peerB, gotB := udpPeer(t, "127.0.0.3:0")
	addr := startMeteredTURN(t, secret, config.TURN{CredentialTTL: "1m", MaxAllocationAge: "3m", AllocationsPerDevice: 4},
		[]netip.Addr{netip.MustParseAddr("127.0.0.2"), netip.MustParseAddr("127.0.0.3")}, nil, clk)
	user, pass := server.TURNCredential(secret, id.New(), time.Minute, now)
	relay, err := allocateAs(t, addr, user, pass)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	clk.Advance(2 * time.Minute) // the credential expired a minute ago
	if _, err := relay.WriteTo([]byte("after-expiry"), peerA.LocalAddr()); err != nil {
		t.Fatalf("a CreatePermission with an expired credential inside max_allocation_age: %v", err)
	}
	select {
	case got := <-gotA:
		if got != "after-expiry" {
			t.Fatalf("peer A received %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("peer A received nothing after the credential expired")
	}
	if _, err := allocateAs(t, addr, user, pass); err == nil {
		t.Fatal("an expired credential allocated")
	}
	clk.Advance(90 * time.Second) // 3 min 30 s after issue: past max_allocation_age
	if _, err := relay.WriteTo([]byte("past-max-age"), peerB.LocalAddr()); err == nil {
		select {
		case got := <-gotB:
			t.Fatalf("peer B received %q past max_allocation_age", got)
		case <-time.After(time.Second):
		}
	}
}

// SP-26 (Go half): with the default quota of 4 the fifth allocation of one device is 486, and the
// refusal is counted; the live-allocation gauge follows creations.
func TestTheFifthAllocationOfADeviceIsRefusedAndCounted(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	m := &fakeTURNMetrics{}
	addr := startMeteredTURN(t, secret, config.TURN{CredentialTTL: "1h", AllocationsPerDevice: 4}, nil, m, clock.System())
	user, pass := server.TURNCredential(secret, id.New(), time.Hour, time.Now())
	for i := range 4 {
		if _, err := allocateAs(t, addr, user, pass); err != nil {
			t.Fatalf("allocation %d: %v", i+1, err)
		}
	}
	if _, err := allocateAs(t, addr, user, pass); err == nil || !strings.Contains(err.Error(), "486") {
		t.Fatalf("the fifth allocation = %v, want 486 Allocation Quota Reached", err)
	}
	refused, _, _, allocations := m.snapshot()
	if refused != 1 || len(allocations) == 0 || allocations[len(allocations)-1] != 4 {
		t.Fatalf("refused %d, allocation gauge %v; want 1 and ending at 4", refused, allocations)
	}
}

// dilla_turn_relay_bytes_total: what the relay sends to a peer and what a peer sends back.
func TestTheRelayCountsItsBytesBothWays(t *testing.T) {
	const secret = "0123456789abcdef0123456789abcdef"
	m := &fakeTURNMetrics{}
	peer, got := udpPeer(t, "127.0.0.2:0")
	addr := startMeteredTURN(t, secret, config.TURN{CredentialTTL: "1h"}, []netip.Addr{netip.MustParseAddr("127.0.0.2")}, m, clock.System())
	user, pass := server.TURNCredential(secret, id.New(), time.Hour, time.Now())
	relay, err := allocateAs(t, addr, user, pass)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if _, err := relay.WriteTo([]byte("media"), peer.LocalAddr()); err != nil {
		t.Fatalf("WriteTo: %v", err)
	}
	select {
	case <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("the peer received nothing")
	}
	if _, err := peer.WriteTo([]byte("reply!"), relay.LocalAddr()); err != nil {
		t.Fatalf("the peer's reply: %v", err)
	}
	_ = relay.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 64)
	if n, _, err := relay.ReadFrom(buf); err != nil || string(buf[:n]) != "reply!" {
		t.Fatalf("the client read %q, %v", buf[:n], err)
	}
	_, toClient, toPeer, _ := m.snapshot()
	if toPeer < len("media") || toClient < len("reply!") {
		t.Fatalf("relay bytes to_peer %d, to_client %d", toPeer, toClient)
	}
}
