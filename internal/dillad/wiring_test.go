package dillad_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

// wiring_test.go is task 27a: the composition root builds the gateway and the delivery service,
// mounts every delivery-service route and GET /gateway on the one mux, hands the gateway's ticket
// store to POST /v1/gateway/ticket, and exposes the accessors task 29's harness needs.
//
// DEVIATION FROM THE BRIEF'S STEP 1 (deviation B35): the brief's newServer builds its config with
// config.Default() and a bare temp database, but New reads the instance row (`dillad init`'s) and
// the database must be migrated, so newServer starts from testConfig — which does exactly what
// `dillad init` does — and passes the wasi core explicitly, because the config has no [mls] table.

// testCorePath is the wasm32-wasip1 build of dilla-core-wasi the mlswasi tests use. CI downloads
// it there from the rust-wasi job; locally it is built with
// `cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked` and copied.
func testCorePath(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "mlswasi", "testdata", "dilla_core_wasi.wasm"))
	if err != nil {
		t.Fatalf("resolve the wasi core: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("%s is missing: build it with\n"+
			"  cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked\n"+
			"and copy it there (CI downloads the rust-wasi job's artifact): %v", path, err)
	}
	return path
}

var (
	sharedWasmOnce sync.Once
	sharedWasm     *mlswasi.Runtime
	sharedWasmErr  error
)

// sharedRuntime is one wasm runtime for the whole package. Compiling the OpenMLS module is the most
// expensive thing New does, and every server in this file would otherwise pay it; a runtime passed
// in through Options.Wasm is not closed by Shutdown, so one outlives every server that borrows it.
// The DS's state cache returns every instance it held when its server shuts down.
func sharedRuntime(t *testing.T) *mlswasi.Runtime {
	t.Helper()
	sharedWasmOnce.Do(func() {
		raw, err := os.ReadFile(testCorePath(t))
		if err != nil {
			sharedWasmErr = err
			return
		}
		sharedWasm, sharedWasmErr = mlswasi.New(context.Background(), raw, mlswasi.Options{PoolSize: 4})
	})
	if sharedWasmErr != nil {
		t.Fatalf("build the shared wasm runtime: %v", sharedWasmErr)
	}
	return sharedWasm
}

func newServer(t *testing.T) (*dillad.Server, *httptest.Server) {
	t.Helper()
	cfg := testConfig(t)
	cfg.Log.Level = "warn"
	s, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg,
		Clock:  clock.NewFake(time.Unix(1_700_000_000, 0)),
		Wasm:   sharedRuntime(t),
	})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

// Every delivery-service route of §5.1 is MOUNTED. An unauthenticated request must be answered
// 401, never 404: a 404 means the route does not exist, which is the failure this test exists for.
func TestEveryDeliveryServiceRouteIsMounted(t *testing.T) {
	_, ts := newServer(t)
	const gid = "0102030405060708090a0b0c0d0e0f10"
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/v1/groups"},
		{http.MethodGet, "/v1/groups/" + gid + "/info"},
		{http.MethodGet, "/v1/groups/" + gid + "/tree"},
		{http.MethodGet, "/v1/groups/" + gid + "/handshakes"},
		{http.MethodPost, "/v1/groups/" + gid + "/commit"},
		{http.MethodPost, "/v1/groups/" + gid + "/proposal"},
		{http.MethodGet, "/v1/groups/" + gid + "/proposals"},
		{http.MethodPost, "/v1/groups/" + gid + "/message"},
		{http.MethodGet, "/v1/groups/" + gid + "/messages"},
		{http.MethodDelete, "/v1/groups/" + gid + "/messages/1"},
		{http.MethodPost, "/v1/groups/" + gid + "/cursor"},
		{http.MethodPost, "/v1/groups/" + gid + "/resync"},
		{http.MethodPost, "/v1/groups/" + gid + "/fork-report"},
		{http.MethodGet, "/v1/groups/" + gid + "/heal"},
		{http.MethodPost, "/v1/groups/" + gid + "/heal"},
		{http.MethodPost, "/v1/keypackages"},
		{http.MethodGet, "/v1/devices/" + gid + "/keypackage"},
		{http.MethodGet, "/v1/welcomes"},
		{http.MethodDelete, "/v1/welcomes/1"},
	} {
		req, err := http.NewRequestWithContext(t.Context(), c.method, ts.URL+c.path, strings.NewReader(""))
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		res, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", c.method, c.path, err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusNotFound {
			t.Errorf("%s %s is not mounted", c.method, c.path)
		}
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s: status = %d, want 401 (mounted, unauthenticated)",
				c.method, c.path, res.StatusCode)
		}
	}
}

