// Command dillad is the dilla server.
//
// The command line is a verb dispatcher with eight names. Five are implemented
// here; backup, restore and admin are reserved, print "not in this build" and
// exit 3, so an operator who reads the roadmap and types one gets an honest
// answer instead of "unknown command".
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/jonasthim/dilla/internal/exit"
)

// Version is bumped by the release process, not by the build.
const Version = "0.0.0-dev"

type verb struct {
	name    string
	summary string
	run     func(args []string, stdout, stderr io.Writer) error
}

func verbs() map[string]verb {
	return map[string]verb{
		"serve":   {"serve", "run the instance", runServe},
		"init":    {"init", "create the data directory, config, database and bootstrap invite", runInit},
		"migrate": {"migrate", "apply or inspect schema migrations", runMigrate},
		"doctor":  {"doctor", "check configuration, database, wasi artifact and clock", runDoctor},
		"version": {"version", "print the version, VCS revision and cgo status", runVersion},
		"backup":  {"backup", "write a backup archive (dillad-2)", reserved("backup")},
		"restore": {"restore", "restore from a backup archive (dillad-2)", reserved("restore")},
		"admin":   {"admin", "administrative commands (dillad-2)", reserved("admin")},
	}
}

func usage(w io.Writer) {
	fmt.Fprintln(w, "usage: dillad <verb> [flags]")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "verbs:")
	all := verbs()
	names := make([]string, 0, len(all))
	for name := range all {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(w, "  %-8s %s\n", name, all[name].summary)
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "every verb accepts --config <path> (default /etc/dilla/dilla.toml)")
}

// dispatch runs one verb. args excludes argv[0]. A nil return is exit 0.
func dispatch(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		usage(stdout)
		return exit.Usage
	}
	switch args[0] {
	case "-h", "--help", "help":
		usage(stdout)
		return nil
	}
	v, ok := verbs()[args[0]]
	if !ok {
		fmt.Fprintf(stderr, "dillad: unknown verb %q\n", args[0])
		usage(stderr)
		return exit.Usage
	}
	return v.run(args[1:], stdout, stderr)
}

func main() {
	err := dispatch(os.Args[1:], os.Stdout, os.Stderr)
	var code exit.Code
	if err != nil && !errors.As(err, &code) {
		err = fmt.Errorf("%w: %w", err, exit.Fail)
	}
	exit.Exit(err)
}
