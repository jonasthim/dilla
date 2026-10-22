package testkit_test

// withdrawn_test.go: UP6b (R-UP12, protocol/02 invariant 6 "Withdrawal") against a real instance
// with real clients: the halves that need an accepted commit, which no DS unit test can reach with
// the committed fixture (internal/ds/withdraw_test.go holds the rest).

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/testkit"
)

// deviceOfUser is the one device the scenario enrolled for username.
func deviceOfUser(t *testing.T, h *testkit.Harness, username string) id.ID {
	t.Helper()
	ctx := context.Background()
	u, err := h.Repo().GetUserByUsername(ctx, username)
	if err != nil {
		t.Fatalf("GetUserByUsername(%s): %v", username, err)
	}
	devices, err := h.Repo().ListDevicesByUser(ctx, u.ID)
	if err != nil || len(devices) == 0 {
		t.Fatalf("ListDevicesByUser(%s): %v, %d devices", username, err, len(devices))
	}
	return devices[0].ID
}

// currentMembers is the call group's current leaves by device.
func currentMembers(t *testing.T, h *testkit.Harness, group id.ID) map[id.ID]store.MemberRow {
	t.Helper()
	members, err := h.Repo().ListMembers(context.Background(), group)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	out := map[id.ID]store.MemberRow{}
	for _, m := range members {
		if m.RemovedEpoch == nil {
			out[m.DeviceID] = m
		}
	}
	return out
}

func handshakeKinds(t *testing.T, h *testkit.Harness, group id.ID) map[uint8]int {
	t.Helper()
	rows, err := h.Repo().ListHandshakes(context.Background(), group, 0, 512)
	if err != nil {
		t.Fatalf("ListHandshakes: %v", err)
	}
	out := map[uint8]int{}
	for _, r := range rows {
		out[r.Kind]++
	}
	return out
}

func expectMembers(t *testing.T, h *testkit.Harness, group id.ID, in []string, out []string) {
	t.Helper()
	current := currentMembers(t, h, group)
	for _, name := range in {
		if _, ok := current[deviceOfUser(t, h, name)]; !ok {
			t.Fatalf("%s holds no leaf of the call group", name)
		}
	}
	for _, name := range out {
		if _, ok := current[deviceOfUser(t, h, name)]; ok {
			t.Fatalf("%s still holds a leaf of the call group", name)
		}
	}
}

func expectNoInstanceProposal(t *testing.T, h *testkit.Harness, group store.GroupRow) {
	t.Helper()
	rows, err := h.Repo().ListProposals(context.Background(), group.GroupID, group.Epoch, true)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	for _, r := range rows {
		if r.Origin == 0 {
			t.Fatalf("an instance proposal is left at the call's epoch: %+v", r)
		}
	}
}

// The testkit's all-drop scenario: three devices all drop at once and all come back. The first one
// back keeps its leaf and commits the others' Removes; the others rejoin externally; no device sits
// in E_REMOVE_PENDING, nothing waits out REJOIN_WAIT_MS, and all three are connected in the same
// call within 90 s; a rotation after all three are back succeeds.
func TestAllDropResume(t *testing.T) {
	begun := time.Now()
	h, _ := runCallScenario(t, "all-drop-resume.scn")
	if took := time.Since(begun); took > 90*time.Second {
		t.Fatalf("all three were back in the same call after %s, want within 90 s", took)
	}
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob", "carol"}, nil)
	expectNoInstanceProposal(t, h, call)
	if n := handshakeKinds(t, h, call.GroupID)[3]; n != 1 {
		t.Fatalf("%d kind-3 rows, want alice's own withdrawal alone", n)
	}
}

// The variant: the second device resumes before the first commit, so it keeps its leaf (409, then a
// rebuild), and only the third rejoins externally.
func TestAllDropSecondResumesBeforeTheFirstCommit(t *testing.T) {
	h, _ := runCallScenario(t, "all_drop_second_resumes_first.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob", "carol"}, nil)
	members := currentMembers(t, h, call.GroupID)
	bob, carol := members[deviceOfUser(t, h, "bob")], members[deviceOfUser(t, h, "carol")]
	if bob.AddedEpoch >= carol.AddedEpoch {
		t.Fatalf("bob's membership is from epoch %d and carol's from %d: bob should have kept his first leaf and carol rejoined", bob.AddedEpoch, carol.AddedEpoch)
	}
	if n := handshakeKinds(t, h, call.GroupID)[3]; n != 2 {
		t.Fatalf("%d kind-3 rows, want alice's and bob's", n)
	}
}

// Correction C3.
func TestCommitApplyingWithdrawnRefRefused(t *testing.T) {
	h, _ := runCallScenario(t, "withdrawn_commit_refused.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob", "carol"}, nil)
	expectNoInstanceProposal(t, h, call)
	// The withdrawn row went with its epoch (the omitting commit ended it).
	if w, err := h.Repo().ListWithdrawnProposals(context.Background(), call.GroupID, call.Epoch-1); err != nil || len(w) != 0 {
		t.Fatalf("withdrawn rows left at the old epoch: %+v, %v", w, err)
	}
}