// The gateway upgrade is served, and a plain GET without the upgrade headers is a 400 from
// websocket.Accept rather than a 404.
func TestTheGatewayUpgradeIsMounted(t *testing.T) {
	_, ts := newServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/gateway", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("GET /gateway: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		t.Fatal("/gateway is not mounted")
	}
}

// POST /v1/gateway/ticket can only mint from a gateway.Tickets the composition root passed in.
func TestTheTicketRouteHasATicketStore(t *testing.T) {
	s, _ := newServer(t)
	if s.Gateway() == nil {
		t.Fatal("the server built no gateway, so nothing can mint an upgrade ticket")
	}
	if s.Gateway().Tickets() == nil {
		t.Fatal("the gateway has no ticket store")
	}
}

// The five accessors the test harness needs.
func TestTheServerExposesTheAccessorsTheHarnessNeeds(t *testing.T) {
	s, _ := newServer(t)
	if s.Repo() == nil {
		t.Error("Repo() is nil")
	}
	if s.DS() == nil {
		t.Error("DS() is nil")
	}
	if s.Gateway() == nil {
		t.Error("Gateway() is nil")
	}
	if s.CommitCount() != 0 {
		t.Errorf("CommitCount() = %d on a fresh instance, want 0", s.CommitCount())
	}
	if _, err := s.DebugState(context.Background()); err != nil {
		t.Errorf("DebugState: %v", err)
	}
}

// DS.Start's background goroutines stop with Shutdown, and Shutdown is idempotent.
func TestShutdownStopsTheWatchdogAndTheSweeperAndIsIdempotent(t *testing.T) {
	s, _ := newServer(t)
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("a second Shutdown must be a no-op: %v", err)
	}
}

// ---------------------------------------------------------------- beyond the brief's five

// Now() is the server's own clock and DebugState reports the instance as it stands: a fresh
// instance holds no group, has accepted no commit and runs no election.
func TestNowAndDebugStateReadTheInstance(t *testing.T) {
	s, _ := newServer(t)
	if got := s.Now().Unix(); got != 1_700_000_000 {
		t.Errorf("Now() = %d, want the fake clock's 1700000000", got)
	}
	state, err := s.DebugState(context.Background())
	if err != nil {
		t.Fatalf("DebugState: %v", err)
	}
	if state.Generation != 1 || state.Groups != 0 || state.Commits != 0 ||
		state.OpenElections != 0 || state.FrozenGroups != 0 || state.NowUnix != 1_700_000_000 {
		t.Errorf("DebugState = %+v, want generation 1, nothing else, now 1700000000", state)
	}
}

// With no runtime passed in, New builds one from the core it is pointed at, and a core that is
// not there is a start-up error that names the path — never a server whose every DS route fails.
func TestNewBuildsTheWasmRuntimeFromTheCorePath(t *testing.T) {
	cfg := testConfig(t)
	s, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clock.System(), CorePath: testCorePath(t),
	})
	if err != nil {
		t.Fatalf("New with a CorePath: %v", err)
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	missing := filepath.Join(t.TempDir(), "no-such-core.wasm")
	_, err = dillad.New(context.Background(), dillad.Options{
		Config: testConfig(t), Clock: clock.System(), CorePath: missing,
	})
	if err == nil || !strings.Contains(err.Error(), missing) {
		t.Fatalf("New with a missing core gave %v, want an error naming %s", err, missing)
	}
}

// accountToken redeems the bootstrap invite and returns the account's first device session.
func accountToken(t *testing.T, h http.Handler, code string) string {
	t.Helper()
	dev := newTestDevice(t)
	body, err := cborx.Marshal(newAccountRequest(code, "jonas", dev))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res := post(t, h, "/v1/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("POST /v1/accounts = %d: %s", res.Code, res.Body.String())
	}
	var account []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &account); err != nil {
		t.Fatalf("decode: %v", err)
	}
	token, ok := account[2].(string)
	if !ok || token == "" {
		t.Fatalf("no session token in the account response: %#v", account)
	}
	return token
}

