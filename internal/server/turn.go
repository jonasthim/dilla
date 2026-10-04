package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // G505: RFC 8489's long-term credential mechanism is HMAC-SHA1; pion validates exactly that
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/logging"
	"github.com/pion/stun/v3"
	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
)

// TURNMetrics is the relay's metric surface; *obs.Metrics is one. QuotaRefused counts one 486,
// RelayBytes the payload crossing a relay socket (toClient: read from a peer, on its way to the
// client), Allocations the live allocation count after each change. All label-free but the
// direction.
type TURNMetrics interface {
	QuotaRefused()
	RelayBytes(toClient bool, n int)
	Allocations(n int)
}

type noTURNMetrics struct{}

func (noTURNMetrics) QuotaRefused()        {}
func (noTURNMetrics) RelayBytes(bool, int) {}
func (noTURNMetrics) Allocations(int)      {}

// defaultAllocationsPerDevice is turn.allocations_per_device's default (G34): a browser holds
// T × N × U allocations — T = 1 gathering transport under max-bundle, N = the networks it gathers
// on, U = 1 relay URL — so 4 covers two networks (Wi-Fi and a VPN, IPv4 and IPv6) through one
// ICE-restart overlap.
const defaultAllocationsPerDevice = 4

// TURN is dillad's embedded relay: pion/turn v5.0.13 on a listener dillad
// chooses. In the direct-TLS modes that is the 443 demux's STUN branch; in
// behind_proxy it is a separate operator-configured TCP port (turn.listen),
// because the proxy terminates TLS on 443 and no HTTP router rule can match a
// STUN Allocate — the client's "relay unavailable" dialog is the documented
// consequence when the operator publishes none. It is off unless turn.enabled.
type TURN struct {
	srv       *turn.Server
	quota     *AllocationQuota
	stop      func() // cancels the relay's store lookups and joins the holders' re-check
	closeOnce sync.Once
}