// Correction C2, before and after the commit: past the TTL the withdrawn row is neither voided nor
// re-driven, every listing (GET /proposals, ready's count, the 409/425 lists) leaves it out, and a
// member commit that omits it lands.
func TestWithdrawnRowExcludedFromListings(t *testing.T) {
	t.Run("before the commit", func(t *testing.T) {
		src, err := os.ReadFile(filepath.Join("..", "..", "testkit", "scenarios", "withdrawn_listings.scn"))
		if err != nil {
			t.Fatal(err)
		}
		var prefix []string
		for _, line := range strings.Split(string(src), "\n") {
			prefix = append(prefix, line)
			if strings.HasPrefix(line, "expect_425 ") {
				break
			}
		}
		path := filepath.Join(t.TempDir(), "withdrawn_listings_before_commit.scn")
		if err := os.WriteFile(path, []byte(strings.Join(prefix, "\n")+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		h := testkit.Start(t, testkit.Options{DataDir: t.TempDir()})
		t.Cleanup(h.Stop)
		if result := h.Run(t, path); result.Err != nil {
			t.Fatalf("%v\n%s\n%s", result.Err, result.Stdout, result.Stderr)
		}
		ctx := context.Background()
		call := theCallGroup(t, h)
		bob, carol := currentMembers(t, h, call.GroupID)[deviceOfUser(t, h, "bob")], currentMembers(t, h, call.GroupID)[deviceOfUser(t, h, "carol")]
		w, err := h.Repo().ListWithdrawnProposals(ctx, call.GroupID, call.Epoch)
		if err != nil || len(w) != 1 || w[0].TargetLeaf == nil || *w[0].TargetLeaf != bob.LeafIndex || w[0].VoidAt != nil {
			t.Fatalf("withdrawn rows %+v, %v: want bob's alone, never voided past the TTL", w, err)
		}
		outstanding, err := h.DS().Outstanding(ctx, call.GroupID)
		if err != nil {
			t.Fatalf("Outstanding: %v", err)
		}
		all, err := h.Repo().ListProposals(ctx, call.GroupID, call.Epoch, true)
		if err != nil {
			t.Fatalf("ListProposals: %v", err)
		}
		for _, rows := range [][]store.ProposalRow{outstanding, all} {
			for _, r := range rows {
				if r.TargetLeaf != nil && *r.TargetLeaf == bob.LeafIndex {
					t.Fatalf("a listing names bob's leaf: %+v (re-driven or listed)", r)
				}
			}
		}
		carolLive := false
		for _, r := range outstanding {
			if r.Origin == 0 && mlswasi.ProposalKind(r.Kind) == mlswasi.ProposalRemove && r.TargetLeaf != nil && *r.TargetLeaf == carol.LeafIndex {
				carolLive = true
			}
		}
		if !carolLive {
			t.Fatal("carol's Remove is not outstanding: the TTL voided it and nothing re-drove it")
		}
		// The freeze itself held for carol's Remove alone: the scenario's expect_425 is the send the
		// instance refused (Frozen reads the online members, and the scenario's clients are gone).
	})
	t.Run("the omitting commit lands", func(t *testing.T) {
		h, _ := runCallScenario(t, "withdrawn_listings.scn")
		call := theCallGroup(t, h)
		expectMembers(t, h, call.GroupID, []string{"alice", "bob"}, []string{"carol"})
	})
}

// Correction C1: voided at TTL and re-driven twice, across the epoch too, the Remove is still
// withdrawable and the resume withdraws it (the scenario's `resume … withdrawn=1`).
func TestWithdrawableSurvivesRedrive(t *testing.T) {
	h, _ := runCallScenario(t, "withdrawable_survives_redrive.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob", "carol"}, nil)
	if n := handshakeKinds(t, h, call.GroupID)[3]; n != 1 {
		t.Fatalf("%d kind-3 rows, want bob's withdrawal", n)
	}
}

// Correction I1: a device that resumes and then leaves for good. After the window, the re-proposal
// re-arms the row (a kind-0 row is appended, and a client queues it again), the Remove is committed,
// and the leaf is gone.
func TestResumeThenLeaveIsRemoved(t *testing.T) {
	h, _ := runCallScenario(t, "resume_then_leave.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice"}, []string{"bob"})
	rows, err := h.Repo().ListHandshakes(context.Background(), call.GroupID, 0, 512)
	if err != nil {
		t.Fatal(err)
	}
	instanceProposals := 0
	for _, r := range rows {
		if r.Kind == 0 && r.SenderLeaf == nil {
			instanceProposals++
		}
	}
	if instanceProposals != 2 {
		t.Fatalf("%d instance proposal rows, want the absence Remove and its re-arm (the late flush inside the window appended none)", instanceProposals)
	}
}

// A commit racing the withdrawal, in both orders.
func TestACommitRacingTheWithdrawal(t *testing.T) {
	h, _ := runCallScenario(t, "withdraw_races.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob", "carol"}, nil)
}

// "Only its own": a member who really left is still removed; the others' resumes never withdraw
// its Remove.
func TestAMemberWhoReallyLeftIsStillRemoved(t *testing.T) {
	h, _ := runCallScenario(t, "really_left_is_removed.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice", "bob"}, []string{"carol"})
	if n := handshakeKinds(t, h, call.GroupID)[3]; n != 2 {
		t.Fatalf("%d kind-3 rows, want alice's and bob's own", n)
	}
}

// Security fix: a kick of a leaf whose absence Remove already stands taints that Remove; the kicked
// device's resume withdraws nothing, and the kick is committed.
func TestAKickAbsorbedByAnAbsenceRemoveIsCommitted(t *testing.T) {
	h, _ := runCallScenario(t, "kick_absorbed_by_absence.scn")
	call := theCallGroup(t, h)
	expectMembers(t, h, call.GroupID, []string{"alice"}, []string{"bob"})
	if n := handshakeKinds(t, h, call.GroupID)[3]; n != 0 {
		t.Fatalf("%d kind-3 rows, want none: the kicked device withdrew its kick", n)
	}
}
