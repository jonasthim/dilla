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
	o, err := parseFlags(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "dilla-testhost:", err)
		os.Exit(2)
	}
	if err := run(o); err != nil {
		fmt.Fprintln(os.Stderr, "dilla-testhost:", err)
		os.Exit(1)
	}
}

type options struct {
	public, control, dataDir, core, logLevel, webRoot string
	productionACL                                     bool
	sfu                                               sfuOptions
}

func parseFlags(args []string) (options, error) {
	fs := flag.NewFlagSet("dilla-testhost", flag.ContinueOnError)
	public := fs.String("listen", "127.0.0.1:8443", "public /v1 and /gateway listener")
	control := fs.String("control", "127.0.0.1:8444", "the /debug control listener")
	dataDir := fs.String("data-dir", "", "instance data directory (default: a temp directory)")
	core := fs.String("core", "", "the wasm32-wasip1 dilla_core_wasi.wasm (default: beside this binary)")
	logLevel := fs.String("log-level", "warn", "the instance log level: debug, info, warn or error")
	withSFU := fs.Bool("sfu", false, "start an in-process LiveKit beside the instance (browser media tests)")
	sfuPort := fs.Int("sfu-port", dilladtest.DefaultSFUPort, "the in-process LiveKit's signalling port")
	sfuUDPPort := fs.Int("sfu-udp-port", dilladtest.DefaultSFUUDPPort, "the in-process LiveKit's ICE/UDP port")
	sfuNoInternalIP := fs.Bool("sfu-no-internal-ip", false,
		"SP-27 only: render advertise_internal_ip: false (Firefox then cannot pair with the loopback node_ip)")
	sfuAV1 := fs.Bool("sfu-av1", false, "browser test only: enable AV1 in the real SFU")
	webRoot := fs.String("web-root", "", "a built web client directory (with its dilla-manifest.json) served at the public listener's origin instead of the embedded placeholder")
	productionACL := fs.Bool("production-acl", false, "build the instance with production's ACL and channel seams (api.ResolverACL, api.StructureChannels) instead of the scenario harness's")
	if err := fs.Parse(args); err != nil {
		return options{}, err
	}
	root := *webRoot
	if root != "" {
		abs, err := filepath.Abs(root)
		if err != nil {
			return options{}, fmt.Errorf("-web-root %s: %w", root, err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return options{}, fmt.Errorf("-web-root %s: %w", abs, err)
		}
		if !info.IsDir() {
			return options{}, fmt.Errorf("-web-root %s: not a directory", abs)
		}
		root = abs
	}
	return options{public: *public, control: *control, dataDir: *dataDir, core: *core,
		logLevel: *logLevel, webRoot: root, productionACL: *productionACL,
		sfu: sfuOptions{enabled: *withSFU, port: *sfuPort, udpPort: *sfuUDPPort,
			noInternalIP: *sfuNoInternalIP, av1: *sfuAV1}}, nil
}

// sfuOptions are the -sfu flags: whether the host starts an in-process LiveKit, and on which ports.
type sfuOptions struct {
	enabled       bool
	port, udpPort int
	noInternalIP  bool
	av1           bool
}

func (o options) hostOptions(dataDir, core, scrapeToken string) dilladtest.HostOptions {
	return dilladtest.HostOptions{
		DataDir: dataDir, CorePath: core, LogLevel: o.logLevel,
		SFU: o.sfu.enabled, SFUPort: o.sfu.port, SFUUDPPort: o.sfu.udpPort,
		SFUNoInternalIP: o.sfu.noInternalIP, SFUEnableAV1: o.sfu.av1,
		ScrapeToken: scrapeToken, WebRoot: o.webRoot, ProductionACL: o.productionACL,
	}
}

func run(o options) error {
	dataDir, core := o.dataDir, o.core
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
	host, err := dilladtest.NewHost(ctx, o.hostOptions(dataDir, core, os.Getenv("DILLA_METRICS_TOKEN")))
	if err != nil {
		return err
	}
	defer func() { _ = host.Close(context.Background()) }()

	publicLn, err := (&net.ListenConfig{}).Listen(ctx, "tcp", o.public)
	if err != nil {
		return err
	}
	controlLn, err := (&net.ListenConfig{}).Listen(ctx, "tcp", o.control)
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
	if o.webRoot != "" {
		fmt.Printf("web     %s\n", o.webRoot)
	}
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
