package sfu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/livekit-server/pkg/routing"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

func testConfig() Config {
	c := DefaultConfig()
	c.APISecret = "dilla-spike-secret-0123456789abcdef"
	return c
}

// The YAML must carry exactly the keys gap-20 4 traced through NewConfig,
// ValidateKeys, LoadTURNSecrets and NewLocalNode.
func TestYAMLCarriesTheLoopbackKeys(t *testing.T) {
	y, err := testConfig().YAML()
	if err != nil {
		t.Fatalf("YAML: %v", err)
	}
	for _, want := range []string{
		"port: 7880",
		"bind_addresses:",
		"- 127.0.0.1",
		"keys:",
		"node_ip: 127.0.0.1",
		"use_external_ip: false",
		"enable_loopback_candidate: true",
		"udp_port: 7882",
		"tcp_port: 0",
		// R18 and the spec's "System architecture" item 4 (spec line 415) both
		// name turn.enabled: false explicitly. LiveKit's own DefaultConfig
		// already has it false (config.go:597-603), so the key changes no
		// behaviour — it exists so a reader checking spec line 415 against the
		// rendered YAML can find it (deviation B18).
		"turn:",
		"enabled: false",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("YAML is missing %q:\n%s", want, y)
		}
	}
	if strings.Contains(y, "turn_servers") {
		t.Error("the spike must not declare rtc.turn_servers: each entry then needs credentials " +
			"or LoadTURNSecrets fails with ErrTURNServerNoCredentials")
	}
}

func TestYAMLRejectsAShortSecret(t *testing.T) {
	c := testConfig()
	c.APISecret = "short"
	if _, err := c.YAML(); err == nil {
		t.Fatal("YAML accepted a 5-character API secret; LiveKit only logs about it, so this " +
			"check has to be ours")
	}
}

// strictMode true means every key must exist on LiveKit's structs. This is the
// test that catches a key renamed upstream on a version bump.
func TestNewConfigAcceptsTheYAMLInStrictMode(t *testing.T) {
	y, err := testConfig().YAML()
	if err != nil {
		t.Fatalf("YAML: %v", err)
	}
	conf, err := config.NewConfig(y, true, nil, nil)
	if err != nil {
		t.Fatalf("config.NewConfig(yaml, true, nil, nil): %v", err)
	}
	if err := conf.ValidateKeys(); err != nil {
		t.Errorf("ValidateKeys: %v", err)
	}
	if err := conf.LoadTURNSecrets(); err != nil {
		t.Errorf("LoadTURNSecrets: %v", err)
	}
	node, err := routing.NewLocalNode(conf)
	if err != nil {
		t.Fatalf("routing.NewLocalNode: %v (ErrIPNotSet means node_ip did not reach the config)", err)
	}
	if node.NodeID() == "" {
		t.Error("NewLocalNode produced an empty node id")
	}
	if conf.RTC.NodeIP.IsEmpty() {
		t.Error("rtc.node_ip is empty; resolveNodeIP would then run and pull in the default public STUN list")
	}
	if conf.RTC.UseExternalIP {
		t.Error("use_external_ip is true; that forces a STUN round trip on a loopback-only box")
	}
	if !conf.RTC.EnableLoopbackCandidate {
		t.Error("enable_loopback_candidate is false; CreateUDPMuxesFromPorts then yields zero host " +
			"candidates on a machine whose only interface is lo, silently and with no error")
	}
	if conf.TURN.Enabled {
		t.Error("turn.enabled is true; R18 and the spec's System architecture item 4 require it off")
	}
}

func TestValidateKeysFailsWithoutKeys(t *testing.T) {
	// The same shape with an empty keys map: ValidateKeys is the only call that
	// refuses an under-specified config, and there is no development escape.
	const noKeys = "port: 7880\n" +
		"bind_addresses:\n  - 127.0.0.1\n" +
		"keys: {}\n" +
		"rtc:\n" +
		"  node_ip: 127.0.0.1\n" +
		"  use_external_ip: false\n" +
		"  enable_loopback_candidate: true\n" +
		"  udp_port: 7882\n" +
		"  tcp_port: 0\n"
	conf, err := config.NewConfig(noKeys, true, nil, nil)
	if err != nil {
		t.Fatalf("NewConfig: %v", err)
	}
	err = conf.ValidateKeys()
	if err == nil {
		t.Fatal("ValidateKeys accepted an empty keys map")
	}
	if !strings.Contains(err.Error(), "one of key-file or keys must be provided") {
		t.Errorf("ValidateKeys error = %q, want it to name the missing keys", err)
	}
}

