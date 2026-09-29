package main

import (
	"fmt"
	"io"

	"github.com/jonasthim/dilla/internal/exit"
)

// reserved returns the handler for a verb this build names but does not ship.
// The name is taken now so `dillad backup` never means something else later.
func reserved(name string) func([]string, io.Writer, io.Writer) error {
	return func(_ []string, _ io.Writer, stderr io.Writer) error {
		fmt.Fprintf(stderr, "dillad: %s: not in this build (dillad-2)\n", name)
		return fmt.Errorf("%s: not in this build (dillad-2): %w", name, exit.NotImplemented)
	}
}