// TURNCredential mints the REST-style ephemeral credential: username
// "<expiry>:<device_id>:<issued>", password base64(HMAC-SHA1(secret, username)).
// expiry is unix seconds, as the TURN REST convention has it; issued is unix
// milliseconds, the unit every relay time is held in, so a cut and a mint in
// different milliseconds are ordered by their times (re-review N1). The issue
// time is carried so that the relay measures turn.max_allocation_age and a
// revocation against when the credential was minted, whatever
// turn.credential_ttl is when it is used (task 13 review M6). pion's
// LongTermTURNRESTAuthHandler accepts the shape: it reads the first field as
// the expiry and the second as the user id.
func TURNCredential(secret string, deviceID id.ID, ttl time.Duration, now time.Time) (username, password string) {
	username = fmt.Sprintf("%d:%s:%d", now.Add(ttl).Unix(), deviceID.String(), now.UnixMilli())
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// StartTURN serves TURN on ln until Close. The shared secret is read from
// turn.shared_secret_file (whitespace trimmed, as `dillad doctor` reads it), and
// relays are allocated on turn.relay_ip.
//
// peers are the co-located SFU's media addresses, the relay's only legitimate
// peers (spec "Ports and TURN, made true"): CreatePermission and ChannelBind to
// any other address are refused with 403, so a call credential cannot turn the
// relay into a way into loopback or the LAN. With no peers (LiveKit off) the
// relay admits none. pion's handler sees the peer IP only, so every port of an
// admitted address stays reachable; the SFU's addresses are the host's own.
//
// anchor is livekit.node_ip, the address family turn.relay_ip "auto" must stay in (cmd/dillad
// turnPeers); it is passed apart from peers because node_ip is not always an admitted peer (DEV-55).
// m receives the relay's counters; nil reports nowhere. rev is the revocation state the relay shares
// with the call routes (RelayRevocations); nil gives the relay one of its own that no cut reaches.
func StartTURN(c config.TURN, ln net.Listener, anchor netip.Addr, peers []netip.Addr, m TURNMetrics,
	rev *RelayRevocations, clk clock.Clock, log *slog.Logger) (*TURN, error) {
	body, err := os.ReadFile(c.SharedSecretFile)
	if err != nil {
		return nil, turnConfigError{fmt.Errorf("turn: turn.shared_secret_file: %w", err)}
	}
	secret := strings.TrimSpace(string(body))
	if secret == "" {
		return nil, turnConfigError{errors.New("turn: turn.shared_secret_file is empty")}
	}
	relayIP, err := ResolveRelayIP(c.RelayIP, anchor)
	if err != nil {
		return nil, err
	}
	// The relay generator's network is built here rather than left to pion, so that a failure
	// (no netlink under a sandbox, say) is reported as the network error it is.
	relayNet, err := newTURNNet()
	if err != nil {
		return nil, fmt.Errorf("turn: failed to create network: %w", err)
	}
	if c.RelayIP == config.RelayIPAuto {
		log.Info("turn.relay_ip auto resolved", "relay_ip", relayIP.String())
	}
	perDevice := c.AllocationsPerDevice
	if perDevice <= 0 {
		perDevice = defaultAllocationsPerDevice
	}
	if m == nil {
		m = noTURNMetrics{}
	}
	ttl := c.CredentialTTL.Value()
	if ttl <= 0 {
		ttl = time.Hour
	}
	maxAge := max(c.MaxAllocationAge.Value(), ttl)
	if rev == nil {
		rev = NewRelayRevocations(maxAge, clk)
	}
	q := NewAllocationQuota(perDevice)
	// ctx ends with the relay: it cancels the store lookups OnAuth and the holders' re-check make.
	ctx, cancel := context.WithCancel(context.Background())
	quota, events := turnHandlers(ctx, q, m, rev)
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm:         c.Realm,
		AuthHandler:   turnAuth(secret, clk, ttl, maxAge, rev),
		QuotaHandler:  quota,
		EventHandler:  events,
		LoggerFactory: slogFactory{log: log},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener: ln,
			RelayAddressGenerator: &countingRelay{
				RelayAddressGeneratorStatic: &turn.RelayAddressGeneratorStatic{
					RelayAddress: relayIP,
					Address:      relayIP.String(),
					Net:          relayNet,
				},
				m: m, q: q, rev: rev,
			},
			PermissionHandler: peerFilter(peers),
		}},
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("turn: %w", err)
	}
	t := &TURN{srv: srv, quota: q, stop: cancel}
	if rev.barred != nil {
		stopWatch := rev.startWatch(ctx)
		t.stop = func() {
			cancel()
			stopWatch()
		}
	}
	return t, nil
}

// errNoTCPRelay is the relay generator's answer to an RFC 6062 TCP allocation or Connect; pion
// turns it into 508 Insufficient Capacity.
var errNoTCPRelay = errors.New("turn: TCP relays are not offered")

// countingRelay allocates relay sockets as RelayAddressGeneratorStatic does and counts what crosses
// them (dilla_turn_relay_bytes_total).
//
// It offers UDP relays only (task 13 review C1). RelayAddressGeneratorStatic would serve RFC 6062
// TCP allocations too, and pion's peer filter sees only the peer IP, so a TCP relay would be a TCP
// tunnel to every port of every admitted address — the SFU's, which are often the host's own,
// loopback included. Browsers never ask for a TCP allocation (WebRTC relays UDP); AllocateListener
// and AllocateConn refuse, and pion answers 508.
//
// pion takes a device's quota slot before it asks the generator for the socket and reports no event
// when the generator fails (internal/server/turn.go:212-237, allocation_manager.go:204-227), so the
// generator gives the slot back itself on every failure: a refused TCP allocation, and a UDP socket
// that will not bind — which a client can cause at will with an IPv6 REQUESTED-ADDRESS-FAMILY
// against an IPv4 turn.relay_ip (review I3).
//
// Every relay socket of a device is tracked in rev, so a revocation can close them.
type countingRelay struct {
	*turn.RelayAddressGeneratorStatic
	m   TURNMetrics
	q   *AllocationQuota
	rev *RelayRevocations
}

