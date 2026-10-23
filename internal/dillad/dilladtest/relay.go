package dilladtest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// UP9 (R-UP11): the relay side of a sidecar host. With HostOptions.TURNListen set, the instance
// hands out a TURN relay on that address and, like `dillad serve` (cmd/dillad turnowner.go), asks
// the media process's media.json who serves it:
//
//   - media.json lists "turn" (a web3.13+ `dillad media`): every cut is applied to the host's own
//     RelayRevocations first and forwarded to the media relay over media.sock
//     (server.RelayRevoker), and the host serves api.sock, the media relay's barred lookup;
//   - it does not (a web3.11 SFU, DILLA_SFU_BIN): the host binds turn.listen and serves the relay
//     itself, as serve does during the transition.
//
// Both sockets live in the host's state directory, which a test shares with the media process.

// mediaTURNWait is how long the host waits for a TURN-capable media process to list "turn" (its
// bind can follow its READY by a moment); serve's turnHandoffWait.
const mediaTURNWait = 7 * time.Second

// mediaStateFile is `dillad media`'s media.json, as cmd/dillad writes it; only the fields the
// owner decision reads.
type mediaStateFile struct {
	MediaLevel   int      `json:"media_level"`
	Capabilities []string `json:"capabilities"`
}

// mediaServesTURN reads media.json in dir, waiting up to mediaTURNWait when it names a level that
// serves TURN but has not listed it yet. A missing or unreadable file means no.
func mediaServesTURN(ctx context.Context, dir string) bool {
	deadline := time.Now().Add(mediaTURNWait)
	for {
		var st mediaStateFile
		raw, err := os.ReadFile(filepath.Join(dir, "media.json")) //nolint:gosec // G304: the host's own state directory
		if err == nil {
			err = json.Unmarshal(raw, &st)
		}
		switch {
		case err != nil:
			return false
		case slices.Contains(st.Capabilities, "turn"):
			return true
		case st.MediaLevel < 2 || time.Now().After(deadline) || ctx.Err() != nil:
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// lazyBarred is api.BarredDevices over the instance current when a lookup comes: the relay is
// built before the server (and its repository) exists, and outlives a Restore.
type lazyBarred struct{ h *Host }

func (b lazyBarred) DeviceBarred(ctx context.Context, device id.ID) (bool, error) {
	s := b.h.Server()
	if s == nil {
		return false, errors.New("dilladtest: no instance yet")
	}
	return api.BarredDevices{Repo: s.Repo()}.DeviceBarred(ctx, device)
}

// relayClock is the relay as the call routes see it: the test host's instance clock is fake (frozen,
// moved by POST /debug/clock) while both relays run on the wall clock, as they do with serve, whose
// instance clock is the wall clock. Mint's since and Revoke's at are instance times; each is moved
// onto the wall clock by the offset between the two clocks at the call, so a start that began just
// now is not taken for one that began before the relay's floor (a 429 for ever otherwise).
type relayClock struct {
	inner api.RelayRevoker
	clk   clock.Clock
}

func (r relayClock) wall(t time.Time) time.Time { return t.Add(time.Since(r.clk.Now())) }

func (r relayClock) Revoke(device id.ID, at time.Time) { r.inner.Revoke(device, r.wall(at)) }

func (r relayClock) Mint(device id.ID, since time.Time) (time.Time, time.Duration) {
	return r.inner.Mint(device, r.wall(since))
}

// relayClockAcks is relayClock over a forwarder, which also says which cuts the media relay has not
// acknowledged (api.RelayAcks).
type relayClockAcks struct {
	relayClock
	acks api.RelayAcks
}

func (r relayClockAcks) Unacked(device id.ID) bool { return r.acks.Unacked(device) }

// startRelay wires the relay as described above. It runs after the sidecar SFU answers and before
// the server is built, which takes h.relay as dillad.Options.Relay.
func (h *Host) startRelay(ctx context.Context) error {
	tc := h.cfg.TURN
	keep := max(tc.MaxAllocationAge.Value(), tc.CredentialTTL.Value())
	log := h.Log()
	rev := server.NewRelayRevocations(keep, clock.System()).WithBarred(lazyBarred{h}, log).WithCredentialTTL(tc.CredentialTTL.Value())
	dir := h.cfg.Instance.DataDir
	h.relayRev = rev
	if mediaServesTURN(ctx, dir) {
		fwd := server.NewRelayRevoker(rev, server.ControlClient(server.ControlSocketPath(dir, server.MediaSocketName)), keep, clock.System(), log)
		fctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() {
			defer close(done)
			fwd.Run(fctx)
		}()
		h.relayStops = append(h.relayStops, func() { cancel(); <-done })
		h.relay, h.relayFwd = relayClockAcks{relayClock{fwd, h.clk}, fwd}, fwd
	} else {
		ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", tc.Listen)
		if err != nil {
			return fmt.Errorf("dilladtest: the media process serves no TURN, and turn.listen %s will not bind here: %w", tc.Listen, err)
		}
		peers := server.TURNPeers{Addrs: []netip.Addr{netip.MustParseAddr("127.0.0.1")}}
		peers.PortLo, peers.PortHi = uint16(h.o.SFUUDPPort), uint16(h.o.SFUUDPPort) //nolint:gosec // G115: a port number the caller chose
		t, err := server.StartTURN(tc, ln, netip.MustParseAddr("127.0.0.1"), peers, nil, rev, clock.System(), log)
		if err != nil {
			_ = ln.Close()
			return fmt.Errorf("dilladtest: start the host's own TURN relay: %w", err)
		}
		h.relayStops = append(h.relayStops, func() { _ = t.Close() })
		h.relay, h.relayTURN = relayClock{rev, h.clk}, t
	}
	ln, err := server.ListenControl(ctx, server.ControlSocketPath(dir, server.APISocketName), log)
	if err != nil {
		h.stopRelay()
		return fmt.Errorf("dilladtest: api.sock: %w", err)
	}
	h.relayStops = append(h.relayStops, server.ServeControl(ln, h.apiSocketHandler(), log))
	return nil
}

// apiSocketHandler is serve's api.sock: the instance's ControlHandler, current per request, and GET
// /relay/state.
func (h *Host) apiSocketHandler() http.Handler {
	since := time.Now().UnixMilli()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/relay/state" {
			cut := h.relayRev.State()
			st := server.RelayState{Owner: "api", Cuts: cut.Cuts, Floor: cut.Floor, Started: since}
			if h.relayFwd != nil {
				st.Unacked = h.relayFwd.UnackedCount()
			}
			if h.relayTURN != nil {
				st.Serving, st.Allocations, st.Listen = true, h.relayTURN.AllocationCount(), h.cfg.TURN.Listen
			}
			server.WriteControlJSON(w, st)
			return
		}
		s := h.Server()
		if s == nil {
			http.Error(w, "no instance", http.StatusServiceUnavailable)
			return
		}
		s.ControlHandler().ServeHTTP(w, r)
	})
}

// stopRelay stops api.sock, the forwarder and the host's own relay, last first.
func (h *Host) stopRelay() {
	for i := len(h.relayStops) - 1; i >= 0; i-- {
		h.relayStops[i]()
	}
	h.relayStops = nil
}
