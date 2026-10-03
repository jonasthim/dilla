package testkit_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/jonasthim/dilla/internal/testkit"
)

// dilla-media task 9: DEV-45's duplicate-Remove race in both orders (SP-22 b) and F9's re-drive of
// a voided call Remove, against a real instance with real clients — the commit-path halves no DS
// unit test can reach with the committed fixture.
func TestTheCallRemoveScenariosRunGreen(t *testing.T) {
	for _, name := range []string{"call_remove_dedupe.scn", "call_remove_redrive.scn"} {
		path := filepath.Join("..", "..", "testkit", "scenarios", name)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("scenario %s is missing: %v", name, err)
		}
		t.Run(name, func(t *testing.T) {
			h := testkit.Start(t, testkit.Options{DataDir: t.TempDir()})
			t.Cleanup(h.Stop)
			result := h.Run(t, path)
			if result.Err != nil {
				t.Fatalf("%s failed: %v\nstdout:\n%s\nstderr:\n%s", result.Name, result.Err, result.Stdout, result.Stderr)
			}
			if result.Steps == 0 {
				t.Fatal("the scenario ran no steps")
			}
			t.Logf("%s", result.Stdout)
		})
	}
}
