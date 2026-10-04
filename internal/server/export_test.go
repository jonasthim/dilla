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

// TURNAuthForTest is the auth handler StartTURN installs, on clk, for ttl and maxAge.
func TURNAuthForTest(secret string, clk clock.Clock, ttl, maxAge time.Duration) turn.AuthHandler {
	return turnAuth(secret, clk, ttl, maxAge)
}

// TURNHandlersForTest is the quota and event pair StartTURN installs over a fresh quota of
// maxPerDevice, reporting to m (nil reports nowhere).
func TURNHandlersForTest(maxPerDevice int, m TURNMetrics) (turn.QuotaHandler, turn.EventHandler) {
	if m == nil {
		m = noTURNMetrics{}
	}
	return turnHandlers(NewAllocationQuota(maxPerDevice), m)
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

// ChooseRelayIPForTest is the "auto" decision over a probe result and interface addresses.
func ChooseRelayIPForTest(probed net.IP, addrs []net.Addr, prefer netip.Addr) (net.IP, error) {
	return chooseRelayIP(probed, addrs, prefer)
}