// prometheus.Init registers on the global default registry and the package's
// metric vectors are nil until it runs, so it must happen before
// service.InitializeServer, exactly as LiveKit's own cmd/server/main.go does.
// Ordering cannot be observed at run time, so assert it in the source.
func TestPrometheusInitPrecedesInitializeServer(t *testing.T) {
	src, err := os.ReadFile("livekit.go")
	if err != nil {
		t.Fatalf("read livekit.go: %v", err)
	}
	text := string(src)
	initIdx := strings.Index(text, "prometheus.Init(")
	serverIdx := strings.Index(text, "service.InitializeServer(")
	if initIdx < 0 {
		t.Fatal("livekit.go never calls prometheus.Init")
	}
	if serverIdx < 0 {
		t.Fatal("livekit.go never calls service.InitializeServer")
	}
	if initIdx > serverIdx {
		t.Error("prometheus.Init is called after service.InitializeServer")
	}
	if !strings.Contains(text, "go s.server.Start()") && !strings.Contains(text, "go func()") {
		t.Error("LivekitServer.Start blocks on <-s.doneChan; it must run in its own goroutine")
	}
}

// pkg/media imports github.com/livekit/media-sdk/opus, which is cgo and libopus
// with no build-tag fallback (gap-21 §3). NOTHING in dillad may import it — not
// internal/sfu, not cmd/dillad, not a package that does not exist yet. A scan of
// this directory's .go files would only prove it about this directory, so ask the
// toolchain for the whole module's transitive import set instead.
func TestNothingInTheModuleImportsTheCgoMediaPackage(t *testing.T) {
	goTool, err := exec.LookPath("go")
	if err != nil {
		// runtime.GOROOT is deprecated; the environment variable is what `go test` itself is run
		// under when the tool is not on PATH. (`go env GOROOT` would need the tool it is looking for.)
		if root := os.Getenv("GOROOT"); root != "" {
			goTool = filepath.Join(root, "bin", "go")
		} else {
			t.Fatalf("cannot locate the go tool to list the module's dependencies: %v", err)
		}
	}
	// -test is required, not optional: without it `go list -deps ./...` walks
	// only the non-test import graph, and server-sdk-go/v2 is imported from this
	// very file, so the plain form reports neither the SDK nor anything it would
	// pull in — the check would pass vacuously. With -test the set covers every
	// package dillad compiles, tests included.
	cmd := exec.CommandContext(t.Context(), goTool, "list", "-deps", "-test", "./...")
	cmd.Dir = "../.." // the module root
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps -test ./...: %v\n%s", err, out)
	}
	const forbidden = "github.com/livekit/server-sdk-go/v2/pkg/media"
	for _, line := range strings.Split(string(out), "\n") {
		// Under -test a package built for a test binary is listed as
		// "<import path> [<test package>.test]"; compare the import path alone.
		path, _, _ := strings.Cut(strings.TrimSpace(line), " ")
		if path == forbidden {
			t.Fatalf("%s is in the module's transitive import set; it needs cgo and libopus "+
				"headers, so CGO_ENABLED=0 go build ./cmd/dillad would stop working", forbidden)
		}
	}
	if !strings.Contains(string(out), "github.com/livekit/server-sdk-go/v2\n") {
		t.Error("go list -deps -test ./... does not mention server-sdk-go/v2 at all; the check " +
			"passed vacuously, so the package list or the working directory is wrong")
	}
}

// The spike itself: boot the SFU on loopback and have two Go-SDK participants
// exchange a data message. No livekit-client, no media package.
func TestTwoParticipantsExchangeADataMessage(t *testing.T) {
	ctx := context.Background()
	c := testConfig()

	startedAt := time.Now()
	srv, err := Start(ctx, c)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	startup := time.Since(startedAt)
	t.Logf("SPIKE startup=%s url=%s http=%s", startup, srv.URL(), srv.HTTPURL())
	defer func() {
		if err := srv.Stop(context.Background()); err != nil {
			t.Errorf("Stop: %v", err)
		}
	}()

	const room = "dilla-spike"
	aliceToken, err := srv.Token(room, "alice")
	if err != nil {
		t.Fatalf("Token(alice): %v", err)
	}
	bobToken, err := srv.Token(room, "bob")
	if err != nil {
		t.Fatalf("Token(bob): %v", err)
	}

	received := make(chan []byte, 4)
	bobCB := &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnDataPacket: func(data lksdk.DataPacket, params lksdk.DataReceiveParams) {
				if u, ok := data.(*lksdk.UserDataPacket); ok {
					select {
					case received <- append([]byte(nil), u.Payload...):
					default:
					}
				}
			},
		},
	}
	bob, err := lksdk.ConnectToRoomWithToken(srv.URL(), bobToken, bobCB)
	if err != nil {
		t.Fatalf("bob join: %v", err)
	}
	defer bob.Disconnect()

	alice, err := lksdk.ConnectToRoomWithToken(srv.URL(), aliceToken, &lksdk.RoomCallback{})
	if err != nil {
		t.Fatalf("alice join: %v", err)
	}
	defer alice.Disconnect()

	payload := []byte("dilla spike: mls handshake would go here")
	deadline := time.After(20 * time.Second)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	firstTry := time.Now()
	for {
		if err := alice.LocalParticipant.PublishDataPacket(
			lksdk.UserData(payload), lksdk.WithDataPublishReliable(true)); err != nil {
			t.Logf("publish retry: %v", err)
		}
		select {
		case got := <-received:
			if string(got) != string(payload) {
				t.Fatalf("bob received %q, want %q", got, payload)
			}
			t.Logf("SPIKE data_delivered_after=%s", time.Since(firstTry))
			return
		case <-deadline:
			t.Fatalf("bob received no data packet within 20s; alice sees %d remote participants",
				len(alice.GetRemoteParticipants()))
		case <-tick.C:
		}
	}
}