func (g *countingRelay) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.RelayAddressGeneratorStatic.AllocatePacketConn(conf)
	if err != nil {
		g.release(conf.UserID)
		g.dropPending(conf.UserID)
		return nil, nil, err
	}
	c := &countingConn{PacketConn: conn, m: g.m}
	if conf.UserID != "" {
		c.dev, c.rev = deviceOf(conf.UserID), g.rev
		if hook := allocateHook.Load(); hook != nil {
			(*hook)(c.dev)
		}
		if !g.rev.track(c.dev, c) {
			// A cut that may cover this allocation's credential landed after the auth handler let the
			// Allocate through (commit review race finding): refuse it, which pion answers 508.
			_ = conn.Close()
			g.release(conf.UserID)
			return nil, nil, errCutWhileAllocating
		}
	}
	return c, addr, nil
}

// errCutWhileAllocating refuses an allocation whose device was cut between its authentication and
// its relay socket.
var errCutWhileAllocating = errors.New("turn: the device was cut while it allocated")

// allocateHook, when set (tests only), runs after a relay socket is bound and before it is tracked.
var allocateHook atomic.Pointer[func(dev string)]

// AllocateListener refuses a TCP allocation and frees the slot pion took for it.
func (g *countingRelay) AllocateListener(conf turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	g.release(conf.UserID)
	g.dropPending(conf.UserID)
	return nil, nil, errNoTCPRelay
}

// AllocateConn refuses a Connect's outbound TCP connection. No TCP allocation can exist to make
// one, and a Connect takes no quota slot, so there is nothing to free.
func (g *countingRelay) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errNoTCPRelay
}

// release frees the quota slot pion took for user's allocation. pion's EVEN-PORT probe asks for
// sockets with no user (allocation_manager.go:324) before any slot is taken; it frees nothing.
func (g *countingRelay) release(user string) {
	if user != "" {
		g.q.Release(deviceOf(user))
	}
}

// dropPending gives back the pending Allocate the quota handler admitted for an allocation pion
// could not create, so its issue time does not outlive it (re-review N6).
func (g *countingRelay) dropPending(user string) {
	if user != "" && g.rev != nil {
		g.rev.dropPending(deviceOf(user))
	}
}

// countingConn is a relay socket: what it reads came from a peer and goes on to the client, what it
// writes goes to a peer. dev and rev are set for an allocation's socket (not for pion's EVEN-PORT
// probe), which Close forgets.
type countingConn struct {
	net.PacketConn
	m   TURNMetrics
	dev string
	rev *RelayRevocations
}

// Close forgets the socket and closes it. pion closes it when the allocation ends; a revocation
// closes it first, and pion's read loop then deletes the allocation.
func (c *countingConn) Close() error {
	if c.rev != nil {
		c.rev.untrack(c.dev, c)
	}
	return c.PacketConn.Close()
}

func (c *countingConn) ReadFrom(p []byte) (int, net.Addr, error) {
	n, addr, err := c.PacketConn.ReadFrom(p)
	if n > 0 {
		c.m.RelayBytes(true, n)
	}
	return n, addr, err
}

func (c *countingConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	n, err := c.PacketConn.WriteTo(p, addr)
	if n > 0 {
		c.m.RelayBytes(false, n)
	}
	return n, err
}

// newTURNNet is the network relay sockets are allocated on; a variable so a test can make it fail.
var newTURNNet = func() (transport.Net, error) { return stdnet.NewNet() }

// turnConfigError is a StartTURN failure dilla.toml causes (the shared secret file, turn.relay_ip
// as written). Every other failure is the host's: the network, a bind.
type turnConfigError struct{ err error }