// newGreetedServer is a served instance plus one enrolled device's session token.
func newGreetedServer(t *testing.T) (*dillad.Server, *httptest.Server, string) {
	t.Helper()
	cfg, code := testConfigInvite(t)
	s, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clock.System(), Wasm: sharedRuntime(t),
	})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, accountToken(t, s.Handler(), code)
}

// readFrame reads one gateway frame and returns its opcode and payload.
func readFrame(t *testing.T, ctx context.Context, c *websocket.Conn) (uint64, []any) {
	t.Helper()
	typ, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("message type %v, want binary", typ)
	}
	var frame []any
	if err := cborx.Unmarshal(b, &frame); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	if len(frame) != 4 {
		t.Fatalf("frame has %d elements, want [op, n, group_id, payload]", len(frame))
	}
	op, ok := frame[0].(uint64)
	if !ok {
		t.Fatalf("op is %T", frame[0])
	}
	payload, _ := frame[3].([]any)
	return op, payload
}

// identify sends op 1 with the credential left to the upgrade, which is the path both the
// Authorization header and the ticket take.
func identify(t *testing.T, ctx context.Context, c *websocket.Conn) {
	t.Helper()
	b, err := cborx.Marshal([]any{uint64(1), uint64(1), nil,
		[]any{"", uint64(1), uint64(1), uint64(1), uint64(0)}})
	if err != nil {
		t.Fatalf("marshal identify: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatalf("write identify: %v", err)
	}
}

// The whole handshake through the composition root's handler chain: the upgrade has to reach
// http.Hijacker through RequestLog and Recover, hello has to carry this instance's id, and ready
// is only reached when the gateway resolves the session through the instance's own auth.Sessions
// and reads the device's groups through its own store.
func TestAnIdentifiedDeviceIsReadyAndOnlineThroughTheCompositionRoot(t *testing.T) {
	s, ts, token := newGreetedServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/gateway", //nolint:bodyclose // websocket.Dial documents that the handshake response body never needs closing
		&websocket.DialOptions{
			HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
			Subprotocols: []string{"dilla.v1"},
		})
	if err != nil {
		t.Fatalf("dial /gateway: %v", err)
	}
	defer c.CloseNow()

	op, hello := readFrame(t, ctx, c)
	if op != 0 {
		t.Fatalf("first frame op %d, want hello (0)", op)
	}
	instanceID := s.Sessions().InstanceID()
	if got, _ := hello[5].([]byte); string(got) != string(instanceID[:]) {
		t.Errorf("hello carries instance id %x, want this instance's %x", got, instanceID)
	}
	// Invariant 7's back-off window reaches hello from the delivery service's policy (deviation
	// B23): 300 ms + random(0..300 ms) on a default configuration.
	if len(hello) != 9 {
		t.Fatalf("hello has %d elements, want 9", len(hello))
	}
	if backoff, jitter := hello[7], hello[8]; backoff != uint64(300) || jitter != uint64(300) {
		t.Errorf("hello advertises backoff %v + jitter %v ms, want the policy's 300 + 300", backoff, jitter)
	}
	identify(t, ctx, c)
	if op, _ := readFrame(t, ctx, c); op != 3 {
		t.Fatalf("op %d after identify, want ready (3)", op)
	}
	sess, err := s.Sessions().Resolve(ctx, token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !s.Gateway().Online(sess.DeviceID) {
		t.Error("a device that reached ready through the composition root is not online")
	}
}

// POST /v1/gateway/ticket mints from the gateway's own store, so the ticket it answers is one the
// upgrade accepts: the browser path of gap-38, end to end.
func TestTheTicketRouteMintsATicketTheGatewayAccepts(t *testing.T) {
	_, ts, token := newGreetedServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, ts.URL+"/v1/gateway/ticket", strings.NewReader(""))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/cbor")
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /v1/gateway/ticket: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("POST /v1/gateway/ticket = %d, want 201", res.StatusCode)
	}
	var body []any
	raw := make([]byte, 512)
	n, _ := res.Body.Read(raw)
	if err := cborx.Unmarshal(raw[:n], &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	ticket, ok := body[0].(string)
	if !ok || ticket == "" {
		t.Fatalf("no ticket in %#v", body)
	}
	if expires, ok := body[1].(uint64); !ok || int64(expires) <= time.Now().Unix() {
		t.Fatalf("expires = %#v, want a unix time in the future", body[1])
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/gateway", //nolint:bodyclose // websocket.Dial documents that the handshake response body never needs closing
		&websocket.DialOptions{Subprotocols: []string{"dilla.v1", "dilla.ticket." + ticket}})
	if err != nil {
		t.Fatalf("dial /gateway with a ticket: %v", err)
	}
	defer c.CloseNow()
	if op, _ := readFrame(t, ctx, c); op != 0 {
		t.Fatalf("first frame op %d, want hello", op)
	}
	identify(t, ctx, c)
	if op, _ := readFrame(t, ctx, c); op != 3 {
		t.Fatalf("op %d after identify with a ticket, want ready (3)", op)
	}
}

