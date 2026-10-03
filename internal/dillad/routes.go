package dillad

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strings"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/ops"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// SFU is the in-process LiveKit `dillad serve` starts when livekit.enabled: the call routes' SFU
// (token mint, room and permission control), its HTTP origin /rtc is proxied to, and the verifier of
// the room tokens it minted, which the /rtc join gate reads. *sfu.Server is one.
type SFU interface {
	api.CallTokens
	// HTTPURL is the SFU's signalling origin over HTTP, e.g. http://127.0.0.1:7880.
	HTTPURL() string
	// VerifyToken answers the identity and room of a room-join token the SFU's key signed.
	VerifyToken(token string) (identity, room string, err error)
}

// RTCGate answers whether device is a current leaf of the live call whose room is room;
// *api.Calls is one.
type RTCGate interface {
	CurrentLeafOfRoom(ctx context.Context, room string, device id.ID) (bool, error)
}

// planTwo is what Plan 2's handler groups are built over: the composition root's own collaborators,
// shared with Plan 1's routes rather than built a second time.
type planTwo struct {
	o        Options
	instance store.InstanceRow
	sessions *auth.Sessions
	limiter  *server.RateLimiter
	delivery *ds.DS
	gw       *gateway.Gateway
	blobs    *blob.Store
	keys     api.FrankingKeys
	calls    api.CallsConfig
	diagnose func(context.Context) ops.Report
}

// mountPlanTwo mounts every handler group Plan 2 built in internal/api (protocol/09 § Communities
// through § Admin). The groups register their handlers bare; each is registered here through a view
// of the mux that puts the enrolled-session middleware and the [limits.rate] meter in front of every
// route (api.SessionRoute), the same two layers Plan 1's delivery-service routes sit behind. Every
// group that takes the delivery service gets the one *ds.DS, every group that takes a resolver the
// one api.Resolver, and the readable fan-out is the gateway's.
func mountPlanTwo(mux *server.Mux, p planTwo) *api.Calls {
	cfg := p.o.Config
	repo, clk, log := p.o.Repo, p.o.Clock, p.o.Log
	res := api.NewResolver(repo)
	// P2-6: a group DM holds at most as many participants as its call can, so every participant
	// fits in the DM's call.
	maxGroupDM := cfg.LiveKit.MaxVoiceParticipants
	m := mux.Wrapped(api.SessionRoute(p.sessions, p.limiter))
	// An interface holding a nil *sfu.Server is not a nil interface, so the SFU is handed over only
	// when there is one; without it the call routes answer 501 for a call that would open.
	var tokens api.CallTokens
	if p.o.SFU != nil {
		tokens = p.o.SFU
	}
	calls := api.NewCalls(repo, res, tokens, p.calls, clk, log).WithCounters(p.o.Metrics)

	// The join is metered on the ("invite", client address) bucket GET /i/{code} is on, so a join
	// is not a way round the limit on guessing codes (task 5).
	api.NewCommunities(repo, p.delivery, clk, log).
		WithInviteMeter(p.limiter, cfg.Server.TrustedProxyCIDRs).Register(m)
	channels := api.NewChannels(repo, p.delivery, clk, maxGroupDM, log)
	channels.Register(m)
	channels.RegisterMembers(m)
	api.NewRoles(repo, clk, cfg.Auth.WebAuthn.RPID, log).WithDS(p.delivery).WithCalls(tokens, calls).Register(m)
	api.NewBans(repo, p.delivery, clk, log).Register(m)
	api.NewInvites(repo, clk, "https://"+urlHost(cfg.Instance.Domain), log).Register(m)
	api.NewDMs(repo, p.delivery, clk, p.instance.InstanceID, maxGroupDM, log).Register(m)
	api.NewReadable(repo, res, p.gw, p.keys, clk, log).Register(m)
	api.NewBlobs(repo, p.blobs, res, cfg.Blobs, clk, log).Register(m)
	api.NewReports(repo, p.keys, clk, log).Register(m)
	calls.Register(m)
	api.NewAdmin(repo, p.blobs, clk, log).WithMetrics(p.o.Metrics).WithDiagnostics(p.diagnose).Register(m)
	return calls
}