func (e turnConfigError) Error() string { return e.err.Error() }
func (e turnConfigError) Unwrap() error { return e.err }

// IsTURNConfigError reports whether StartTURN failed on its configuration rather than on the host,
// which `dillad serve` turns into exit 78 (fix dilla.toml) rather than 69 (try again).
func IsTURNConfigError(err error) bool {
	var ce turnConfigError
	return errors.As(err, &ce)
}

// ResolveRelayIP is the address relay sockets bind for turn.relay_ip: an IP address as written,
// or, for "auto", this host's own address — the source address of its outbound route, else its
// first non-loopback, non-link-local interface address, in prefer's address family (livekit.node_ip;
// chooseRelayIP says what happens without one). "auto" exists because the public IP is not
// a local address on bridged Docker or a NATed LXC, where binding it fails every Allocate; it is
// resolved here, at serve, because `dillad init` may run in another container than serve.
func ResolveRelayIP(s string, prefer netip.Addr) (net.IP, error) {
	if s != config.RelayIPAuto {
		ip := net.ParseIP(s)
		if ip == nil {
			return nil, turnConfigError{fmt.Errorf("turn: turn.relay_ip %q is not an IP address or %q", s, config.RelayIPAuto)}
		}
		return ip, nil
	}
	// A UDP "connect" sends nothing; it only asks the kernel which source address the route to a
	// public destination would use. 192.0.2.1 (TEST-NET-1) is never answered, only routed.
	var probed net.IP
	if c, err := (&net.Dialer{}).DialContext(context.Background(), "udp4", "192.0.2.1:9"); err == nil {
		a, ok := c.LocalAddr().(*net.UDPAddr)
		_ = c.Close()
		if ok && !a.IP.IsUnspecified() && !a.IP.IsLoopback() {
			probed = a.IP
		}
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, fmt.Errorf("turn: turn.relay_ip auto: list interface addresses: %w", err)
	}
	return chooseRelayIP(probed, addrs, prefer)
}

// chooseRelayIP is the "auto" decision once the host has been asked: probed is the route probe's
// source address (nil when the probe failed), addrs the interface addresses, prefer the family
// anchor. The relay socket and the SFU peers it reaches must share an address family, so the
// choice stays in prefer's family (livekit.node_ip); with no prefer it stays in the probe's family,
// and with neither it takes the first usable address. A host with no address of the family is a
// configuration error: the operator names one in turn.relay_ip.
func chooseRelayIP(probed net.IP, addrs []net.Addr, prefer netip.Addr) (net.IP, error) {
	isV4 := func(ip net.IP) bool { return ip.To4() != nil }
	anchor := ""
	switch {
	case prefer.IsValid():
		anchor = "livekit.node_ip"
		prefer = prefer.Unmap()
	case probed != nil:
		prefer, _ = netip.AddrFromSlice(probed)
		prefer = prefer.Unmap()
		anchor = "the route's source address"
	}
	if prefer.IsValid() {
		sameFamily := func(ip net.IP) bool { return isV4(ip) == prefer.Is4() }
		if probed != nil && sameFamily(probed) {
			return probed, nil
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && sameFamily(ipn.IP) && !ipn.IP.IsLoopback() && !ipn.IP.IsLinkLocalUnicast() {
				return ipn.IP, nil
			}
		}
		family := "IPv6"
		if prefer.Is4() {
			family = "IPv4"
		}
		return nil, turnConfigError{fmt.Errorf(
			"turn: turn.relay_ip auto: %s is %s but this host has no non-loopback %s address; set turn.relay_ip",
			anchor, prefer, family)}
	}
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() && !ipn.IP.IsLinkLocalUnicast() {
			return ipn.IP, nil
		}
	}
	return nil, turnConfigError{errors.New("turn: turn.relay_ip auto: this host has no non-loopback address; set turn.relay_ip")}
}

