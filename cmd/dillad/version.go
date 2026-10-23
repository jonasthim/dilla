package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"

	"github.com/jonasthim/dilla/internal/dillad"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/store/sqlite/migrations"
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

// errHelp is what parse returns once it has answered --help: the verb's caller returns it at
// once, without running the verb, and dispatch turns it into exit 0.
var errHelp = errors.New("help requested")

// parse runs fs.Parse and converts its outcomes into dillad's exit codes.
// flag.ContinueOnError writes the message and the usage block itself, to the
// FlagSet's output, so nothing here prints them a second time (gap-82 verdict
// 8). A request for help is answered on stdout and only there: the output is
// pointed at stdout before parsing when one is present, and Parse's ErrHelp
// becomes errHelp so the verb body never runs (review I15).
func parse(fs *flag.FlagSet, args []string, stdout io.Writer) error {
	if wantsHelp(args) {
		fs.SetOutput(stdout)
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return errHelp
		}
		return fmt.Errorf("%s: %w", fs.Name(), exit.Usage)
	}
	return nil
}

// wantsHelp reports whether args ask for help before flag parsing stops at "--".
func wantsHelp(args []string) bool {
	for _, a := range args {
		if a == "--" {
			return false
		}
		name, _, _ := strings.Cut(a, "=")
		if isHelpFlag(name) {
			return true
		}
	}
	return false
}

// versionInfo is `dillad version --json`: what release.json is generated from (R-UP2) and what the
// installer reads from a binary to decide whether a running SFU can stay.
type versionInfo struct {
	Version           string   `json:"version"`
	Revision          string   `json:"revision"`
	Wire              []uint64 `json:"wire"`
	Schema            int      `json:"schema"`
	MediaLevel        int      `json:"media_level"`
	MinSFUMediaLevel  int      `json:"min_sfu_media_level"`
	MediaCapabilities []string `json:"media_capabilities"`
}

// schemaVersion is the newest goose migration this binary carries, the version a database reaches
// once it has migrated. The file names are "<number>_<name>.sql".
func schemaVersion() (int, error) {
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return 0, err
	}
	newest := 0
	for _, e := range entries {
		num, _, _ := strings.Cut(e.Name(), "_")
		n, err := strconv.Atoi(num)
		if err != nil {
			continue // embed.go is not a migration, but the pattern only embeds *.sql anyway
		}
		newest = max(newest, n)
	}
	if newest == 0 {
		return 0, errors.New("no migrations are embedded")
	}
	return newest, nil
}

func currentVersionInfo(revision string) (versionInfo, error) {
	schema, err := schemaVersion()
	if err != nil {
		return versionInfo{}, fmt.Errorf("version: schema: %w", err)
	}
	return versionInfo{
		Version:           Version,
		Revision:          revision,
		Wire:              []uint64{dillad.WireVersion},
		Schema:            schema,
		MediaLevel:        sfu.MediaLevel,
		MinSFUMediaLevel:  sfu.MinSFUMediaLevel,
		MediaCapabilities: append([]string(nil), sfu.Capabilities...),
	}, nil
}

func runVersion(args []string, stdout, stderr io.Writer) error {
	fs, _ := newFlagSet("version", stderr)
	asJSON := fs.Bool("json", false, "print the version, wire, schema and media level as one JSON object")
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
	if *asJSON {
		info, err := currentVersionInfo(revision)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(info)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintf(stdout, "%s\n", raw)
		return err
	}
	fmt.Fprintf(stdout, "dillad %s (%s %s/%s) revision=%s CGO_ENABLED=%s\n",
		Version, runtime.Version(), runtime.GOOS, runtime.GOARCH, revision, cgo)
	return nil
}
