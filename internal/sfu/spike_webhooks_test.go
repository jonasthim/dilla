//go:build spike

package sfu

// SP-21 (docs/spikes/2026-10-livekit-webhooks.md): what the in-process LiveKit v1.13.7 delivers to a
// webhook receiver, how fast, in what order, what happens while the receiver fails, how long a
// killed client takes to become participant_left, and whether a mismatched webhook.api_key fails
// the boot. Behind the spike tag: these tests measure, they do not gate, and none runs in CI (MD-17).
//
//	go test -tags spike -count=1 -v -run 'TestSpike(Webhook|Mismatched|Crash)' ./internal/sfu/
//
// Every number the result document quotes is printed on a line that starts with "SPIKE".

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	"github.com/livekit/livekit-server/pkg/service"
	lkprom "github.com/livekit/livekit-server/pkg/telemetry/prometheus"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

// spikeEvent is one verified webhook POST as the receiver saw it.
type spikeEvent struct {
	at     time.Time
	name   string
	room   string
	ident  string
	track  *livekit.TrackInfo
	id     string
	status int // what the receiver answered
}

// spikeReceiver verifies every POST like production will and records it; status (and retryAfter,
// when set) decides the answer. events holds the POSTs answered 200, attempts every POST.
type spikeReceiver struct {
	mu         sync.Mutex
	provider   auth.KeyProvider
	events     []spikeEvent
	attempts   []spikeEvent
	status     int
	retryAfter string
	unverified int
}

func (r *spikeReceiver) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	now := time.Now()
	ev, err := webhook.ReceiveWebhookEvent(req, r.provider)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.unverified++
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	e := spikeEvent{at: now, name: ev.GetEvent(), room: ev.GetRoom().GetName(),
		ident: ev.GetParticipant().GetIdentity(), track: ev.GetTrack(), id: ev.GetId(), status: r.status}
	r.attempts = append(r.attempts, e)
	if r.status != http.StatusOK {
		if r.retryAfter != "" {
			w.Header().Set("Retry-After", r.retryAfter)
		}
		w.WriteHeader(r.status)
		return
	}
	r.events = append(r.events, e)
	w.WriteHeader(http.StatusOK)
}

func (r *spikeReceiver) find(names []string, room, ident string) (spikeEvent, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.events {
		if slices.Contains(names, e.name) && e.room == room && (ident == "" || e.ident == ident) {
			return e, true
		}
	}
	return spikeEvent{}, false
}

func (r *spikeReceiver) waitAny(t *testing.T, names []string, room, ident string, within time.Duration) spikeEvent {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if e, ok := r.find(names, room, ident); ok {
			return e
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no %v for %s/%s within %s", names, room, ident, within)
	return spikeEvent{}
}

func (r *spikeReceiver) wait(t *testing.T, name, room, ident string, within time.Duration) spikeEvent {
	t.Helper()
	return r.waitAny(t, []string{name}, room, ident, within)
}

func bootSpikeSFU(t *testing.T, port int, rec *spikeReceiver) *Server {
	t.Helper()
	ts := httptest.NewServer(rec)
	t.Cleanup(ts.Close)
	c := testConfig()
	c.Port, c.UDPPort = port, port+2
	c.WebhookURL = ts.URL + WebhookPath
	rec.provider = auth.NewSimpleKeyProvider(c.APIKey, c.APISecret)
	srv, err := Start(t.Context(), c)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop(context.WithoutCancel(t.Context())) })
	return srv
}

func quantiles(ds []time.Duration) string {
	if len(ds) == 0 {
		return "n=0"
	}
	s := slices.Clone(ds)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	q := func(p int) time.Duration { return s[min(len(s)-1, (len(s)*p+99)/100-1)] }
	return fmt.Sprintf("n=%d min=%s p50=%s p95=%s max=%s", len(s), s[0], q(50), q(95), s[len(s)-1])
}