// peerFilter admits a CreatePermission or ChannelBind only for a peer IP in
// peers, compared unmapped so an IPv4-mapped spelling matches its IPv4 address.
// An empty set admits nothing; pion treats a nil handler as admit-all, so the
// handler is never nil.
func peerFilter(peers []netip.Addr) turn.PermissionHandler {
	allowed := make(map[netip.Addr]struct{}, len(peers))
	for _, p := range peers {
		allowed[p.Unmap()] = struct{}{}
	}
	return func(_ net.Addr, peer net.IP) bool {
		a, ok := netip.AddrFromSlice(peer)
		if !ok {
			return false
		}
		_, ok = allowed[a.Unmap()]
		return ok
	}
}

// Close stops the server, its listener and the barred re-check: the store lookups in flight are
// cancelled, and Close returns once the re-check has ended (re-review N5).
func (t *TURN) Close() error {
	t.closeOnce.Do(t.stop)
	return t.srv.Close()
}

// AllocationCount is pion's live allocation count, for diagnostics.
func (t *TURN) AllocationCount() int { return t.srv.AllocationCount() }

// turnAuth is pion's LongTermTURNRESTAuthHandler (lt_cred.go:90-127, v5.0.13) on the instance clock,
// with the expiry checked on Allocate ONLY (G33, draft-uberti-behave-turn-rest-00 §4.2): Chrome
// refreshes an allocation every 540 s and its permissions every 240 s with the credential it
// allocated with, so a per-request expiry ended every relayed call at most 240 s after the
// credential expired. Every other request made with a credential is refused once maxAge has passed
// since that credential was issued — the issue time it carries (review M6) — so
// turn.max_allocation_age bounds how long one credential keeps a relayed path. It does not bound an
// allocation a newer credential of the same device refreshes (pion binds an allocation to the user
// id, the device), nor ChannelData and Send indications, which are never authenticated.
//
// Every method of a credential issued at or before its device's cut, or before the process started,
// is refused (rev, review I1 and re-review N3); the cut map is fed by the call routes and by the
// barred lookup turnHandlers runs once a request is authenticated. The
// "<expiry_s>:<device_id>:<issued_ms>" shape (parseRelayUsername, with an issue time no more than
// issueSkew ahead of the clock and a lifetime within ttl, turn.credential_ttl, plus that skew) and
// the HMAC are checked on every request; the user id is the device id.
func turnAuth(secret string, clk clock.Clock, ttl, maxAge time.Duration, rev *RelayRevocations) turn.AuthHandler {
	skew := issueSkew.Milliseconds()
	return func(ra *turn.RequestAttributes) (string, []byte, bool) {
		expiry, dev, issued, ok := parseRelayUsername(ra.Username)
		if !ok {
			return "", nil, false
		}
		now := clk.Now()
		nowMs := now.UnixMilli()
		if issued > nowMs+skew {
			return "", nil, false
		}
		if life := expiry*1000 - issued; life < 0 || life > ttl.Milliseconds()+skew {
			return "", nil, false
		}
		if ra.Method == stun.MethodAllocate {
			if expiry < now.Unix() {
				return "", nil, false
			}
		} else if nowMs > issued+maxAge.Milliseconds() {
			return "", nil, false
		}
		// In memory only: pion calls this handler BEFORE it checks MESSAGE-INTEGRITY with the key
		// returned here (internal/server/util.go:108-128), so nothing an unauthenticated request
		// names may reach the store or the barred cache from here. The barred lookup runs on the
		// OnAuth event instead, after the integrity check (turnHandlers).
		if rev.cutCovers(dev, issued) {
			return "", nil, false
		}
		mac := hmac.New(sha1.New, []byte(secret))
		_, _ = mac.Write([]byte(ra.Username))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		return dev, turn.GenerateAuthKey(ra.Username, ra.Realm, password), true
	}
}

