package server

import (
	"context"
	"net"
	"net/netip"
	"time"

	"github.com/pion/transport/v4"
	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
)

// ACMEIPSettingsForTest is what acme_ip fixes about issuance when the operator
// sets nothing.
func ACMEIPSettingsForTest() acmeSettings {
	return settingsFor(config.TLS{Mode: ModeACMEIP})
}

// TURNAuthForTest is the auth handler StartTURN installs, on clk, for maxAge, reading rev (nil: a
// fresh RelayRevocations nothing cuts).
func TURNAuthForTest(secret string, clk clock.Clock, maxAge time.Duration, rev *RelayRevocations) turn.AuthHandler {
	if rev == nil {
		rev = NewRelayRevocations(maxAge, clk)
	}
	return turnAuth(secret, clk, maxAge, rev)
}

// CheckHoldersForTest runs one pass of the relay's barred re-check of the devices holding sockets.
func (r *RelayRevocations) CheckHoldersForTest() { r.checkHolders() }

// RelayCutsForTest is how many cuts r holds.
func (r *RelayRevocations) RelayCutsForTest() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.cuts)
}

// BarredCacheLenForTest is how many barred lookups r has cached.
func (r *RelayRevocations) BarredCacheLenForTest() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cache == nil {
		return 0
	}
	return r.cache.ll.Len()
}

// MaxRelayCutsForTest is the cut map's cap.
const MaxRelayCutsForTest = maxRelayCuts

// TURNHandlersForTest is the quota and event pair StartTURN installs over a fresh quota of
// maxPerDevice, reporting to m (nil reports nowhere).
func TURNHandlersForTest(maxPerDevice int, m TURNMetrics) (turn.QuotaHandler, turn.EventHandler) {
	if m == nil {
		m = noTURNMetrics{}
	}
	return turnHandlers(NewAllocationQuota(maxPerDevice), m, NewRelayRevocations(time.Hour, clock.System()))
}

// FailTURNNetForTest makes StartTURN's network setup fail with err until the returned restore runs.
func FailTURNNetForTest(err error) (restore func()) {
	prev := newTURNNet
	newTURNNet = func() (transport.Net, error) { return nil, err }
	return func() { newTURNNet = prev }
}

// EmitForTest drives the certmagic OnEvent hook BuildTLS installed.
func (t *TLS) EmitForTest(ctx context.Context, event string, data map[string]any) error {
	return t.magic.OnEvent(ctx, event, data)
}

// TCPRelayRefusalsForTest asks the relay generator StartTURN installs (on 127.0.0.1, over a quota
// of one that dev holds) for a TCP relay listener and for a Connect's outbound TCP connection to
// peer, and answers both errors and whether dev's slot is free again.
func TCPRelayRefusalsForTest(dev string, peer net.Addr) (listenErr, connErr error, freed bool) {
	relayNet, err := newTURNNet()
	if err != nil {
		return err, err, false
	}
	q := NewAllocationQuota(1)
	q.Allow(dev)
	g := &countingRelay{
		RelayAddressGeneratorStatic: &turn.RelayAddressGeneratorStatic{
			RelayAddress: net.IPv4(127, 0, 0, 1), Address: "127.0.0.1", Net: relayNet,
		},
		m: noTURNMetrics{}, q: q,
	}
	if ln, _, err := g.AllocateListener(turn.AllocateListenerConfig{Network: "tcp4", UserID: dev}); err == nil {
		_ = ln.Close()
	} else {
		listenErr = err
	}
	if c, err := g.AllocateConn(turn.AllocateConnConfig{Network: "tcp4", UserID: dev,
		LocalAddr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}, RemoteAddr: peer}); err == nil {
		_ = c.Close()
	} else {
		connErr = err
	}
	return listenErr, connErr, q.Allow(dev)
}

// ChooseRelayIPForTest is the "auto" decision over a probe result and interface addresses.
func ChooseRelayIPForTest(probed net.IP, addrs []net.Addr, prefer netip.Addr) (net.IP, error) {
	return chooseRelayIP(probed, addrs, prefer)
}
