package server

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
)

// The control sockets of R-UP11. TURN runs in `dillad media` while the call routes run in `dillad
// serve`, so the two talk over two local unix sockets in the state directory:
//
//   - media.sock, served by every web3.12+ `dillad media`: GET /media/self says what the running
//     media process is (its version, media level, capabilities and pid, as media.json does), and
//     only while it serves TURN, POST /relay/cut and PUT /relay/cuts feed the media relay's cut map
//     (MergeCuts) and GET /relay/state reports it.
//   - api.sock, served by `dillad serve` in sidecar mode: GET /relay/barred/{device} is the media
//     relay's barred lookup (RemoteBarred), GET /media/recent-mints is what `dillad media --idle`
//     asks, and GET /relay/state says whether the API serves a relay itself.
//
// Both are mode 0600 in the 0700 state directory, whose path derives from instance.data_dir; a
// connection is served only when SO_PEERCRED names this process's own uid (dillad), and every
// request is bounded in size and time. Nothing on them is reachable from the network.
const (
	MediaSocketName = "media.sock"
	APISocketName   = "api.sock"

	// maxControlBody bounds one control request's body: a replay is sent in batches of
	// replayBatch cuts, each well under it.
	maxControlBody = 1 << 20
	replayBatch    = 4096
	// controlTimeout bounds one control request, end to end.
	controlTimeout = 3 * time.Second
	// controlBase is the URL prefix of every control request; the host is never resolved.
	controlBase = "http://dillad"
)

// ControlSocketPath is the control socket name in the state directory dataDir.
func ControlSocketPath(dataDir, name string) string { return filepath.Join(dataDir, name) }

// peerUIDOf reads a connection's peer uid; a variable so a test can stand in another uid.
var peerUIDOf = peerUID

// ListenControl binds the control socket at path. Its directory must be this process's own and
// closed to group and world (StateDirectoryMode=0700), or nothing is bound: a socket in a directory
// another user can write could be swapped under a client. A stale socket left by a crash is
// replaced; any other file at path is refused. The socket is mode 0600, and the listener accepts
// only connections whose SO_PEERCRED uid is this process's: the others are closed unserved and
// logged at WARN.
func ListenControl(ctx context.Context, path string, log *slog.Logger) (net.Listener, error) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	dir := filepath.Dir(path)
	fi, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("control socket %s: %w", path, err)
	}
	uid := os.Getuid()
	if st, ok := fi.Sys().(*syscall.Stat_t); !fi.IsDir() || (ok && int(st.Uid) != uid) || fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("control socket %s: %s must be a directory of this user with mode 0700 (it is %04o)",
			path, dir, fi.Mode().Perm())
	}
	if li, err := os.Lstat(path); err == nil {
		if li.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("control socket %s: a file that is not a socket is in the way", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("control socket %s: remove the stale socket: %w", path, err)
		}
	}
	ln, err := (&net.ListenConfig{}).Listen(ctx, "unix", path)
	if err != nil {
		return nil, fmt.Errorf("control socket %s: %w", path, err)
	}
	ul, _ := ln.(*net.UnixListener)
	if ul != nil {
		// Closing must not unlink a socket a successor has bound at the same path; close removes
		// the path only while it is still this listener's (controlListener.Close).
		ul.SetUnlinkOnClose(false)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("control socket %s: %w", path, err)
	}
	mine, err := os.Lstat(path)
	if err != nil {
		_ = ln.Close()
		return nil, fmt.Errorf("control socket %s: %w", path, err)
	}
	return &controlListener{Listener: ln, uid: uint32(uid), peer: peerUIDOf, path: path, mine: mine, log: log}, nil //nolint:gosec // a uid fits in uint32
}

// controlListener serves only the connections of its own uid.
type controlListener struct {
	net.Listener
	uid       uint32
	peer      func(net.Conn) (uint32, error)
	path      string
	mine      os.FileInfo
	log       *slog.Logger
	closeOnce sync.Once
}

func (l *controlListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		uid, err := l.peer(c)
		if err == nil && uid == l.uid {
			return c, nil
		}
		_ = c.Close()
		if err != nil {
			l.log.Warn("a control socket connection was refused: its peer could not be identified", "socket", l.path, "err", err)
		} else {
			l.log.Warn("a control socket connection was refused: its peer is not dillad's uid", "socket", l.path, "uid", uid)
		}
	}
}