// Q1 + Q2: join/leave latency against the SDK, per-room ordering, room_finished after the last
// leave, and what track_published carries.
func TestSpikeWebhookLatencyOrderingAndEncryption(t *testing.T) {
	rec := &spikeReceiver{status: http.StatusOK}
	srv := bootSpikeSFU(t, 7966, rec)
	var joined, joinedFromStart, left []time.Duration
	leftAt := map[string]time.Time{}
	early := 0
	for i := range 20 {
		room := fmt.Sprintf("spike-room-%02d", i)
		if err := srv.CreateRoom(t.Context(), room); err != nil {
			t.Fatalf("CreateRoom: %v", err)
		}
		tok, _ := srv.Token(room, "alice", PublishGrant(true, false, false), nil)
		start := time.Now()
		r, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, &lksdk.RoomCallback{})
		if err != nil {
			t.Fatalf("join %s: %v", room, err)
		}
		connected := time.Now()
		e := rec.wait(t, webhook.EventParticipantJoined, room, "alice", 10*time.Second)
		if e.at.Before(connected) {
			early++
		}
		joined = append(joined, e.at.Sub(connected))
		joinedFromStart = append(joinedFromStart, e.at.Sub(start))
		disconnected := time.Now()
		r.Disconnect()
		e = rec.wait(t, webhook.EventParticipantLeft, room, "alice", 30*time.Second)
		left = append(left, e.at.Sub(disconnected))
		leftAt[room] = e.at
	}
	t.Logf("SPIKE joined_latency (from ConnectToRoomWithToken's return) %s; arrived before the return: %d", quantiles(joined), early)
	t.Logf("SPIKE joined_latency_from_connect_start %s", quantiles(joinedFromStart))
	t.Logf("SPIKE left_latency %s", quantiles(left))

	// room_finished: departure_timeout is 20 s after the last leave.
	var finished []time.Duration
	for i := range 20 {
		room := fmt.Sprintf("spike-room-%02d", i)
		e := rec.wait(t, webhook.EventRoomFinished, room, "", 40*time.Second)
		finished = append(finished, e.at.Sub(leftAt[room]))
	}
	t.Logf("SPIKE room_finished_after_participant_left %s (departure_timeout %d s)", quantiles(finished), testConfig().DepartureTimeout)

	// Ordering: per room, room_started < participant_joined < participant_left < room_finished in arrival order.
	rec.mu.Lock()
	order := map[string][]string{}
	for _, e := range rec.events {
		order[e.room] = append(order[e.room], e.name)
	}
	ids := map[string]bool{}
	dupes := 0
	for _, e := range rec.events {
		if ids[e.id] {
			dupes++
		}
		ids[e.id] = true
	}
	total := len(rec.events)
	rec.mu.Unlock()
	want := []string{webhook.EventRoomStarted, webhook.EventParticipantJoined, webhook.EventParticipantLeft, webhook.EventRoomFinished}
	bad := 0
	for room, names := range order {
		if !slices.Equal(names, want) {
			bad++
			t.Logf("SPIKE order %s = %v", room, names)
		}
	}
	t.Logf("SPIKE per_room_order_violations=%d duplicate_ids=%d events=%d rooms=%d sequence=%v", bad, dupes, total, len(order), want)

	// track_published: what Encryption reaches the receiver for a NONE and a CUSTOM publication.
	const room = "spike-tracks"
	if err := srv.CreateRoom(t.Context(), room); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	for _, enc := range []livekit.Encryption_Type{livekit.Encryption_NONE, livekit.Encryption_CUSTOM} {
		ident := "pub-" + strings.ToLower(enc.String())
		tok, _ := srv.Token(room, ident, PublishGrant(true, false, false), nil)
		r, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, &lksdk.RoomCallback{})
		if err != nil {
			t.Fatalf("join %s: %v", ident, err)
		}
		t.Cleanup(r.Disconnect)
		track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
		if err != nil {
			t.Fatalf("track: %v", err)
		}
		published := time.Now()
		if _, err := r.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
			Name: "mic", Source: livekit.TrackSource_MICROPHONE, Encryption: enc,
		}); err != nil {
			t.Fatalf("publish %s: %v", ident, err)
		}
		pumpSamples(t, track, opusSilence, 20*time.Millisecond)
		e := rec.wait(t, webhook.EventTrackPublished, room, ident, 10*time.Second)
		t.Logf("SPIKE track_published %s: encryption=%s type=%s source=%s mime=%s after=%s", ident,
			e.track.GetEncryption(), e.track.GetType(), e.track.GetSource(), e.track.GetMimeType(), e.at.Sub(published))
	}
}