// nothingListensOn fails the test if addr accepts a TCP connection at any point
// during window. The window has to outlast the boot the aborted Start left
// running: returning before the listeners are even bound is not success, it is
// the leak one moment earlier.
//
// An aborted Start must leave no listener behind: LiveKit binds
// its listeners (server.go:246) a deliberate 100 ms before it sets the running
// flag (server.go:333), and Stop returns immediately while that flag is false
// (server.go:373, `if !s.running.Swap(false) { return }`). A Stop issued inside
// that window does nothing, so the boot finishes, the goroutine parks on
// <-doneChan forever, and the port stays bound with the *Server handle already
// discarded — nothing can ever stop it.
func nothingListensOn(t *testing.T, addr string, window time.Duration) {
	t.Helper()
	deadline := time.Now().Add(window)
	for time.Now().Before(deadline) {
		conn, err := (&net.Dialer{Timeout: 250 * time.Millisecond}).DialContext(t.Context(), "tcp", addr)
		if err == nil {
			_ = conn.Close()
			t.Fatalf("%s accepted a connection after Start aborted: the server was stopped "+
				"while its running flag was false, so Stop did nothing and the boot goroutine "+
				"leaked with the port bound", addr)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// Abort path 1: the caller's context is already cancelled. cmd/dillad passes a
// signal.NotifyContext, so this is the SIGINT-during-boot case.
func TestStartAbortedByAContextCancelLeavesNothingListening(t *testing.T) {
	c := testConfig()
	c.Port = 7890
	c.UDPPort = 7892

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	srv, err := Start(ctx, c)
	if err == nil {
		_ = srv.Stop(context.Background())
		t.Fatal("Start returned no error for an already-cancelled context")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("Start error = %v, want it to wrap context.Canceled", err)
	}
	if srv != nil {
		t.Error("Start returned a non-nil *Server together with an error")
	}
	nothingListensOn(t, net.JoinHostPort(c.BindAddress, fmt.Sprint(c.Port)), 3*time.Second)
}

// Abort path 2: the startup deadline expires. Same window, same no-op Stop.
func TestStartAbortedByTheDeadlineLeavesNothingListening(t *testing.T) {
	restore := startTimeout
	startTimeout = time.Millisecond
	defer func() { startTimeout = restore }()

	c := testConfig()
	c.Port = 7894
	c.UDPPort = 7896

	srv, err := Start(context.Background(), c)
	if err == nil {
		_ = srv.Stop(context.Background())
		t.Fatal("Start returned no error although the startup deadline was 1ms")
	}
	if !strings.Contains(err.Error(), "did not accept a connection") {
		t.Errorf("Start error = %v, want the startup-deadline error", err)
	}
	nothingListensOn(t, net.JoinHostPort(c.BindAddress, fmt.Sprint(c.Port)), 3*time.Second)
}

// I11 (fix wave): ending a call closes its room. DeleteRoom disconnects a participant still in the
// room, and a room LiveKit does not know (never opened, or already closed) is not an error: the call
// is over either way.
func TestDeleteRoomDisconnectsItsParticipants(t *testing.T) {
	c := testConfig()
	c.Port = 7900
	c.UDPPort = 7902
	srv, err := Start(context.Background(), c)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() {
		if err := srv.Stop(context.Background()); err != nil {
			t.Errorf("Stop: %v", err)
		}
	}()

	if err := srv.DeleteRoom(t.Context(), "never-opened"); err != nil {
		t.Fatalf("DeleteRoom of a room LiveKit never had = %v, want nil", err)
	}

	const room = "dilla-call"
	tok, err := srv.Token(room, "bob")
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	gone := make(chan struct{})
	var once sync.Once
	bob, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, &lksdk.RoomCallback{
		OnDisconnected: func() { once.Do(func() { close(gone) }) },
	})
	if err != nil {
		t.Fatalf("bob join: %v", err)
	}
	defer bob.Disconnect()

	if err := srv.DeleteRoom(t.Context(), room); err != nil {
		t.Fatalf("DeleteRoom: %v", err)
	}
	select {
	case <-gone:
	case <-time.After(15 * time.Second):
		t.Fatal("bob is still connected 15s after his room was deleted")
	}
	if err := srv.DeleteRoom(t.Context(), room); err != nil {
		t.Fatalf("a second DeleteRoom of the closed room = %v, want nil", err)
	}
}
