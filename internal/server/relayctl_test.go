package server_test

// UP8 of the plan "calls survive an upgrade" (R-UP11): TURN runs in `dillad media`, the call routes
// in `dillad serve`, and the two meet on the control sockets media.sock and api.sock.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/stun/v3"
	"github.com/pion/turn/v5"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

const relaySecret = "0123456789abcdef0123456789abcdef"

// stateDir is a 0700 directory standing in for the state directory.
func stateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// logBuffer is a slog logger whose output a test can read.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func (l *logBuffer) logger() *slog.Logger { return slog.New(slog.NewTextHandler(l, nil)) }

// mediaRelay is `dillad media`'s relay: a TURN server with revocation state of its own, its barred
// lookup over api.sock, and media.sock serving its cut map.
type mediaRelay struct {
	addr     string
	rev      *server.RelayRevocations
	sock     string
	turn     *server.TURN
	log      *logBuffer
	stopSock func()
}

func startMediaRelay(t *testing.T, dir string, peers server.TURNPeers) *mediaRelay {
	t.Helper()
	m := &mediaRelay{log: &logBuffer{}, sock: server.ControlSocketPath(dir, server.MediaSocketName)}
	m.rev = server.NewRelayRevocations(2*time.Hour, clock.System()).
		WithBarred(server.RemoteBarred{Client: server.ControlClient(server.ControlSocketPath(dir, server.APISocketName))}, m.log.logger())
	started := time.Now()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m.turn, err = server.StartTURN(config.TURN{
		Enabled: true, Realm: "chat.example.test", RelayIP: "127.0.0.1",
		SharedSecretFile: writeFile(t, "turn.secret", relaySecret), CredentialTTL: "1h", AllocationsPerDevice: 4,
	}, ln, netip.MustParseAddr("127.0.0.1"), peers, nil, m.rev, clock.System(), m.log.logger())
	if err != nil {
		t.Fatalf("StartTURN: %v", err)
	}
	t.Cleanup(func() { _ = m.turn.Close() })
	m.addr = ln.Addr().String()
	cl, err := server.ListenControl(t.Context(), m.sock, m.log.logger())
	if err != nil {
		t.Fatalf("ListenControl media.sock: %v", err)
	}
	m.stopSock = server.ServeControl(cl, server.NewRelayControl(m.rev, func() server.RelayState {
		st := m.rev.State()
		return server.RelayState{Owner: "media", Serving: true, Listen: m.addr, Allocations: m.turn.AllocationCount(),
			Cuts: st.Cuts, Floor: st.Floor, Started: started.UnixMilli()}
	}), m.log.logger())
	t.Cleanup(m.stopSock)
	return m
}

// apiSide is `dillad serve`'s half: api.sock answering the barred lookup, and the relay revoker
// that forwards its cuts to media.sock. stop ends both, as an API restart does.
type apiSide struct {
	rev      *server.RelayRevoker
	local    *server.RelayRevocations
	lookups  *atomic.Int32
	stopSock func()
	cancel   context.CancelFunc
	done     chan struct{}
}