const (
	// issueSkew is how far ahead of the relay's clock a credential's issue time may be: the call
	// routes mint on the same clock, so only `dillad doctor` in another process can differ at all.
	issueSkew = 2 * time.Second
	// maxExpiryDigits and maxIssuedDigits bound the username's numbers: unix seconds and unix
	// milliseconds fit in 12 and 15 decimal digits until the year 33658.
	maxExpiryDigits = 12
	maxIssuedDigits = 15
)

// parseRelayUsername takes a relay username "<expiry_s>:<device_id>:<issued_ms>" apart (re-review
// N8): exactly three fields, both numbers unsigned decimal digits within their length bounds, and
// the device field a device id in its canonical spelling.
func parseRelayUsername(user string) (expiry int64, dev string, issued int64, ok bool) {
	fields := strings.Split(user, ":")
	if len(fields) != 3 {
		return 0, "", 0, false
	}
	if expiry, ok = decimalField(fields[0], maxExpiryDigits); !ok {
		return 0, "", 0, false
	}
	if issued, ok = decimalField(fields[2], maxIssuedDigits); !ok {
		return 0, "", 0, false
	}
	if d, err := id.Parse(fields[1]); err != nil || d.String() != fields[1] {
		return 0, "", 0, false
	}
	return expiry, fields[1], issued, true
}

// decimalField is s as an unsigned decimal of 1 to maxDigits ASCII digits: no sign, no space, no
// other base.
func decimalField(s string, maxDigits int) (int64, bool) {
	if s == "" || len(s) > maxDigits {
		return 0, false
	}
	var n int64
	for i := range len(s) {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int64(c-'0')
	}
	return n, true
}

// deviceOf is the device a TURN user id names. pion v5.0.13 passes the quota
// handler and the allocation events the user id the auth handler returned —
// the device id (internal/server/turn.go:212, allocation_manager.go:279-281) —
// but a REST username "<expiry>:<device_id>:<issued>" is taken apart the way
// pion's own handler does (lt_cred.go:100-105: the second field), so the quota
// holds whichever spelling a future pion hands over.
func deviceOf(user string) string {
	if fields := strings.Split(user, ":"); len(fields) > 1 {
		return fields[1]
	}
	return user
}

// turnHandlers wires both halves of the per-device quota — the admission callback, which counts a
// refusal, and the release on an allocation's deletion — and keeps the live allocation count the
// gauge reports. Wiring only the admission would cap a device for the life of the process after
// allocations_per_device allocations. An allocation pion fails to create after admitting it fires
// no event; countingRelay frees that slot. The gauge is published under the count's lock, so a
// creation and a deletion racing cannot leave a stale value behind.
//
// The barred lookup (review I1) runs here, on requests pion has authenticated: OnAuth fires with
// verdict true only after the request's MESSAGE-INTEGRITY verified under the credential's key
// (internal/server/util.go:124-130), so only a holder of a credential this instance minted can
// cause a store read or a cache entry. A barred device is cut there — its sockets close and its
// credentials so far are refused. OnAuth cannot refuse the request it reports; for an Allocate the
// quota handler, which pion runs after it on the same goroutine (internal/server/turn.go:33,212),
// refuses a device the lookup has just found barred, from the cache alone.
//
// The issue time an Allocate's relay socket is judged by (RelayRevocations.track) flows the same
// way: OnAuth records it for the device and client address (authenticated), and the quota handler
// turns it into a pending Allocate when it admits the request, or drops it when it refuses (486, a
// device known to be barred). An Allocate pion refuses before its quota handler (437, 440) never
// becomes pending (re-review N6). ctx ends the store lookups with the relay.
func turnHandlers(ctx context.Context, q *AllocationQuota, m TURNMetrics, rev *RelayRevocations) (turn.QuotaHandler, turn.EventHandler) {
	var mu sync.Mutex
	live := 0
	count := func(delta int) {
		mu.Lock()
		defer mu.Unlock()
		live += delta
		m.Allocations(live)
	}
	quota := func(user, _ string, src net.Addr) bool {
		dev := deviceOf(user)
		admitted := dev != "" && !rev.knownBarred(dev)
		if admitted && !q.Allow(dev) {
			m.QuotaRefused()
			admitted = false
		}
		if dev != "" {
			rev.admitAllocate(dev, addrKey(src), admitted)
		}
		return admitted
	}
	events := turn.EventHandler{
		OnAuth: func(src, _ net.Addr, _, username, _, method string, verdict bool) {
			if !verdict {
				return
			}
			dev := deviceOf(username)
			if method == stun.MethodAllocate.String() {
				// The issue time the relay socket's track decision needs (turnrevoke.go track).
				if _, _, issued, ok := parseRelayUsername(username); ok {
					rev.authenticated(dev, addrKey(src), issued)
				}
			}
			rev.checkBarred(ctx, dev)
		},
		OnAllocationCreated: func(_, _ net.Addr, _, _, _ string, _ net.Addr, _ int) {
			count(1)
		},
		OnAllocationDeleted: func(_, _ net.Addr, _, user, _ string) {
			q.Release(deviceOf(user))
			count(-1)
		},
	}
	return quota, events
}