// Q3: a receiver that answers 500 for 35 s — which events are retried, how often, which are lost.
func TestSpikeWebhookReceiverDownFor35s(t *testing.T) {
	rec := &spikeReceiver{status: http.StatusInternalServerError}
	srv := bootSpikeSFU(t, 7970, rec)
	down := time.Now()
	for i := range 3 {
		room := fmt.Sprintf("spike-down-%d", i)
		if err := srv.CreateRoom(t.Context(), room); err != nil {
			t.Fatalf("CreateRoom: %v", err)
		}
		tok, _ := srv.Token(room, "alice", PublishGrant(true, false, false), nil)
		r, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, &lksdk.RoomCallback{})
		if err != nil {
			t.Fatalf("join: %v", err)
		}
		t.Cleanup(r.Disconnect)
		time.Sleep(10 * time.Second)
	}
	time.Sleep(time.Until(down.Add(35 * time.Second)))
	rec.mu.Lock()
	rec.status = http.StatusOK
	rec.mu.Unlock()
	t.Logf("SPIKE receiver_recovered_at=+%s", time.Since(down).Round(100*time.Millisecond))
	time.Sleep(20 * time.Second)

	rec.mu.Lock()
	defer rec.mu.Unlock()
	type perEvent struct {
		label    string
		offsets  []string
		statuses []int
	}
	var keys []string
	byID := map[string]*perEvent{}
	failed := 0
	for _, a := range rec.attempts {
		p := byID[a.id]
		if p == nil {
			p = &perEvent{label: a.name + "@" + a.room}
			byID[a.id] = p
			keys = append(keys, a.id)
		}
		p.offsets = append(p.offsets, "+"+a.at.Sub(down).Round(100*time.Millisecond).String())
		p.statuses = append(p.statuses, a.status)
		if a.status != http.StatusOK {
			failed++
		}
	}
	t.Logf("SPIKE attempts_while_down=%d (answered 500) events_attempted=%d unverified=%d", failed, len(keys), rec.unverified)
	for _, k := range keys {
		p := byID[k]
		t.Logf("SPIKE attempt %s id=%s attempts=%d at=%v status=%v", p.label, k, len(p.offsets), p.offsets, p.statuses)
	}
	var arrived []string
	for _, e := range rec.events {
		arrived = append(arrived, e.name+"@"+e.room+"(+"+e.at.Sub(down).Round(100*time.Millisecond).String()+")")
	}
	t.Logf("SPIKE delivered_after_recovery=%v", arrived)
}

// Q3b: the receiver's planned full-queue answer, 503 with Retry-After: 1 — how LiveKit's client
// spaces its retries against it.
func TestSpikeWebhookReceiver503RetryAfter1(t *testing.T) {
	rec := &spikeReceiver{status: http.StatusServiceUnavailable, retryAfter: "1"}
	srv := bootSpikeSFU(t, 7982, rec)
	down := time.Now()
	if err := srv.CreateRoom(t.Context(), "spike-503"); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	time.Sleep(12 * time.Second)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	var offsets []string
	for _, a := range rec.attempts {
		offsets = append(offsets, a.name+"+"+a.at.Sub(down).Round(10*time.Millisecond).String())
	}
	t.Logf("SPIKE retry_after_1_attempts=%d at=%v", len(rec.attempts), offsets)
}

// Q5 child: a participant in its own process, so the parent can SIGKILL it and the SFU sees a
// transport that dies without a Leave. It skips unless the parent set its environment.
func TestSpikeCrashChildParticipant(t *testing.T) {
	url, tok := os.Getenv("DILLA_SPIKE_CHILD_URL"), os.Getenv("DILLA_SPIKE_CHILD_TOKEN")
	if url == "" || tok == "" {
		t.Skip("the crash child runs only under TestSpikeCrashLeaveLatency")
	}
	r, err := lksdk.ConnectToRoomWithToken(url, tok, &lksdk.RoomCallback{})
	if err != nil {
		t.Fatalf("join: %v", err)
	}
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
	if err != nil {
		t.Fatalf("track: %v", err)
	}
	if _, err := r.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "mic", Source: livekit.TrackSource_MICROPHONE}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	pumpSamples(t, track, opusSilence, 20*time.Millisecond)
	fmt.Println("SPIKE-CHILD READY")
	time.Sleep(5 * time.Minute) // the parent kills it long before
}