// Close stops the listener and removes the socket while it is still the one this listener bound.
func (l *controlListener) Close() error {
	err := l.Listener.Close()
	l.closeOnce.Do(func() {
		if cur, serr := os.Lstat(l.path); serr == nil && os.SameFile(cur, l.mine) {
			_ = os.Remove(l.path)
		}
	})
	return err
}

// ServeControl serves h on a control listener until the returned stop, which shuts it down and
// waits for it. Requests are bounded: maxControlBody of body, a few seconds to read and to write.
func ServeControl(ln net.Listener, h http.Handler, log *slog.Logger) (stop func()) {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	srv := &http.Server{
		Handler:           http.MaxBytesHandler(h, maxControlBody),
		ReadHeaderTimeout: 2 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("a control socket stopped serving", "addr", ln.Addr().String(), "err", err)
		}
	}()
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			_ = srv.Close()
		}
		<-done
	}
}

// ControlClient is an HTTP client of the control socket at path, every request bounded by
// controlTimeout.
func ControlClient(path string) *http.Client {
	return &http.Client{
		Timeout: controlTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", path)
			},
			MaxIdleConns:       2,
			IdleConnTimeout:    30 * time.Second,
			DisableCompression: true,
		},
	}
}

// controlDo sends one control request and decodes a 200's JSON answer into out (nil: none
// expected); any other status is an error.
func controlDo(ctx context.Context, c *http.Client, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, controlBase+path, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusNoContent && out == nil:
		return nil
	case resp.StatusCode != http.StatusOK:
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s %s: %s: %s", method, path, resp.Status, bytes.TrimSpace(msg))
	case out == nil:
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, maxControlBody)).Decode(out)
}

// decodeStrict reads exactly one JSON value of r's body into v, refusing unknown fields.
func decodeStrict(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("one JSON value is expected")
	}
	return nil
}

// RelayState is GET /relay/state's answer on either socket: who answers (owner "media" or "api"),
// whether that process serves a relay now and on what, its live allocations (the media process
// has no metrics listener; this is where its relay's count shows), its cut map, and when its relay
// started (unix milliseconds; the API's replay starts over when it changes).
type RelayState struct {
	Owner       string `json:"owner"`
	Serving     bool   `json:"serving"`
	Listen      string `json:"listen,omitempty"`
	Allocations int    `json:"allocations"`
	Cuts        int    `json:"cuts"`
	Floor       int64  `json:"floor"`
	Started     int64  `json:"started"`
	// Unacked is, on api.sock, how many forwarded cuts dilla-media has not acknowledged yet.
	Unacked int `json:"unacked"`
}

// FetchControl GETs path on a control socket and decodes its JSON answer (at most maxControlBody)
// into out; any status but 200 is an error.
func FetchControl(ctx context.Context, c *http.Client, path string, out any) error {
	return controlDo(ctx, c, http.MethodGet, path, nil, out)
}

// FetchRelayState asks a control socket's GET /relay/state.
func FetchRelayState(ctx context.Context, c *http.Client) (RelayState, error) {
	var st RelayState
	err := controlDo(ctx, c, http.MethodGet, "/relay/state", nil, &st)
	return st, err
}

// NewRelayControl is media.sock's handler over the media relay's cut map. POST /relay/cut takes
// one cut and answers 204 once it is applied — its sockets closed and its credentials refused —
// which is the acknowledgement the API waits for; PUT /relay/cuts merges a whole set (the API's
// replay). Both are MergeCuts: nothing the API sends can remove a cut or lower its time. GET
// /relay/state answers state().
func NewRelayControl(rev *RelayRevocations, state func() RelayState) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /relay/cut", func(w http.ResponseWriter, r *http.Request) {
		var c RelayCut
		if err := decodeStrict(r, &c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := rev.MergeCuts([]RelayCut{c}); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("PUT /relay/cuts", func(w http.ResponseWriter, r *http.Request) {
		var cuts []RelayCut
		if err := decodeStrict(r, &cuts); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := rev.MergeCuts(cuts); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /relay/state", func(w http.ResponseWriter, _ *http.Request) {
		WriteControlJSON(w, state())
	})
	return mux
}

// WriteControlJSON answers 200 with v as JSON.
func WriteControlJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// RemoteBarred is the media relay's BarredLookup over api.sock: GET /relay/barred/{device}. It
// keeps RelayRevocations' semantics (WithBarred): a lookup that fails — the API restarting, the
// socket gone, a slow store — is an error, which caches nothing and is logged at WARN by the
// relay, and the cut map stays authoritative. It never fails closed: that would refuse every
// relayed ICE restart while the API restarts, which is what moving TURN out of it is for.
type RemoteBarred struct{ Client *http.Client }