func startAPISide(t *testing.T, dir string, barred func(id.ID) (bool, error)) *apiSide {
	t.Helper()
	a := &apiSide{lookups: &atomic.Int32{}, done: make(chan struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /relay/barred/{device}", func(w http.ResponseWriter, r *http.Request) {
		a.lookups.Add(1)
		dev, err := id.Parse(r.PathValue("device"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		bar, err := barred(dev)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		server.WriteControlJSON(w, map[string]bool{"barred": bar})
	})
	ln, err := server.ListenControl(t.Context(), server.ControlSocketPath(dir, server.APISocketName), nil)
	if err != nil {
		t.Fatalf("ListenControl api.sock: %v", err)
	}
	a.stopSock = server.ServeControl(ln, mux, nil)
	a.local = server.NewRelayRevocations(2*time.Hour, clock.System()).WithCredentialTTL(time.Hour)
	a.rev = server.NewRelayRevoker(a.local, server.ControlClient(server.ControlSocketPath(dir, server.MediaSocketName)),
		2*time.Hour, clock.System(), nil)
	a.rev.SetPacingForTest(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	go func() {
		defer close(a.done)
		a.rev.Run(ctx)
	}()
	t.Cleanup(a.stop)
	return a
}

func (a *apiSide) stop() {
	a.cancel()
	<-a.done
	a.stopSock()
}

func notBarred(id.ID) (bool, error) { return false, nil }

// waitAcked waits until the media relay has acknowledged every cut of dev.
func waitAcked(t *testing.T, a *apiSide, dev id.ID) {
	t.Helper()
	waitFor(t, "the media relay's acknowledgement", func() bool { return !a.rev.Unacked(dev) })
}

// credentialAt mints dev's relay credential issued at at.
func credentialAt(dev id.ID, at time.Time) (string, string) {
	return server.TURNCredential(relaySecret, dev, time.Hour, at)
}

// sendsThrough reports whether a datagram written on relay to peer arrives there.
func sendsThrough(relay net.PacketConn, peer net.PacketConn, got func() []string, msg string) bool {
	if _, err := relay.WriteTo([]byte(msg), peer.LocalAddr()); err != nil {
		return false
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, g := range got() {
			if g == msg {
				return true
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// The merge is a union that keeps the later cut time per device and never removes an entry or
// lowers a time: an older set, an empty set and a set naming other devices leave every cut as it
// is. A time ahead of the clock is taken as now, an expired cut adds nothing, and a malformed cut
// refuses the whole merge.
func TestMergeCutsKeepsTheLaterTimeAndNeverDropsAnEntry(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	clk := clock.NewFake(now)
	rev := server.NewRelayRevocations(2*time.Hour, clk)
	a, b, c := id.New().String(), id.New().String(), id.New().String()
	t1 := now.Add(-time.Minute).UnixMilli()
	t2 := now.Add(-30 * time.Second).UnixMilli()
	merge := func(cuts ...server.RelayCut) {
		t.Helper()
		if err := rev.MergeCuts(cuts); err != nil {
			t.Fatalf("MergeCuts: %v", err)
		}
	}
	cutOf := func(dev string) int64 {
		at, ok := rev.CutOf(dev)
		if !ok {
			t.Fatalf("the cut of %s is gone", dev)
		}
		return at
	}
	merge(server.RelayCut{Device: a, At: t2}, server.RelayCut{Device: b, At: t1})
	merge(server.RelayCut{Device: a, At: t1})      // older
	merge()                                        // empty
	merge(server.RelayCut{Device: c, At: t1})      // another device
	merge(server.RelayCut{Device: b, At: t1 - 10}) // older again
	if cutOf(a) != t2 || cutOf(b) != t1 || cutOf(c) != t1 {
		t.Fatalf("cuts after merging older and empty sets: a=%d b=%d c=%d, want %d %d %d", cutOf(a), cutOf(b), cutOf(c), t2, t1, t1)
	}
	merge(server.RelayCut{Device: b, At: t2})
	if cutOf(b) != t2 {
		t.Fatalf("a later cut did not raise b's time: %d, want %d", cutOf(b), t2)
	}
	merge(server.RelayCut{Device: c, At: now.Add(time.Hour).UnixMilli()})
	if cutOf(c) != now.UnixMilli() {
		t.Fatalf("a cut ahead of the clock was kept at %d, want now %d", cutOf(c), now.UnixMilli())
	}
	d := id.New().String()
	merge(server.RelayCut{Device: d, At: now.Add(-3 * time.Hour).UnixMilli()})
	if _, ok := rev.CutOf(d); ok {
		t.Fatal("an expired cut was recorded")
	}
	e := id.New().String()
	for _, bad := range [][]server.RelayCut{
		{{Device: e, At: t2}, {Device: "not-a-device", At: t2}},
		{{Device: e, At: t2}, {Device: id.New().String(), At: 0}},
	} {
		if err := rev.MergeCuts(bad); err == nil {
			t.Fatalf("a merge with a malformed cut %v was accepted", bad)
		}
		if _, ok := rev.CutOf(e); ok {
			t.Fatal("a refused merge applied part of its set")
		}
	}
	if st := rev.State(); st.Cuts != 3 {
		t.Fatalf("the map holds %d cuts, want 3", st.Cuts)
	}
}

// The relay in `dillad media` verifies the API's credentials with the one shared secret: a
// credential the API mints (through its own revocation state's Mint) is accepted, and one issued
// before the media relay started is refused on every method — the process-start floor, so a cut
// set lost with a relay restart can never be bypassed.
func TestTheMediaRelayAcceptsTheAPIsCredentialsAndRefusesOlderThanItsStart(t *testing.T) {
	apiStart := time.Unix(1_790_000_000, 0)
	clk := clock.NewFake(apiStart)
	local := server.NewRelayRevocations(2*time.Hour, clk).WithCredentialTTL(time.Hour)
	dev := id.New()
	before, _ := server.TURNCredential(relaySecret, dev, time.Hour, clk.Now())
	clk.Advance(time.Minute)
	media := server.NewRelayRevocations(2*time.Hour, clk) // dilla-media (re)starts here
	auth := server.TURNAuthForTest(relaySecret, clk, 2*time.Hour, media)
	ok := func(user string, m stun.Method) bool {
		_, _, ok := auth(&turn.RequestAttributes{Username: user, Realm: "chat.example.test", Method: m})
		return ok
	}
	clk.Advance(time.Millisecond)
	issued, wait := local.Mint(dev, clk.Now())
	if wait > 0 {
		t.Fatalf("Mint refused: %v", wait)
	}
	fresh, _ := server.TURNCredential(relaySecret, dev, time.Hour, issued)
	for _, m := range []stun.Method{stun.MethodAllocate, stun.MethodRefresh, stun.MethodCreatePermission, stun.MethodChannelBind} {
		if !ok(fresh, m) {
			t.Errorf("%s with the API's credential was refused by the media relay", m)
		}
		if ok(before, m) {
			t.Errorf("%s with a credential issued before the media relay started was accepted", m)
		}
	}
}

// A cut through media.sock ends the device's relay allocations at once and refuses its credentials
// issued up to the cut; a credential issued after it allocates again.
func TestACutThroughMediaSockEndsTheDevicesAllocationsAndRefusesNewOnes(t *testing.T) {
	dir := stateDir(t)
	sfu, got := udpSink(t, "127.0.0.2:0")
	m := startMediaRelay(t, dir, sfuPeers(sfu))
	a := startAPISide(t, dir, notBarred)
	dev, other := id.New(), id.New()
	user, pass := credentialAt(dev, time.Now())
	relay, err := allocateAs(t, m.addr, user, pass)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	ouser, opass := credentialAt(other, time.Now())
	orelay, err := allocateAs(t, m.addr, ouser, opass)
	if err != nil {
		t.Fatalf("allocate the other device: %v", err)
	}
	if !sendsThrough(relay, sfu, got, "before") {
		t.Fatal("the relay carried nothing before the cut")
	}
	time.Sleep(2 * time.Millisecond)
	a.rev.Revoke(dev, time.Now())
	if !a.rev.Unacked(dev) {
		t.Fatal("a cut not yet forwarded is not pending")
	}
	waitAcked(t, a, dev)
	if _, ok := m.rev.CutOf(dev.String()); !ok {
		t.Fatal("the acknowledged cut is not in the media relay's map")
	}
	waitFor(t, "the cut device's allocation to end", func() bool { return m.turn.AllocationCount() == 1 })
	if sendsThrough(relay, sfu, got, "after") {
		t.Fatal("the cut device's relay still carried media")
	}
	if !sendsThrough(orelay, sfu, got, "other") {
		t.Fatal("the cut ended another device's relay")
	}
	if _, err := allocateAs(t, m.addr, user, pass); err == nil {
		t.Fatal("the cut device allocated again with its old credential")
	}
	time.Sleep(2 * time.Millisecond)
	nuser, npass := credentialAt(dev, time.Now())
	nrelay, err := allocateAs(t, m.addr, nuser, npass)
	if err != nil {
		t.Fatalf("a credential issued after the cut was refused: %v", err)
	}
	// A merged cut that is later than the old one but older than the new credential (a replay)
	// leaves the rejoined device's relay alone.
	cutAt, _ := m.rev.CutOf(dev.String())
	if err := m.rev.MergeCuts([]server.RelayCut{{Device: dev.String(), At: cutAt + 1}}); err != nil {
		t.Fatal(err)
	}
	if !sendsThrough(nrelay, sfu, got, "rejoined") {
		t.Fatal("replaying an old cut ended the relay of a credential issued after it")
	}
}

// A cut holds across an API restart and a replay: the restarted API's revocation state is empty,
// and what it replays (nothing, then an older cut of the same device) never lowers or removes the
// media relay's cut. The credential issued before the cut is still refused.
func TestACutHoldsAcrossAnAPIRestartAndAReplay(t *testing.T) {
	dir := stateDir(t)
	sfu, _ := udpSink(t, "127.0.0.2:0")
	m := startMediaRelay(t, dir, sfuPeers(sfu))
	first := startAPISide(t, dir, notBarred)
	dev := id.New()
	user, pass := credentialAt(dev, time.Now())
	if _, err := allocateAs(t, m.addr, user, pass); err != nil {
		t.Fatalf("allocate: %v", err)
	}
	time.Sleep(2 * time.Millisecond)
	first.rev.Revoke(dev, time.Now())
	waitAcked(t, first, dev)
	cutAt, ok := m.rev.CutOf(dev.String())
	if !ok {
		t.Fatal("no cut in the media relay")
	}
	first.stop() // the API restarts: its memory is gone

	second := startAPISide(t, dir, notBarred)
	probe := id.New()
	second.rev.Revoke(probe, time.Now()) // proves the second API has connected and replayed
	waitAcked(t, second, probe)
	second.rev.Revoke(dev, time.UnixMilli(cutAt-60_000)) // an older cut of the same device
	waitAcked(t, second, dev)
	if at, ok := m.rev.CutOf(dev.String()); !ok || at != cutAt {
		t.Fatalf("after the restart and replay the cut is %d (%v), want %d unchanged", at, ok, cutAt)
	}
	if _, err := allocateAs(t, m.addr, user, pass); err == nil {
		t.Fatal("the credential issued before the cut allocated after the API restarted")
	}
}

// A cut the media relay has not acknowledged keeps the device pending — the call routes answer it
// 503 — and is resent once media.sock answers again; the replay on that reconnect carries it too.
func TestAnUnacknowledgedCutKeepsTheDevicePendingAndIsResent(t *testing.T) {
	dir := stateDir(t)
	a := startAPISide(t, dir, notBarred) // media.sock is not there yet
	dev := id.New()
	a.rev.Revoke(dev, time.Now())
	time.Sleep(200 * time.Millisecond) // ten retry rounds
	if !a.rev.Unacked(dev) {
		t.Fatal("a cut nobody acknowledged is not pending")
	}
	sfu, _ := udpSink(t, "127.0.0.2:0")
	m := startMediaRelay(t, dir, sfuPeers(sfu))
	waitAcked(t, a, dev)
	if _, ok := m.rev.CutOf(dev.String()); !ok {
		t.Fatal("the resent cut is not in the media relay's map")
	}
	// The relay goes away again: a new cut stays pending, the acknowledged one does not come back.
	m.stopSock()
	other := id.New()
	a.rev.Revoke(other, time.Now())
	time.Sleep(100 * time.Millisecond)
	if !a.rev.Unacked(other) || a.rev.Unacked(dev) {
		t.Fatalf("with media.sock gone: other pending %v (want true), dev pending %v (want false)",
			a.rev.Unacked(other), a.rev.Unacked(dev))
	}
}

// Mint stays ordered against cuts under the API's one local lock when the revoker forwards them
// (today's mint race, through the wrapper): with a cut and a mint racing, either the cut came first
// and the mint refuses (the cut was made since the request began), or the mint came first and the
// cut covers its credential. No credential outlives a cut made while its request was served,
// whatever the socket does.
func TestMintStaysOrderedAgainstAConcurrentRevokeThroughTheWrapper(t *testing.T) {
	dir := stateDir(t)
	// No media relay and no forwarding loop: ordering must not depend on the socket. The local
	// state records every cut (no mint gate), so the race alone decides.
	local := server.NewRelayRevocations(2*time.Hour, clock.System())
	a := struct {
		rev   *server.RelayRevoker
		local *server.RelayRevocations
	}{server.NewRelayRevoker(local, server.ControlClient(server.ControlSocketPath(dir, server.MediaSocketName)),
		2*time.Hour, clock.System(), nil), local}
	refused, minted := 0, 0
	for range 500 {
		dev := id.New()
		begun := time.Now()
		var wg sync.WaitGroup
		var issued time.Time
		var wait time.Duration
		wg.Add(2)
		go func() {
			defer wg.Done()
			// A cut "as of now": the revocation state takes the clock's time under its lock.
			a.rev.Revoke(dev, time.Now().Add(time.Hour))
		}()
		go func() {
			defer wg.Done()
			issued, wait = a.rev.Mint(dev, begun)
		}()
		wg.Wait()
		if wait > 0 {
			refused++
			continue
		}
		minted++
		at, ok := a.local.CutOf(dev.String())
		if !ok || issued.UnixMilli() > at {
			t.Fatalf("a credential issued at %d outlived a cut at %d (%v) made while its request was served", issued.UnixMilli(), at, ok)
		}
		if !a.rev.Unacked(dev) {
			t.Fatal("a cut with no media relay to take it is not pending")
		}
	}
	t.Logf("refused %d, minted then covered %d", refused, minted)
}

// The media relay's barred lookup over api.sock: a device the API says is barred is cut; a lookup
// that fails — the API down, or answering an error — caches nothing and is logged at WARN, and is
// asked again on the device's next authenticated request; the cut map still refuses a cut device
// whatever the lookup says.
func TestAFailedBarredLookupOverAPISockCachesNothing(t *testing.T) {
	dir := stateDir(t)
	sfu, _ := udpSink(t, "127.0.0.2:0")
	m := startMediaRelay(t, dir, sfuPeers(sfu))
	var barred sync.Map
	var failing atomic.Bool
	a := startAPISide(t, dir, func(dev id.ID) (bool, error) {
		if failing.Load() {
			return false, errors.New("store unavailable")
		}
		_, bar := barred.Load(dev)
		return bar, nil
	})
	cut := id.New()
	cuser, cpass := credentialAt(cut, time.Now())
	time.Sleep(2 * time.Millisecond)
	a.rev.Revoke(cut, time.Now())
	waitAcked(t, a, cut)

	failing.Store(true)
	dev := id.New()
	user, pass := credentialAt(dev, time.Now())
	if _, err := allocateAs(t, m.addr, user, pass); err != nil {
		t.Fatalf("an allocation while the lookup fails was refused: %v", err)
	}
	if !strings.Contains(m.log.String(), "barred lookup failed") {
		t.Fatalf("the failed lookup was not logged at WARN:\n%s", m.log.String())
	}
	if n := m.rev.BarredCacheLenForTest(); n != 0 {
		t.Fatalf("a failed lookup cached %d entries", n)
	}
	if _, err := allocateAs(t, m.addr, cuser, cpass); err == nil {
		t.Fatal("a cut device allocated while the lookup failed")
	}
	// The API answers again and says dev is barred: its next request is looked up and cut.
	failing.Store(false)
	barred.Store(dev, true)
	before := a.lookups.Load()
	if _, err := allocateAs(t, m.addr, user, pass); err == nil {
		t.Fatal("a barred device allocated")
	}
	if a.lookups.Load() == before {
		t.Fatal("the failed lookup was cached: the device was not asked about again")
	}
	if _, ok := m.rev.CutOf(dev.String()); !ok {
		t.Fatal("the barred device was not cut")
	}
	// With api.sock gone entirely, the lookup fails the same way.
	a.stop()
	lone := id.New()
	luser, lpass := credentialAt(lone, time.Now())
	if _, err := allocateAs(t, m.addr, luser, lpass); err != nil {
		t.Fatalf("an allocation with api.sock gone was refused: %v", err)
	}
}

// A relayed client survives an API-only restart: its allocation through the media relay keeps
// carrying data to and from the SFU while the API is down and after it is back; during the outage a
// valid credential still allocates (the barred lookup fails open, as the plan's ruling keeps it),
// while a device cut before the outage is still refused by the cut map.
func TestARelayedClientSurvivesAnAPIOnlyRestart(t *testing.T) {
	dir := stateDir(t)
	sfu, got := udpSink(t, "127.0.0.2:0")
	m := startMediaRelay(t, dir, sfuPeers(sfu))
	a := startAPISide(t, dir, notBarred)
	dev, cutDev := id.New(), id.New()
	user, pass := credentialAt(dev, time.Now())
	relay, err := allocateAs(t, m.addr, user, pass)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	cuser, cpass := credentialAt(cutDev, time.Now())
	time.Sleep(2 * time.Millisecond)
	a.rev.Revoke(cutDev, time.Now())
	waitAcked(t, a, cutDev)
	if !sendsThrough(relay, sfu, got, "before the restart") {
		t.Fatal("the relay carried nothing before the restart")
	}

	a.stop() // the API process is gone
	for i := range 5 {
		if !sendsThrough(relay, sfu, got, fmt.Sprintf("during the restart %d", i)) {
			t.Fatalf("relayed media stopped while the API was down (datagram %d)", i)
		}
	}
	// The SFU answers through the relay as well.
	if _, err := sfu.WriteTo([]byte("from the sfu"), relay.LocalAddr()); err != nil {
		t.Fatalf("the SFU's reply: %v", err)
	}
	if msg, none := readsNothing(t, relay, 2*time.Second); none || msg != "from the sfu" {
		t.Fatalf("the client read %q (nothing: %v) from the SFU while the API was down", msg, none)
	}
	if _, err := allocateAs(t, m.addr, cuser, cpass); err == nil {
		t.Fatal("a device cut before the outage allocated while the API was down")
	}
	nuser, npass := credentialAt(id.New(), time.Now())
	if _, err := allocateAs(t, m.addr, nuser, npass); err != nil {
		t.Fatalf("an ICE restart's allocation was refused while the API was down: %v", err)
	}

	b := startAPISide(t, dir, notBarred) // the new API: empty memory, replays nothing
	probe := id.New()
	b.rev.Revoke(probe, time.Now())
	waitAcked(t, b, probe)
	if !sendsThrough(relay, sfu, got, "after the restart") {
		t.Fatal("relayed media stopped after the API came back")
	}
	if _, err := allocateAs(t, m.addr, cuser, cpass); err == nil {
		t.Fatal("the cut device allocated after the API came back")
	}
}

// The control sockets fail closed: mode 0600, bound only in a directory of this user closed to
// group and world, serving only connections whose SO_PEERCRED uid is this process's, and bounding
// a request's body.
func TestTheControlSocketsFailClosed(t *testing.T) {
	t.Run("mode 0600, and a real peer of this uid is served", func(t *testing.T) {
		dir := stateDir(t)
		path := server.ControlSocketPath(dir, server.MediaSocketName)
		ln, err := server.ListenControl(t.Context(), path, nil)
		if err != nil {
			t.Fatal(err)
		}
		stop := server.ServeControl(ln, okHandler(), nil)
		defer stop()
		fi, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
			t.Fatalf("socket mode %v, want a 0600 socket", fi.Mode())
		}
		if _, err := server.FetchRelayState(t.Context(), server.ControlClient(path)); err != nil {
			t.Fatalf("a peer of this uid was refused: %v", err)
		}
	})
	t.Run("another uid, or a peer that cannot be identified, is refused unserved", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			peer func(net.Conn) (uint32, error)
			log  string
		}{
			{"another uid", func(net.Conn) (uint32, error) { return uint32(os.Getuid()) + 1, nil }, "not dillad's uid"},
			{"no credentials", func(net.Conn) (uint32, error) { return 0, errors.New("no credentials") }, "could not be identified"},
		} {
			dir := stateDir(t)
			path := server.ControlSocketPath(dir, server.APISocketName)
			logs := &logBuffer{}
			restore := server.SetPeerUIDForTest(tc.peer)
			ln, err := server.ListenControl(t.Context(), path, logs.logger())
			restore()
			if err != nil {
				t.Fatal(err)
			}
			served := atomic.Bool{}
			stop := server.ServeControl(ln, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { served.Store(true) }), nil)
			if _, err := server.FetchRelayState(t.Context(), server.ControlClient(path)); err == nil {
				t.Fatalf("%s: the connection was answered", tc.name)
			}
			stop()
			if served.Load() {
				t.Fatalf("%s: a request reached the handler", tc.name)
			}
			if !strings.Contains(logs.String(), tc.log) {
				t.Fatalf("%s: the refusal was not logged:\n%s", tc.name, logs.String())
			}
		}
	})
	t.Run("a directory others can enter, or another file at the path, binds nothing", func(t *testing.T) {
		open := t.TempDir()
		if err := os.Chmod(open, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := server.ListenControl(t.Context(), filepath.Join(open, server.APISocketName), nil); err == nil {
			t.Fatal("a control socket was bound in a 0755 directory")
		}
		dir := stateDir(t)
		path := filepath.Join(dir, server.APISocketName)
		if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := server.ListenControl(t.Context(), path, nil); err == nil {
			t.Fatal("a control socket replaced a regular file")
		}
	})
	t.Run("a stale socket is replaced, and a successor's socket survives the predecessor's close", func(t *testing.T) {
		dir := stateDir(t)
		path := server.ControlSocketPath(dir, server.MediaSocketName)
		first, err := server.ListenControl(t.Context(), path, nil)
		if err != nil {
			t.Fatal(err)
		}
		second, err := server.ListenControl(t.Context(), path, nil)
		if err != nil {
			t.Fatalf("a stale socket was not replaced: %v", err)
		}
		_ = first.Close()
		stop := server.ServeControl(second, okHandler(), nil)
		defer stop()
		if _, err := server.FetchRelayState(t.Context(), server.ControlClient(path)); err != nil {
			t.Fatalf("the predecessor's close removed its successor's socket: %v", err)
		}
	})
	t.Run("a body past the bound is refused", func(t *testing.T) {
		dir := stateDir(t)
		path := server.ControlSocketPath(dir, server.MediaSocketName)
		rev := server.NewRelayRevocations(2*time.Hour, clock.System())
		ln, err := server.ListenControl(t.Context(), path, nil)
		if err != nil {
			t.Fatal(err)
		}
		stop := server.ServeControl(ln, server.NewRelayControl(rev, func() server.RelayState { return server.RelayState{} }), nil)
		defer stop()
		cuts := make([]server.RelayCut, 0, server.MaxControlBodyForTest/40)
		for len(cuts) < cap(cuts) {
			cuts = append(cuts, server.RelayCut{Device: id.New().String(), At: time.Now().UnixMilli()})
		}
		raw, _ := json.Marshal(cuts)
		req, _ := http.NewRequestWithContext(t.Context(), http.MethodPut, "http://dillad/relay/cuts", bytes.NewReader(raw))
		resp, err := server.ControlClient(path).Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 400 {
				t.Fatalf("a %d-byte body was accepted: %s", len(raw), resp.Status)
			}
		}
		if rev.State().Cuts != 0 {
			t.Fatal("part of an oversized replay was applied")
		}
	})
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		server.WriteControlJSON(w, server.RelayState{Owner: "test"})
	})
}
