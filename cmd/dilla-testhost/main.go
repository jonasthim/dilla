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
	flag.Parse()

	if err := run(*public, *control, *dataDir, *core, *logLevel); err != nil {
		fmt.Fprintln(os.Stderr, "dilla-testhost:", err)
		os.Exit(1)
	}
}

func run(public, control, dataDir, core, logLevel string) error {
	if dataDir == "" {
		dir, err := os.MkdirTemp("", "dilla-testhost-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
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
	host, err := dilladtest.NewHost(ctx, dilladtest.HostOptions{
		DataDir: dataDir, CorePath: core, LogLevel: logLevel,
	})
	if err != nil {
		return err
	}
	defer func() { _ = host.Close(context.Background()) }()

	publicLn, err := net.Listen("tcp", public)
	if err != nil {
		return err
	}
	controlLn, err := net.Listen("tcp", control)
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