// Revoking a device's sessions closes its sockets in the same breath (protocol/02, "Device
// sessions", rule 6): the composition root wires auth.Sessions.OnRevoke to Gateway.CloseDevice.
func TestRevokingADeviceClosesItsGatewayConnection(t *testing.T) {
	s, ts, token := newGreetedServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/gateway", //nolint:bodyclose // websocket.Dial documents that the handshake response body never needs closing
		&websocket.DialOptions{
			HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
			Subprotocols: []string{"dilla.v1"},
		})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	readFrame(t, ctx, c)
	identify(t, ctx, c)
	if op, _ := readFrame(t, ctx, c); op != 3 {
		t.Fatalf("op %d, want ready", op)
	}
	sess, err := s.Sessions().Resolve(ctx, token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	// The client keeps reading, as a live client does, so it answers the close handshake the
	// gateway starts; a peer that never reads holds the revoking caller for the websocket
	// library's close timeout instead.
	ended := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				ended <- err
				return
			}
		}
	}()
	if err := s.Sessions().RevokeDevice(ctx, sess.DeviceID); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	err = <-ended
	if got := websocket.CloseStatus(err); got != 4004 {
		t.Fatalf("the socket ended with %v (status %d), want close 4004 session revoked", err, got)
	}
}

// The delivery-service routes are metered through the composition root: the instance's own
// limiter, keyed by the device session, refuses the request past [limits.rate]'s read burst with
// 429 E_RATE_LIMITED — whatever the route would have answered.
func TestTheDeliveryServiceRoutesAreMeteredPerDevice(t *testing.T) {
	_, ts, token := newGreetedServer(t)
	burst := testConfig(t).Limits.Rate.ReadBurst
	get := func() int {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet,
			ts.URL+"/v1/groups/0102030405060708090a0b0c0d0e0f10/info", nil)
		if err != nil {
			t.Fatalf("request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("GET info: %v", err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	// The clock is the wall clock, so the bucket refills a little while the loop runs: the first
	// refusal comes at the burst or a few requests after it, never before, and always comes.
	for i := range 2 * burst {
		if get() == http.StatusTooManyRequests {
			if i < burst {
				t.Fatalf("request %d of a read burst of %d was refused", i+1, burst)
			}
			return
		}
	}
	t.Fatalf("%d reads in a row were never refused; the read burst is %d", 2*burst, burst)
}

// The listener bounds how long a request header may take, from server.read_header_timeout and
// never zero — net/http reads zero as "no limit".
func TestTheListenerBoundsHowLongAHeaderMayTake(t *testing.T) {
	s, _ := newServer(t)
	if got := s.ReadHeaderTimeout(); got != 10*time.Second {
		t.Errorf("ReadHeaderTimeout = %v, want the configured 10s", got)
	}
	cfg := testConfig(t)
	cfg.Server.ReadHeaderTimeout = "0s"
	zero, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clock.NewFake(time.Unix(1_700_000_000, 0)), Wasm: sharedRuntime(t),
	})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	t.Cleanup(func() { _ = zero.Shutdown(context.Background()) })
	if got := zero.ReadHeaderTimeout(); got <= 0 {
		t.Errorf("a zero read_header_timeout left the listener unbounded (%v)", got)
	}
}