// Q5: a killed client — SIGKILL of a participant process that is publishing audio with ICE
// connected — until participant_left (or participant_connection_aborted) reaches the receiver.
func TestSpikeCrashLeaveLatency(t *testing.T) {
	const n = 10
	rec := &spikeReceiver{status: http.StatusOK}
	srv := bootSpikeSFU(t, 7978, rec)
	type child struct {
		room, ident string
		cmd         *exec.Cmd
		killed      time.Time
	}
	children := make([]*child, n)
	for i := range n {
		c := &child{room: fmt.Sprintf("spike-crash-%02d", i), ident: fmt.Sprintf("crash-%02d", i)}
		if err := srv.CreateRoom(t.Context(), c.room); err != nil {
			t.Fatalf("CreateRoom: %v", err)
		}
		tok, _ := srv.Token(c.room, c.ident, PublishGrant(true, false, false), nil)
		c.cmd = exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestSpikeCrashChildParticipant$", "-test.v", "-test.count=1", "-test.timeout=10m")
		c.cmd.Env = append(os.Environ(), "DILLA_SPIKE_CHILD_URL="+srv.URL(), "DILLA_SPIKE_CHILD_TOKEN="+tok)
		out, err := c.cmd.StdoutPipe()
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
		if err := c.cmd.Start(); err != nil {
			t.Fatalf("start child: %v", err)
		}
		t.Cleanup(func() { _ = c.cmd.Process.Kill(); _ = c.cmd.Wait() })
		ready := make(chan struct{})
		go func() {
			s := bufio.NewScanner(out)
			once := sync.Once{}
			for s.Scan() {
				if strings.Contains(s.Text(), "SPIKE-CHILD READY") {
					once.Do(func() { close(ready) })
				}
			}
		}()
		select {
		case <-ready:
		case <-time.After(30 * time.Second):
			t.Fatalf("child %s never became ready", c.ident)
		}
		children[i] = c
	}
	// Media flows (track_published needs RTP) and ICE is connected for every child.
	for _, c := range children {
		rec.wait(t, webhook.EventTrackPublished, c.room, c.ident, 15*time.Second)
	}
	time.Sleep(3 * time.Second)
	for _, c := range children {
		c.killed = time.Now()
		if err := c.cmd.Process.Kill(); err != nil {
			t.Fatalf("kill %s: %v", c.ident, err)
		}
		time.Sleep(700 * time.Millisecond) // spread the kills across the SFU's 2 s ICE check phase
	}
	var lat []time.Duration
	names := map[string]int{}
	for _, c := range children {
		e := rec.waitAny(t, []string{webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted}, c.room, c.ident, 60*time.Second)
		lat = append(lat, e.at.Sub(c.killed))
		names[e.name]++
		t.Logf("SPIKE crash %s: %s after %s", c.ident, e.name, e.at.Sub(c.killed).Round(10*time.Millisecond))
	}
	t.Logf("SPIKE crash_left_latency %s events=%v", quantiles(lat), names)
}

// Q4: a webhook.api_key that is not in keys: fails the boot with ErrWebHookMissingAPIKey, not a panic.
// The production renderer writes both from Config.APIKey; the spike edits the rendered YAML to force
// the mismatch and runs Start's own boot sequence.
func TestSpikeMismatchedWebhookKeyFailsTheBoot(t *testing.T) {
	c := testConfig()
	c.Port, c.UDPPort = 7974, 7976
	c.WebhookURL = "http://127.0.0.1:1" + WebhookPath
	yaml, err := c.YAML()
	if err != nil {
		t.Fatalf("YAML: %v", err)
	}
	marker := "  api_key: " + c.APIKey + "\n"
	if !strings.Contains(yaml, marker) {
		t.Fatalf("the rendered webhook block has no %q:\n%s", marker, yaml)
	}
	yaml = strings.Replace(yaml, marker, "  api_key: someone-else\n", 1)
	conf, err := config.NewConfig(yaml, true, nil, nil)
	if err != nil {
		t.Fatalf("NewConfig: %v", err)
	}
	if err := conf.ValidateKeys(); err != nil {
		t.Fatalf("ValidateKeys: %v", err)
	}
	node, err := routing.NewLocalNode(conf)
	if err != nil {
		t.Fatalf("NewLocalNode: %v", err)
	}
	if err := lkprom.Init(string(node.NodeID()), node.NodeType()); err != nil {
		t.Fatalf("prometheus.Init: %v", err)
	}
	_, err = service.InitializeServer(conf, node)
	t.Logf("SPIKE mismatched_api_key: %v (is ErrWebHookMissingAPIKey: %v)", err, errors.Is(err, service.ErrWebHookMissingAPIKey))
	if !errors.Is(err, service.ErrWebHookMissingAPIKey) {
		t.Fatalf("InitializeServer = %v, want ErrWebHookMissingAPIKey", err)
	}
	// And through dilla's own Start: the same YAML cannot be forced there (Start renders api_key from
	// APIKey), so an empty-key mismatch is impossible by construction; record that Start with a
	// webhook URL boots.
	c2 := testConfig()
	c2.Port, c2.UDPPort = 7986, 7988
	c2.WebhookURL = "http://127.0.0.1:1" + WebhookPath
	srv, err := Start(t.Context(), c2)
	if err != nil {
		t.Fatalf("Start with a webhook URL: %v", err)
	}
	_ = srv.Stop(context.WithoutCancel(t.Context()))
	t.Logf("SPIKE start_with_webhook_url: boots (api_key rendered from Config.APIKey)")
}
