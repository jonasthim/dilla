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
	"strconv"
	"strings"
	"sync"
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
	srv   *turn.Server
	quota *AllocationQuota
}

// TURNCredential mints the REST-style ephemeral credential pion's
// LongTermTURNRESTAuthHandler validates: username "<expiry>:<device_id>",
// password base64(HMAC-SHA1(secret, username)). The expiry is unix seconds.
func TURNCredential(secret string, deviceID id.ID, ttl time.Duration, now time.Time) (username, password string) {
	username = fmt.Sprintf("%d:%s", now.Add(ttl).Unix(), deviceID.String())
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
// m receives the relay's counters; nil reports nowhere.
func StartTURN(c config.TURN, ln net.Listener, anchor netip.Addr, peers []netip.Addr, m TURNMetrics, clk clock.Clock, log *slog.Logger) (*TURN, error) {
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
	q := NewAllocationQuota(perDevice)
	quota, events := turnHandlers(q, m)
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm:         c.Realm,
		AuthHandler:   turnAuth(secret, clk, ttl, maxAge),
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
				m: m,
			},
			PermissionHandler: peerFilter(peers),
		}},
	})
	if err != nil {
		return nil, fmt.Errorf("turn: %w", err)
	}
	return &TURN{srv: srv, quota: q}, nil
}

// countingRelay allocates relay sockets as RelayAddressGeneratorStatic does and counts what crosses
// them (dilla_turn_relay_bytes_total). Only UDP relays exist: TCP allocations are not offered.
type countingRelay struct {
	*turn.RelayAddressGeneratorStatic
	m TURNMetrics
}

func (g *countingRelay) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	conn, addr, err := g.RelayAddressGeneratorStatic.AllocatePacketConn(conf)
	if err != nil {
		return nil, nil, err
	}
	return &countingConn{PacketConn: conn, m: g.m}, addr, nil
}

// countingConn is a relay socket: what it reads came from a peer and goes on to the client, what it
// writes goes to a peer.
type countingConn struct {
	net.PacketConn
	m TURNMetrics
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

// Close stops the server and closes its listener.
func (t *TURN) Close() error { return t.srv.Close() }

// AllocationCount is pion's live allocation count, for diagnostics.
func (t *TURN) AllocationCount() int { return t.srv.AllocationCount() }

// turnAuth is pion's LongTermTURNRESTAuthHandler (lt_cred.go:90-127, v5.0.13) on the instance clock,
// with the expiry checked on Allocate ONLY (G33, draft-uberti-behave-turn-rest-00 §4.2): Chrome
// refreshes an allocation every 540 s and its permissions every 240 s with the credential it
// allocated with, so a per-request expiry ended every relayed call at most 240 s after the
// credential expired. Every other request is refused once maxAge has passed since the credential
// was issued (expiry − ttl): turn.max_allocation_age bounds how long one relayed path lives. The
// "<expiry>:<device>" shape and the HMAC are checked on every request; the user id is the device id.
func turnAuth(secret string, clk clock.Clock, ttl, maxAge time.Duration) turn.AuthHandler {
	return func(ra *turn.RequestAttributes) (string, []byte, bool) {
		expiry, dev, ok := strings.Cut(ra.Username, ":")
		if !ok || dev == "" {
			return "", nil, false
		}
		t, err := strconv.ParseInt(expiry, 10, 64)
		if err != nil {
			return "", nil, false
		}
		now := clk.Now().Unix()
		if ra.Method == stun.MethodAllocate {
			if t < now {
				return "", nil, false
			}
		} else if issued := t - int64(ttl/time.Second); now > issued+int64(maxAge/time.Second) {
			return "", nil, false
		}
		mac := hmac.New(sha1.New, []byte(secret))
		_, _ = mac.Write([]byte(ra.Username))
		password := base64.StdEncoding.EncodeToString(mac.Sum(nil))
		return dev, turn.GenerateAuthKey(ra.Username, ra.Realm, password), true
	}
}

// deviceOf is the device a TURN user id names. pion v5.0.13 passes the quota
// handler and the allocation events the user id the auth handler returned —
// the device id (internal/server/turn.go:212, allocation_manager.go:279-281) —
// but a REST username "<expiry>:<device_id>" is taken apart the way pion's own
// handler does (lt_cred.go:100-105), so the quota holds whichever spelling a
// future pion hands over.
func deviceOf(user string) string {
	if _, dev, ok := strings.Cut(user, ":"); ok {
		return dev
	}
	return user
}

// turnHandlers wires both halves of the per-device quota — the admission callback, which counts a
// refusal, and the release on an allocation's deletion — and keeps the live allocation count the
// gauge reports. Wiring only the admission would cap a device for the life of the process after
// allocations_per_device allocations. An allocation pion fails to create after admitting it (a
// relay port that will not bind) keeps its slot until restart; pion reports no event for that path.
func turnHandlers(q *AllocationQuota, m TURNMetrics) (turn.QuotaHandler, turn.EventHandler) {
	var mu sync.Mutex
	live := 0
	count := func(delta int) {
		mu.Lock()
		live += delta
		n := live
		mu.Unlock()
		m.Allocations(n)
	}
	quota := func(user, _ string, _ net.Addr) bool {
		dev := deviceOf(user)
		if dev == "" {
			return false
		}
		if !q.Allow(dev) {
			m.QuotaRefused()
			return false
		}
		return true
	}
	events := turn.EventHandler{
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