// DeviceBarred asks the API whether device may no longer take part in calls.
func (b RemoteBarred) DeviceBarred(ctx context.Context, device id.ID) (bool, error) {
	var out struct {
		Barred *bool `json:"barred"`
	}
	if err := controlDo(ctx, b.Client, http.MethodGet, "/relay/barred/"+device.String(), nil, &out); err != nil {
		return false, err
	}
	if out.Barred == nil {
		return false, errors.New("GET /relay/barred: the answer has no barred field")
	}
	return *out.Barred, nil
}

// RelayRevoker is the call routes' relay revoker when the relay runs in `dillad media` (R-UP11).
// The API keeps its own RelayRevocations: Revoke applies there first, so Mint stays ordered
// against every cut under that one lock exactly as when the relay was in-process, and then the cut
// is forwarded to the media relay over media.sock (POST /relay/cut). Until the media relay has
// acknowledged it, Unacked reports the device, which the call routes answer 503 E_UNAVAILABLE
// (isPending, R-UP7): no start and no /rtc admission for a device whose cut the relay that would
// carry its media has not applied. Run resends what is unacknowledged, and on every (re)connect —
// a first contact, a contact after a failure, or a media relay that restarted — replays every cut
// it holds with PUT /relay/cuts, a merge on the relay's side. Across an API restart this memory is
// empty and the media relay still holds every cut.
type RelayRevoker struct {
	local  *RelayRevocations
	client *http.Client
	clk    clock.Clock
	keep   int64
	log    *slog.Logger
	// retryEvery is how soon an unacknowledged cut is resent; probeEvery how often the relay is
	// asked whether it restarted. Variables so a test can shorten them.
	retryEvery, probeEvery time.Duration

	mu sync.Mutex
	// sent is every cut forwarded, kept until keep (turn.max_allocation_age) has passed since it:
	// the set the replay sends. unacked is the part the relay has not acknowledged.
	sent    map[string]int64
	unacked map[string]int64
	up      bool
	// downWarned is when an unreachable relay was last logged (down).
	downWarned time.Time
	kick       chan struct{}
}

// NewRelayRevoker wraps local, the API's own revocation state, and forwards every cut to the media
// relay through client (ControlClient of media.sock). keep is turn.max_allocation_age, the time
// after which a cut no longer matters to any credential.
func NewRelayRevoker(local *RelayRevocations, client *http.Client, keep time.Duration, clk clock.Clock, log *slog.Logger) *RelayRevoker {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	if keep <= 0 {
		keep = 2 * time.Hour
	}
	return &RelayRevoker{
		local: local, client: client, clk: clk, keep: keep.Milliseconds(), log: log,
		retryEvery: time.Second, probeEvery: 5 * time.Second,
		sent: map[string]int64{}, unacked: map[string]int64{}, kick: make(chan struct{}, 1),
	}
}

// Revoke cuts device locally, as of at or now when that is earlier, and queues the cut for the
// media relay; the device is Unacked until the relay acknowledges it. It never blocks on the
// socket.
func (r *RelayRevoker) Revoke(device id.ID, at time.Time) {
	r.local.Revoke(device, at)
	ms := min(at.UnixMilli(), r.clk.Now().UnixMilli())
	dev := device.String()
	r.mu.Lock()
	r.sent[dev] = max(r.sent[dev], ms)
	r.unacked[dev] = max(r.unacked[dev], ms)
	r.mu.Unlock()
	select {
	case r.kick <- struct{}{}:
	default:
	}
}

// Mint is the local RelayRevocations' Mint, under the lock its cuts take.
func (r *RelayRevoker) Mint(device id.ID, since time.Time) (time.Time, time.Duration) {
	return r.local.Mint(device, since)
}

// Unacked reports whether a cut of device has not been acknowledged by the media relay. A cut that
// has expired (keep) no longer matters to any credential and is dropped.
func (r *RelayRevoker) Unacked(device id.ID) bool {
	dev := device.String()
	now := r.clk.Now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()
	at, ok := r.unacked[dev]
	if ok && now > at+r.keep {
		delete(r.unacked, dev)
		return false
	}
	return ok
}

