// Command dilla-testhost runs dillad with a second /debug control listener, for driving the Rust
// testkit outside `go test`. It is never built into a release: `cmd/dillad` is the only binary
// the release job builds, and this one imports internal/dillad/dilladtest, which that binary must
// not depend on.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/dillad/dilladtest"
)

func main() {
	public := flag.String("listen", "127.0.0.1:8443", "public /v1 and /gateway listener")
	control := flag.String("control", "127.0.0.1:8444", "the /debug control listener")
	dataDir := flag.String("data-dir", "", "instance data directory (default: a temp directory)")
	core := flag.String("core", "", "the wasm32-wasip1 dilla_core_wasi.wasm (default: beside this binary)")
	logLevel := flag.String("log-level", "warn", "the instance log level: debug, info, warn or error")
	withSFU := flag.Bool("sfu", false, "start an in-process LiveKit beside the instance (browser media tests)")
	sfuPort := flag.Int("sfu-port", dilladtest.DefaultSFUPort, "the in-process LiveKit's signalling port")
	sfuUDPPort := flag.Int("sfu-udp-port", dilladtest.DefaultSFUUDPPort, "the in-process LiveKit's ICE/UDP port")
	sfuNoInternalIP := flag.Bool("sfu-no-internal-ip", false,
		"SP-27 only: render advertise_internal_ip: false (Firefox then cannot pair with the loopback node_ip)")
	sfuAV1 := flag.Bool("sfu-av1", false, "browser test only: enable AV1 in the real SFU")
	flag.Parse()

	sfu := sfuOptions{enabled: *withSFU, port: *sfuPort, udpPort: *sfuUDPPort, noInternalIP: *sfuNoInternalIP, av1: *sfuAV1}
	if err := run(*public, *control, *dataDir, *core, *logLevel, sfu); err != nil {
		fmt.Fprintln(os.Stderr, "dilla-testhost:", err)
		os.Exit(1)
	}
}

// sfuOptions are the -sfu flags: whether the host starts an in-process LiveKit, and on which ports.
type sfuOptions struct {
	enabled       bool
	port, udpPort int
	noInternalIP  bool
	av1           bool
}

func run(public, control, dataDir, core, logLevel string, sfu sfuOptions) error {
	if dataDir == "" {
		dir, err := os.MkdirTemp("", "dilla-testhost-")
		if err != nil {
			return err
		}
		defer func() { _ = os.RemoveAll(dir) }()
		dataDir = dir
	}
	if core == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		core = filepath.Join(filepath.Dir(exe), dillad.CoreFileName)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// A fake clock, because advance_clock is the whole reason this binary exists: five of the
	// fifteen scenarios cross a TTL, retention or heal boundary and none of them can wait for it.
	// /metrics accepts DILLA_METRICS_TOKEN as its bearer token, exactly as dillad does, so a load
	// rig can scrape this host (docs/spikes/2026-10-capacity.md); unset, every scrape is refused.
	host, err := dilladtest.NewHost(ctx, dilladtest.HostOptions{
		DataDir: dataDir, CorePath: core, LogLevel: logLevel,
		SFU: sfu.enabled, SFUPort: sfu.port, SFUUDPPort: sfu.udpPort,
		SFUNoInternalIP: sfu.noInternalIP,
		SFUEnableAV1:    sfu.av1,
		ScrapeToken:     os.Getenv("DILLA_METRICS_TOKEN"),
	})
	if err != nil {
		return err
	}
	defer func() { _ = host.Close(context.Background()) }()

	publicLn, err := (&net.ListenConfig{}).Listen(ctx, "tcp", public)
	if err != nil {
		return err
	}
	controlLn, err := (&net.ListenConfig{}).Listen(ctx, "tcp", control)
	if err != nil {
		return err
	}

	publicSrv := &http.Server{Handler: host.Handler(), ReadHeaderTimeout: 10 * time.Second}
	controlSrv := &http.Server{
		Handler:           dilladtest.ControlHandler(host),
		ReadHeaderTimeout: 10 * time.Second,
	}
	errs := make(chan error, 2)
	go func() { errs <- publicSrv.Serve(publicLn) }()
	go func() { errs <- controlSrv.Serve(controlLn) }()

	fmt.Printf("public  http://%s\n", publicLn.Addr())
	fmt.Printf("control http://%s\n", controlLn.Addr())
	if s := host.SFU(); s != nil {
		fmt.Printf("sfu     %s\n", s.URL())
	}
	fmt.Printf("run a scenario with:\n  DILLA_TESTKIT_CONTROL=http://%s DILLA_TESTKIT_INVITE=%s \\\n"+
		"    dilla-testkit run testkit/scenarios/<name>.scn --ds http://%s\n",
		controlLn.Addr(), host.Invite(), publicLn.Addr())

	select {
	case <-ctx.Done():
	case err := <-errs:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = publicSrv.Shutdown(shutdownCtx)
	_ = controlSrv.Shutdown(shutdownCtx)
	return nil
}