// newGreetedServerAt is newGreetedServer on a fake clock the test moves, so the maintenance loop
// the composition root starts can be driven past a deadline without waiting for it.
func newGreetedServerAt(t *testing.T) (*dillad.Server, *httptest.Server, string, *clock.Fake) {
	t.Helper()
	cfg, code := testConfigInvite(t)
	cfg.Log.Level = "warn"
	clk := clock.NewFake(time.Now().Truncate(time.Second))
	s, err := dillad.New(context.Background(), dillad.Options{
		Config: cfg, Clock: clk, Wasm: sharedRuntime(t),
	})
	if err != nil {
		t.Fatalf("dillad.New: %v", err)
	}
	t.Cleanup(func() { _ = s.Shutdown(context.Background()) })
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts, accountToken(t, s.Handler(), code), clk
}

// dialReady opens a gateway connection and takes it through hello, identify and ready.
func dialReady(t *testing.T, ctx context.Context, ts *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/gateway", //nolint:bodyclose // websocket.Dial documents that the handshake response body never needs closing
		&websocket.DialOptions{
			HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
			Subprotocols: []string{"dilla.v1"},
		})
	if err != nil {
		t.Fatalf("dial /gateway: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	if op, _ := readFrame(t, ctx, c); op != 0 {
		t.Fatalf("first frame op %d, want hello", op)
	}
	identify(t, ctx, c)
	if op, _ := readFrame(t, ctx, c); op != 3 {
		t.Fatalf("op %d after identify, want ready", op)
	}
	return c
}

// advanceUntil moves the fake clock one step at a time, giving the maintenance goroutine a moment
// after each step, until done reports true or ten seconds of wall time pass.
func advanceUntil(t *testing.T, clk *clock.Fake, step time.Duration, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatal("the condition never held while the clock advanced")
		}
		clk.Advance(step)
		time.Sleep(20 * time.Millisecond)
	}
}

// The gateway's liveness sweep runs in production, not only when a test calls it: an identified
// connection that stops heartbeating is closed 4009 once the clock passes interval*2 + 5 s.
func TestTheCompositionRootClosesAConnectionThatStopsHeartbeating(t *testing.T) {
	s, ts, token, clk := newGreetedServerAt(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := dialReady(t, ctx, ts, token)
	sess, err := s.Sessions().Resolve(ctx, token)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	ended := make(chan error, 1)
	go func() {
		for {
			if _, _, err := c.Read(ctx); err != nil {
				ended <- err
				return
			}
		}
	}()
	var closed error
	advanceUntil(t, clk, 30*time.Second, func() bool {
		select {
		case closed = <-ended:
			return true
		default:
			return false
		}
	})
	if got := websocket.CloseStatus(closed); got != 4009 {
		t.Fatalf("the silent connection ended with %v (status %d), want close 4009 session_timeout", closed, got)
	}
	if s.Gateway().Online(sess.DeviceID) {
		t.Error("a device whose only connection timed out is still online")
	}
}

// A connection the client dropped waits in the resume window with its ring, and the maintenance
// loop drops it once the window has passed.
func TestTheCompositionRootDropsASuspendedSessionPastTheResumeWindow(t *testing.T) {
	s, ts, token, clk := newGreetedServerAt(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := dialReady(t, ctx, ts, token)
	_ = c.Close(websocket.StatusNormalClosure, "bye")
	deadline := time.Now().Add(5 * time.Second)
	for s.Gateway().Suspended() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("suspended = %d after the client left, want 1", s.Gateway().Suspended())
		}
		time.Sleep(10 * time.Millisecond)
	}
	advanceUntil(t, clk, 30*time.Second, func() bool { return s.Gateway().Suspended() == 0 })
}

// The login throttle's ledger is swept on the same tick: failures older than the observation
// window, and the buckets they filled, are gone without anyone logging in again.
func TestTheCompositionRootSweepsTheLoginThrottle(t *testing.T) {
	s, _, _, clk := newGreetedServerAt(t)
	s.Throttle().RecordFailure(id.New(), netip.MustParseAddr("198.51.100.9"))
	if s.Throttle().Tracked() == 0 {
		t.Fatal("a recorded failure left nothing in the throttle")
	}
	advanceUntil(t, clk, 5*time.Minute, func() bool { return s.Throttle().Tracked() == 0 })
}