// addrKey is the client transport address that ties an Allocate's OnAuth to its quota decision.
func addrKey(a net.Addr) string {
	if a == nil {
		return ""
	}
	return a.Network() + "/" + a.String()
}

// AllocationQuota counts live TURN allocations per device.
type AllocationQuota struct {
	mu   sync.Mutex
	max  int
	live map[string]int
}

// NewAllocationQuota allows at most max live allocations per device.
func NewAllocationQuota(maxPerDevice int) *AllocationQuota {
	return &AllocationQuota{max: maxPerDevice, live: map[string]int{}}
}

// Allow takes a slot for dev, or reports that it has none left.
func (q *AllocationQuota) Allow(dev string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.live[dev] >= q.max {
		return false
	}
	q.live[dev]++
	return true
}

// Release gives one of dev's slots back.
func (q *AllocationQuota) Release(dev string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if n := q.live[dev]; n > 1 {
		q.live[dev] = n - 1
	} else {
		delete(q.live, dev)
	}
}

// slogFactory routes pion's leveled logging into dillad's slog logger. Trace
// is dropped, and Debug goes to slog's Debug, which the default info level
// hides: pion logs every STUN transaction at those levels.
type slogFactory struct{ log *slog.Logger }

func (f slogFactory) NewLogger(scope string) logging.LeveledLogger {
	l := f.log
	if l == nil {
		l = slog.New(slog.DiscardHandler)
	}
	return slogLeveled{l: l.With("component", "turn", "scope", scope)}
}

type slogLeveled struct{ l *slog.Logger }

func (s slogLeveled) Trace(string)          {}
func (s slogLeveled) Tracef(string, ...any) {}
func (s slogLeveled) Debug(msg string)      { s.l.Debug(msg) }
func (s slogLeveled) Debugf(format string, args ...any) {
	s.logf(slog.LevelDebug, format, args...)
}
func (s slogLeveled) Info(msg string) { s.l.Info(msg) }
func (s slogLeveled) Infof(format string, args ...any) {
	s.logf(slog.LevelInfo, format, args...)
}
func (s slogLeveled) Warn(msg string) { s.l.Warn(msg) }
func (s slogLeveled) Warnf(format string, args ...any) {
	s.logf(slog.LevelWarn, format, args...)
}
func (s slogLeveled) Error(msg string) { s.l.Error(msg) }
func (s slogLeveled) Errorf(format string, args ...any) {
	s.logf(slog.LevelError, format, args...)
}

func (s slogLeveled) logf(level slog.Level, format string, args ...any) {
	if !s.l.Enabled(context.Background(), level) {
		return
	}
	s.l.Log(context.Background(), level, fmt.Sprintf(format, args...))
}
