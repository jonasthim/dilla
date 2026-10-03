package testkit_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/testkit"
)

// dilla-media task 9 and its security fix: DEV-45's two Removes of one call leaf in both orders
// (SP-22 b) — a member's own Remove never cancels, blocks or stands in for the instance's — and F9's
// re-drive of a voided call Remove, against a real instance with real clients: the commit-path
// halves no DS unit test can reach with the committed fixture.
func TestTheCallRemoveScenariosRunGreen(t *testing.T) {
	for _, name := range []string{"call_remove_dedupe.scn", "call_remove_redrive.scn", "call_remove_refused_leave.scn"} {
		t.Run(name, func(t *testing.T) {
			h, result := runCallScenario(t, name)
			if result.Steps == 0 {
				t.Fatal("the scenario ran no steps")
			}
			if name == "call_remove_refused_leave.scn" {
				assertTheKickStillStands(t, h)
			}
		})
	}
}

func runCallScenario(t *testing.T, name string) (*testkit.Harness, testkit.ScenarioResult) {
	t.Helper()
	path := filepath.Join("..", "..", "testkit", "scenarios", name)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("scenario %s is missing: %v", name, err)
	}
	h := testkit.Start(t, testkit.Options{DataDir: t.TempDir()})
	t.Cleanup(h.Stop)
	result := h.Run(t, path)
	if result.Err != nil {
		t.Fatalf("%s failed: %v\nstdout:\n%s\nstderr:\n%s", result.Name, result.Err, result.Stdout, result.Stderr)
	}
	t.Logf("%s", result.Stdout)
	return h, result
}

// assertTheKickStillStands is D(i) of the security fix, read from the instance after
// call_remove_refused_leave.scn: carol's own Remove was refused — no member proposal reached the
// handshake log or the proposal table — the instance's Remove of her leaf is still the one
// non-void proposal, and the election it started still stands.
func assertTheKickStillStands(t *testing.T, h *testkit.Harness) {
	t.Helper()
	ctx := context.Background()
	repo := h.Repo()
	groups, err := repo.ListOpenGroups(ctx, id.ID{}, 64)
	if err != nil {
		t.Fatalf("ListOpenGroups: %v", err)
	}
	var call *store.GroupRow
	for i := range groups {
		if groups[i].Kind == 1 {
			call = &groups[i]
		}
	}
	if call == nil {
		t.Fatal("no call group on the instance")
	}
	rows, err := repo.ListProposals(ctx, call.GroupID, call.Epoch, true)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("%d proposals at the call's epoch, want only the instance's Remove: %+v", len(rows), rows)
	}
	r := rows[0]
	if r.Origin != 0 || mlswasi.ProposalKind(r.Kind) != mlswasi.ProposalRemove || r.VoidAt != nil || r.TargetDevice == nil {
		t.Fatalf("the proposal %+v, want the instance's non-void Remove of carol's device", r)
	}
	handshakes, err := repo.ListHandshakes(ctx, call.GroupID, 0, 512)
	if err != nil {
		t.Fatalf("ListHandshakes: %v", err)
	}
	for _, hs := range handshakes {
		if hs.Epoch == call.Epoch && hs.Kind == 0 && hs.SenderLeaf != nil {
			t.Fatalf("a member proposal reached the log at seq %d: carol's own Remove was accepted", hs.Seq)
		}
	}
	if n := h.DS().OpenElections(); n != 1 {
		t.Fatalf("%d open elections, want the one the kick started", n)
	}
}