// callsConfig is what the call routes hand a client besides the token (task 16): the signalling URL,
// which is this instance's own origin because /rtc is proxied to the SFU (mountRTC), and, when
// turn.enabled, the relay URL and the shared secret its REST credentials are minted under. The relay
// is TURN over TLS on server.listen's port in the direct-TLS modes (the 443 demux), and plain TURN
// over TCP on turn.listen's port behind a proxy, which never carries TURN on 443.
func callsConfig(cfg *config.Config) (api.CallsConfig, error) {
	host := cfg.Instance.Domain
	if cfg.TLS.Mode == config.TLSModeACMEIP {
		host = cfg.Instance.PublicIP.String()
	}
	c := api.CallsConfig{
		LiveKitURL: "wss://" + urlHost(host), CredentialTTL: cfg.TURN.CredentialTTL.Value(),
		MaxVoiceParticipants: cfg.LiveKit.MaxVoiceParticipants, MaxPublishers: cfg.LiveKit.MaxPublishers,
		MaxAudioBitrateKbps: cfg.LiveKit.MaxAudioBitrateKbps, MaxShareBitrateKbps: cfg.LiveKit.MaxShareBitrateKbps,
		VP9: cfg.LiveKit.VP9,
	}
	if !cfg.TURN.Enabled {
		return c, nil
	}
	secret, err := ops.ReadSecret(cfg.TURN.SharedSecretFile)
	if err != nil {
		return api.CallsConfig{}, fmt.Errorf("dillad: turn.shared_secret_file: %w", err)
	}
	scheme, listen := "turns", cfg.Server.Listen
	if cfg.BehindProxy() {
		scheme, listen = "turn", cfg.TURN.Listen
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		// config.Validate refuses turn.enabled in behind_proxy with no turn.listen; a config that
		// never went through it offers no relay rather than one on a port nothing listens on.
		return c, nil //nolint:nilerr // no relay is the answer, not a failure
	}
	c.TURNSecret = secret
	c.TURNURLs = []string{fmt.Sprintf("%s:%s:%s?transport=tcp", scheme, urlHost(host), port)}
	if cfg.TURN.PublicURL != "" {
		// The operator knows what the world reaches: a proxy's port that differs from the listen
		// port, or a TLS-terminating proxy in front of the plaintext relay (turns:).
		c.TURNURLs = []string{cfg.TURN.PublicURL}
	}
	return c, nil
}

// urlHost is host as it is written inside a URL: an IPv6 literal in brackets, anything else as is.
func urlHost(host string) string {
	if a, err := netip.ParseAddr(host); err == nil && a.Is6() && !a.Is4In6() {
		return "[" + a.String() + "]"
	}
	return host
}

// mountRTC proxies LiveKit's signalling paths (/rtc, /rtc/validate, /rtc/v1, /rtc/v1/validate) to
// the in-process SFU, which binds livekit.bind_address (loopback by default) and so is reachable by
// a client only through this origin. The routes carry no dilla session; instead (DEV-25, DEV-44):
//
//   - only GET reaches LiveKit (405 otherwise): LiveKit joins a participant before its WebSocket
//     upgrade refuses a non-GET, and reads `publish` from a POST body too;
//   - the access token (the access_token query parameter, or a Bearer header) must be one the SFU's
//     key signed (403 E_FORBIDDEN), its identity a device id (403 E_FORBIDDEN), and that device a
//     current leaf of the live call whose room the token names (403 E_LEAF_NOT_CURRENT) — so a
//     device the call group removed cannot rejoin with a token LiveKit refreshed for it;
//   - the `publish` query parameter is deleted (on the parsed values, so a percent-encoded spelling
//     goes too): it would open a second "<identity>#<x>" participant no gate admitted;
//   - CF-Connecting-IP and X-Real-IP are deleted and X-Forwarded-For replaced by the one client
//     address server.RealIP resolved behind the trusted proxies: LiveKit prefers the first two over
//     X-Forwarded-For, and nothing a client wrote reaches it.
//
// The upgrade itself is httputil.ReverseProxy's own.
func mountRTC(mux *server.Mux, sfu SFU, gate RTCGate, trusted []netip.Prefix) error {
	upstream, err := url.Parse(sfu.HTTPURL())
	if err != nil {
		return fmt.Errorf("dillad: the SFU's URL %q: %w", sfu.HTTPURL(), err)
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = r.In.Host
			if q := r.Out.URL.Query(); q.Has("publish") {
				q.Del("publish")
				r.Out.URL.RawQuery = q.Encode()
			}
			r.Out.Header.Del("CF-Connecting-IP")
			r.Out.Header.Del("X-Real-IP")
			r.Out.Header.Del("X-Forwarded-For")
			if a := server.RealIP(r.In, trusted); a.IsValid() {
				r.Out.Header.Set("X-Forwarded-For", a.String())
			}
		},
		// Stream at once: /rtc is a WebSocket.
		FlushInterval: -1,
	}
	gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := admitRTC(r, sfu, gate); err != nil {
			server.WriteError(w, err)
			return
		}
		proxy.ServeHTTP(w, r)
	})
	mux.Handle("/rtc", gated)
	mux.Handle("/rtc/", gated)
	return nil
}

// admitRTC is the join gate in front of LiveKit.
func admitRTC(r *http.Request, sfu SFU, gate RTCGate) error {
	token := r.URL.Query().Get("access_token")
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	}
	identity, room, err := sfu.VerifyToken(token)
	if err != nil {
		return server.Errorf(server.CodeForbidden, "the access token is not one this instance minted")
	}
	dev, err := id.Parse(identity)
	if err != nil {
		return server.Errorf(server.CodeForbidden, "the token's identity is not a device")
	}
	ok, err := gate.CurrentLeafOfRoom(r.Context(), room, dev)
	if err != nil {
		return err
	}
	if !ok {
		return server.Errorf(server.CodeLeafNotCurrent, "your device is not a current leaf of this call")
	}
	return nil
}
