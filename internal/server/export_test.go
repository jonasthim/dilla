package server

import (
	"context"

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

// TURNAuthForTest is the auth handler StartTURN installs, on clk.
func TURNAuthForTest(secret string, clk clock.Clock) turn.AuthHandler {
	return turnAuth(secret, clk)
}

// TURNHandlersForTest is the quota and event pair StartTURN installs over a
// fresh quota of maxPerDevice.
func TURNHandlersForTest(maxPerDevice int) (turn.QuotaHandler, turn.EventHandler) {
	return turnHandlers(NewAllocationQuota(maxPerDevice))
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
