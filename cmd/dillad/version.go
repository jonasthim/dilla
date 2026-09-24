package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"
	"runtime/debug"

	"github.com/jonasthim/dilla/internal/exit"
)

// newFlagSet registers the flags every verb shares. --config is registered on
// EVERY subcommand's FlagSet, not only globally: a flag defined only on the
// global set is not reached by `dillad serve --config=X` (gap-82 verdict 7).
func newFlagSet(name string, stderr io.Writer) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet("dillad "+name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	cfg := fs.String("config", "/etc/dilla/dilla.toml", "path to dilla.toml")
	return fs, cfg
}

// parse runs fs.Parse and converts its two outcomes into dillad's exit codes.
// flag.ContinueOnError has ALREADY written the message and the usage block, so
// nothing here prints them a second time (gap-82 verdict 8).
func parse(fs *flag.FlagSet, args []string, stdout io.Writer) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fs.SetOutput(stdout)
			fs.Usage()
			return nil
		}
		return fmt.Errorf("%s: %w", fs.Name(), exit.Usage)
	}
	return nil
}

func runVersion(args []string, stdout, stderr io.Writer) error {
	fs, _ := newFlagSet("version", stderr)
	if err := parse(fs, args, stdout); err != nil {
		return err
	}
	revision, cgo := "unknown", "unknown"
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				revision = s.Value
			case "CGO_ENABLED":
				cgo = s.Value
			}
		}
	}
	fmt.Fprintf(stdout, "dillad %s (%s %s/%s) revision=%s CGO_ENABLED=%s\n",
		Version, runtime.Version(), runtime.GOOS, runtime.GOARCH, revision, cgo)
	return nil
}