// Run forwards and replays cuts until ctx ends.
func (r *RelayRevoker) Run(ctx context.Context) {
	var started int64
	for ctx.Err() == nil {
		wait := r.probeEvery
		if !r.round(ctx, &started) || r.pending() {
			wait = r.retryEvery
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-r.kick:
			t.Stop()
		case <-t.C:
		}
	}
}

func (r *RelayRevoker) pending() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.unacked) > 0
}

// round is one pass: ask the relay's state, replay the whole set when the relay is new to this
// process (or restarted), then send each unacknowledged cut. It reports whether the relay
// answered every request.
func (r *RelayRevoker) round(ctx context.Context, started *int64) bool {
	r.prune()
	ctx, cancel := context.WithTimeout(ctx, 4*controlTimeout)
	defer cancel()
	st, err := FetchRelayState(ctx, r.client)
	if err != nil {
		r.down(err)
		return false
	}
	r.mu.Lock()
	replay := !r.up || st.Started != *started
	r.mu.Unlock()
	if replay {
		n, err := r.replay(ctx)
		if err != nil {
			r.down(err)
			return false
		}
		*started = st.Started
		r.mu.Lock()
		r.up = true
		r.mu.Unlock()
		r.log.Info("the media relay is reachable; its cut map is merged with this process's cuts", "replayed", n)
	}
	for _, c := range r.unackedCuts() {
		if err := controlDo(ctx, r.client, http.MethodPost, "/relay/cut", c, nil); err != nil {
			r.down(err)
			return false
		}
		r.ack(c)
	}
	return true
}

// down marks the relay unreachable, so the next contact replays, and logs the transition once.
// A relay that has never answered is logged too: on the first failure, then at most once per
// downWarnEvery while it stays unreachable.
func (r *RelayRevoker) down(err error) {
	now := time.Now()
	r.mu.Lock()
	was := r.up
	r.up = false
	n := len(r.unacked)
	quiet := !was && !r.downWarned.IsZero() && now.Sub(r.downWarned) < downWarnEvery
	if !quiet {
		r.downWarned = now
	}
	r.mu.Unlock()
	if !quiet {
		r.log.Warn("the media relay does not answer on media.sock; cut devices are refused (503) until it acknowledges their cuts",
			"err", err, "unacknowledged", n)
	}
}

// downWarnEvery bounds how often an unreachable media relay is logged.
const downWarnEvery = time.Minute

// UnackedCount is how many cuts the media relay has not acknowledged yet (api.sock's GET
// /relay/state, the doctor's turn leg).
func (r *RelayRevoker) UnackedCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.unacked)
}

// replay merges every cut this process holds into the relay, in batches, and acknowledges each
// batch the relay accepted.
func (r *RelayRevoker) replay(ctx context.Context) (int, error) {
	r.mu.Lock()
	all := make([]RelayCut, 0, len(r.sent))
	for dev, at := range r.sent {
		all = append(all, RelayCut{Device: dev, At: at})
	}
	r.mu.Unlock()
	slices.SortFunc(all, func(a, b RelayCut) int { return cmp.Compare(a.At, b.At) })
	n := len(all)
	// An empty set is merged too: it is how the relay is known to take the replay at all.
	for first := true; first || len(all) > 0; first = false {
		batch := all[:min(len(all), replayBatch)]
		if err := controlDo(ctx, r.client, http.MethodPut, "/relay/cuts", batch, nil); err != nil {
			return 0, err
		}
		for _, c := range batch {
			r.ack(c)
		}
		all = all[len(batch):]
	}
	return n, nil
}

func (r *RelayRevoker) unackedCuts() []RelayCut {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]RelayCut, 0, len(r.unacked))
	for dev, at := range r.unacked {
		out = append(out, RelayCut{Device: dev, At: at})
	}
	return out
}

// ack clears c's device from the unacknowledged set unless a later cut of it is waiting.
func (r *RelayRevoker) ack(c RelayCut) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if at, ok := r.unacked[c.Device]; ok && at <= c.At {
		delete(r.unacked, c.Device)
	}
}

// prune drops the cuts keep has passed since: no credential they cover is honoured any more.
func (r *RelayRevoker) prune() {
	now := r.clk.Now().UnixMilli()
	r.mu.Lock()
	defer r.mu.Unlock()
	for dev, at := range r.sent {
		if now > at+r.keep {
			delete(r.sent, dev)
		}
	}
	for dev, at := range r.unacked {
		if now > at+r.keep {
			delete(r.unacked, dev)
		}
	}
}
