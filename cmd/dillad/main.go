// Command dillad is the dilla server. Week 1 ships only the spike harnesses
// under internal/; this binary exists so the module has a buildable main
// package, so CI can prove the release build stays cgo-free, and so the LiveKit
// spike can be reproduced by hand.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/jonasthim/dilla/internal/sfu"
)

// Version is the dillad version. It is bumped by the release process, not by
// the build.
const Version = "0.0.0-dev"

func versionLine() string {
	return fmt.Sprintf("dillad %s (%s %s/%s)", Version, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

// options is what the command line asks dillad to do.
type options struct {
	runSFU    bool
	apiSecret string
}

// newFlagSet registers dillad's flags on their own FlagSet, so a test can parse
// an argument list and assert the parsed values rather than grep main.go for a
// spelling.
func newFlagSet() (*flag.FlagSet, *options) {
	fs := flag.NewFlagSet("dillad", flag.ContinueOnError)
	opts := &options{}
	fs.BoolVar(&opts.runSFU, "sfu", false, "run the in-process LiveKit SFU on loopback until interrupted")
	fs.StringVar(&opts.apiSecret, "api-secret", "", "LiveKit API secret, at least 32 characters (required with -sfu)")
	return fs, opts
}

func main() {
	fs, opts := newFlagSet()
	if err := fs.Parse(os.Args[1:]); err != nil {
		os.Exit(2)
	}

	fmt.Println(versionLine())
	if !opts.runSFU {
		return
	}

	cfg := sfu.DefaultConfig()
	cfg.APISecret = opts.apiSecret
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	srv, err := sfu.Start(ctx, cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dillad:", err)
		os.Exit(1)
	}
	fmt.Println("sfu listening on", srv.URL())
	<-ctx.Done()
	if err := srv.Stop(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "dillad:", err)
		os.Exit(1)
	}
}
