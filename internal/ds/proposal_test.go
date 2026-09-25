package ds_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
	"golang.org/x/crypto/chacha20"
)

// Task 21 is invariants 5 and 6 of protocol/02: the freeze an outstanding instance proposal puts
// on a group, and the TTL that voids one.
//
// What the committed fixture can and cannot drive, so the holes are visible in the test output
// rather than only in prose:
//
//   - An instance proposal CAN be issued end to end. The fixture's `external_senders` extension
//     carries the testkit's deterministic instance key (testkit/src/fixtures.rs:106-126), so
//     `fixtureExternalSenderKey` below re-derives it and `ProposeAdd`/`ProposeRemove` produce
//     proposals the guest's `queue_proposal` actually accepts — signature, sender resolution and
//     all.
//   - No commit can be ACCEPTED (commit_test.go's two named skips: the fixture ships one
//     GroupInfo, at epoch 6, and invariant 4 wants epoch n+1). The group therefore never advances
//     an epoch in this package, so every assertion that needs a NEW epoch — a re-issue whose ref
//     differs, and invariant 5's nobody-online external commit that re-issues what it omitted —
//     is skipped by name below rather than faked.

// ------------------------------------------------------------------ step 1a

// Every Policy field has a default. A zero time.Duration read as a deadline is
// "already expired", and a zero int read as a cap is "nothing is allowed", so a
// field DefaultPolicy() forgets does not fail loudly — it fails as a freeze that
// never warns, or a group that closes the instant it freezes. reflect walks the
// struct so that adding a field without a default breaks this test rather than
// production.
func TestDefaultPolicyLeavesNoFieldUnset(t *testing.T) {
	p := ds.DefaultPolicy()
	v := reflect.ValueOf(p)
	for i := range v.NumField() {
		if v.Field(i).IsZero() {
			t.Errorf("Policy.%s has no default", v.Type().Field(i).Name)
		}
	}
}

// The two freeze backstops, by value, against gap-21-ds.md §5.3 and §11. They are
// asserted rather than merely defaulted because both numbers are load-bearing
// citations: freeze_warn equals the text proposal TTL and freeze_max equals
// handshake retention, and a later edit that drifts either silently decouples the
// warning from the TTL or the close from retention.
func TestTheFreezeBackstopsAreTwentyFourHoursAndThirtyDays(t *testing.T) {
	p := ds.DefaultPolicy()
	if p.FreezeWarn != 24*time.Hour {
		t.Errorf("FreezeWarn = %v, want 24h (gap-21-ds §5.3)", p.FreezeWarn)
	}
	if p.FreezeMax != 30*24*time.Hour {
		t.Errorf("FreezeMax = %v, want 30d (gap-21-ds §5.3, R26)", p.FreezeMax)
	}
	if p.FreezeWarn != p.ProposalTTLText {
		t.Errorf("FreezeWarn %v != ProposalTTLText %v: gap-21-ds §11 defines the warning AS one text TTL",
			p.FreezeWarn, p.ProposalTTLText)
	}
	if p.FreezeMax != p.HandshakeRetention {
		t.Errorf("FreezeMax %v != HandshakeRetention %v: gap-21-ds §5.3 defines the close AS the retention horizon",
			p.FreezeMax, p.HandshakeRetention)
	}
	// Invariant 6's two TTLs, by value. `TestDefaultPolicyLeavesNoFieldUnset` only asks that they
	// are non-zero, and no test in the tree pins the call group's 30 s: the sweep tests write a
	// TTL into the proposal row themselves, so a drift of ProposalTTLCall to any non-zero value
	// would pass everything else.
	if p.ProposalTTLText != 24*time.Hour {
		t.Errorf("ProposalTTLText = %v, want 24h (protocol/02 invariant 6)", p.ProposalTTLText)
	}
	if p.ProposalTTLCall != 30*time.Second {
		t.Errorf("ProposalTTLCall = %v, want 30s (protocol/02 invariant 6)", p.ProposalTTLCall)
	}
}

// …and the map from a group's kind to its TTL, which is the half the sweep tests cannot reach: no
// committed fixture registers a CALL group, so `d.proposalTTL(row.Kind)` is only ever called with
// kind 0 through a public entry point. A swapped pair — 30 s on text, 24 h on calls — would void
// every text proposal half a minute after it was issued, and nothing else here would notice.
func TestTheProposalTTLIsTwentyFourHoursForTextAndThirtySecondsForCalls(t *testing.T) {
	h := newDSHarness(t)
	if got := ds.ProposalTTLForTest(h.ds, 0); got != 24*time.Hour {
		t.Errorf("proposalTTL(0 text) = %v, want 24h", got)
	}
	if got := ds.ProposalTTLForTest(h.ds, 1); got != 30*time.Second {
		t.Errorf("proposalTTL(1 call) = %v, want 30s", got)
	}
}

// ------------------------------------------------------------- invariant 5

// Invariant 5 as R10 amends it: the freeze holds while a non-void instance proposal is outstanding
// AND some member device is online. With nobody online the freeze lifts, so an external commit is
// accepted — otherwise a group whose members are all away stays frozen until invariant 11's
// close-and-recreate, which is the only other exit.
func TestTheFreezeHoldsWhileSomebodyIsOnlineAndLiftsWhenNobodyIs(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, session := h.mustRegister(t)
	ref := h.putDSProposal(t, reg.GroupID, 6, false)

	// Nobody has a gateway connection yet.
	frozen, refs, err := ds.FreezeStateForTest(h.ds, ctx, reg.GroupID, 6)
	if err != nil {
		t.Fatalf("freezeState: %v", err)
	}
	if frozen {
		t.Error("with nobody online the freeze must lift: R10's amendment to invariant 5")
	}
	if len(refs) != 1 || !bytes.Equal(refs[0], ref) {
		t.Errorf("refs = %x, want the one outstanding ref %x even while the freeze is lifted", refs, ref)
	}

	// The member at leaf 0 opens a real gateway connection and reaches ready.
	h.online(t, session)
	frozen, refs, err = ds.FreezeStateForTest(h.ds, ctx, reg.GroupID, 6)
	if err != nil {
		t.Fatalf("freezeState: %v", err)
	}
	if !frozen {
		t.Fatal("a non-void instance proposal with a member online freezes the group")
	}
	if len(refs) != 1 {
		t.Errorf("the freeze must name the refs a committer has to reference, got %d", len(refs))
	}

	// Frozen is the predicate the API reads, and it takes the group's own epoch.
	got, err := h.ds.Frozen(ctx, reg.GroupID)
	if err != nil {
		t.Fatalf("Frozen: %v", err)
	}
	if !got {
		t.Error("Frozen disagrees with freezeState at the group's current epoch")
	}
}

// The message path does NOT consult the online predicate. protocol/02 invariant 5 exempts the
// EXTERNAL COMMIT when nobody is online, not the application message: a device holding an HTTP
// session but no gateway connection would otherwise upload ciphertext straight through a live
// freeze.
func TestAMessageDuringAFreezeIsCommitRequiredWhoeverIsOnline(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	ref := h.putDSProposal(t, reg.GroupID, 6, false)

	err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_REQUIRED" {
		t.Fatalf("a message during a freeze: got %v, want E_COMMIT_REQUIRED", err)
	}
	if dsErr.Status != 425 {
		t.Errorf("status = %d, want 425", dsErr.Status)
	}
	if len(dsErr.Proposals) != 1 || !bytes.Equal(dsErr.Proposals[0], ref) {
		t.Errorf("the refusal must carry the outstanding proposals, got %x", dsErr.Proposals)
	}
	if dsErr.RetryAfterMS == nil || *dsErr.RetryAfterMS != uint64(ds.DefaultPolicy().CommitDeadline.Milliseconds()) {
		t.Errorf("retry_after_ms = %v, want the commit deadline in milliseconds", dsErr.RetryAfterMS)
	}

	// A void proposal holds nothing back.
	if err := h.ds.Void(ctx, reg.GroupID, ref); err != nil {
		t.Fatalf("Void: %v", err)
	}
	if err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6); err != nil {
		t.Fatalf("a void proposal must not refuse a message: %v", err)
	}
}

// ------------------------------------------------------------- invariant 6

// Invariant 6: a proposal past its TTL is void, and the freeze it held lifts — with nobody online
// too (R10). The TTLs are 24 h in text groups and 30 s in call groups, driven by clock.Fake and
// never by a real timer: the sweep evaluates them lazily, at the decision point.
func TestAProposalPastItsTTLIsVoidAndTheFreezeLifts(t *testing.T) {
	for _, c := range []struct {
		name string
		ttl  time.Duration
	}{
		{"text group", 24 * time.Hour},
		{"call group", 30 * time.Second},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newDSHarness(t)
			ctx := context.Background()
			reg, session := h.mustRegister(t)
			h.online(t, session)
			ref := h.putDSProposalWithTTL(t, reg.GroupID, 6, uint64(c.ttl.Seconds()))

			if frozen, _ := h.ds.Frozen(ctx, reg.GroupID); !frozen {
				t.Fatal("a fresh proposal freezes the group")
			}

			// One second short of the TTL nothing is void, and the message path still refuses.
			// `Frozen` is not the assertion here: advancing the clock past session_idle_close
			// (90 s) takes the connection offline, and R10's freeze is lifted by that on purpose.
			// The message path never consults the online predicate, so it is the one that still
			// answers for a proposal inside its TTL.
			h.clk.Advance(c.ttl - time.Second)
			if n, err := ds.SweepProposalsForTest(h.ds, ctx); err != nil || n != 0 {
				t.Fatalf("sweep inside the TTL voided %d proposals (err %v), want 0", n, err)
			}
			if err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6); err == nil {
				t.Fatal("a proposal inside its TTL still holds the message path")
			}

			h.clk.Advance(2 * time.Second)
			n, err := ds.SweepProposalsForTest(h.ds, ctx)
			if err != nil {
				t.Fatalf("sweep: %v", err)
			}
			if n != 1 {
				t.Fatalf("the sweep voided %d proposals, want 1", n)
			}
			if frozen, _ := h.ds.Frozen(ctx, reg.GroupID); frozen {
				t.Fatal("a proposal past its TTL is void and must not hold the freeze")
			}
			rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, true)
			if err != nil {
				t.Fatalf("ListProposals: %v", err)
			}
			if len(rows) != 1 || rows[0].VoidAt == nil || !bytes.Equal(rows[0].Ref, ref) {
				t.Fatalf("the swept row is not flagged void: %+v", rows)
			}
			// And a commit may now omit it: invariant 4's clause 1 skips void rows.
			if err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6); err != nil {
				t.Errorf("a void proposal still refuses the message path: %v", err)
			}
		})
	}
}

// R10 / invariant 6: when every proposal has voided the freeze lifts even with nobody online, so
// the group is not frozen forever because its members happen to be away.
func TestTheFreezeLiftsWhenEveryProposalHasVoidedWithNobodyOnline(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	h.putDSProposalWithTTL(t, reg.GroupID, 6, uint64((24 * time.Hour).Seconds()))

	h.clk.Advance(25 * time.Hour)
	if _, err := ds.SweepProposalsForTest(h.ds, ctx); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if frozen, _ := h.ds.Frozen(ctx, reg.GroupID); frozen {
		t.Fatal("with every proposal void the freeze is lifted, online or not")
	}
	if err := ds.RequireNoFreezeForTest(h.ds, ctx, reg.GroupID, 6); err != nil {
		t.Errorf("the message path still refuses after every proposal voided: %v", err)
	}
}

// The sweep PAGES to completion. A fixed first page from the zero id would leave every group past
// the page unswept, and nothing else voids a proposal: the group's freeze would then be permanent.
func TestTheSweepPagesPastItsFirstPageOfGroups(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	h.putDSProposalWithTTL(t, reg.GroupID, 6, 30)

	// 600 more open groups, past the 512-group page, each holding one expired proposal.
	for i := 0; i < 600; i++ {
		gid := h.bareGroup(t)
		h.putDSProposalWithTTL(t, gid, 0, 30)
	}
	h.clk.Advance(time.Minute)
	n, err := ds.SweepProposalsForTest(h.ds, ctx)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if n != 601 {
		t.Fatalf("the sweep voided %d proposals, want 601: it stopped at its first page", n)
	}
	_ = reg
}

// ------------------------------------------------- issuing an instance proposal

// ProposeRemove signs an external Remove as the instance, queues it in the guest, writes the SQL
// row, appends the handshake and fans the proposal out — and the group is frozen from that moment.
func TestProposeRemoveIssuesAnExternalRemoveThatFreezesTheGroup(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, session := h.mustRegister(t)
	h.online(t, session)

	action := id.New()
	if err := h.ds.ProposeRemove(ctx, reg.GroupID, 1, action); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}

	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("%d proposal rows, want 1", len(rows))
	}
	row := rows[0]
	if row.Origin != 0 {
		t.Errorf("origin = %d, want 0 (the instance)", row.Origin)
	}
	if row.Kind != 3 {
		t.Errorf("kind = %d, want 3 (Remove)", row.Kind)
	}
	if row.TargetLeaf == nil || *row.TargetLeaf != 1 {
		t.Errorf("target_leaf = %v, want 1", row.TargetLeaf)
	}
	if row.ActionID != action {
		t.Errorf("action_id = %s, want %s", row.ActionID, action)
	}
	if row.TTL != uint64((24 * time.Hour).Seconds()) {
		t.Errorf("ttl = %d, want the text group's 24 h", row.TTL)
	}

	// The blob is in the guest's queue, so `Proposals` can hand it back to a committer.
	list, err := h.ds.Proposals(ctx, reg.GroupID, session)
	if err != nil {
		t.Fatalf("Proposals: %v", err)
	}
	if len(list) != 1 || len(list[0].Blob) == 0 {
		t.Fatalf("the guest queued no blob for the issued proposal: %+v", list)
	}

	// The handshake log carries it, with no sender leaf: the instance has none.
	hs, err := h.repo.ListHandshakes(ctx, reg.GroupID, 0, 16)
	if err != nil {
		t.Fatalf("ListHandshakes: %v", err)
	}
	if len(hs) != 1 || hs[0].Kind != 0 || hs[0].SenderLeaf != nil || hs[0].SenderDevice != nil {
		t.Fatalf("the handshake log does not carry the instance proposal: %+v", hs)
	}

	if frozen, _ := h.ds.Frozen(ctx, reg.GroupID); !frozen {
		t.Error("issuing an instance proposal freezes the group while a member is online")
	}
}

// R12's "SQL is the record", on the instance path. `ProposalPut` necessarily runs BEFORE the
// transaction — the SQL row is keyed on the ref the guest's queue hands back — so every failure
// after the put has to take the proposal out of the queue again. Without that guard a refused
// ProposeRemove leaves the cached PublicGroup one proposal ahead of SQL; worse, the NEXT
// successful proposal writes that divergence into the durable state blob through `persistState`
// inside its own transaction, so it survives a restart and is cleared only by the next merge.
//
// Task 20's `queueMemberProposal` guards its own put exactly this way
// (TestARefusedMemberProposalIsTakenBackOutOfTheGuestsQueue); this is the same guard on the
// instance path, and the same fault injector proves it.
func TestARefusedInstanceProposalIsTakenBackOutOfTheGuestsQueue(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	queued := func(t *testing.T) int {
		t.Helper()
		n := 0
		if err := ds.WithGroupForTest(h.ds, ctx, reg.GroupID, func(g *mlswasi.PublicGroup) error {
			list, err := g.ProposalList(ctx)
			if err != nil {
				return err
			}
			n = len(list)
			return nil
		}); err != nil {
			t.Fatalf("withGroup: %v", err)
		}
		return n
	}

	h.failNextTx("AppendHandshake")
	if err := h.ds.ProposeRemove(ctx, reg.GroupID, 1, id.New()); err == nil {
		t.Fatal("ProposeRemove must fail when the handshake append inside its transaction does")
	}
	if rows, _ := h.repo.ListProposals(ctx, reg.GroupID, 6, true); len(rows) != 0 {
		t.Fatalf("%d proposal rows after a failed transaction, want 0", len(rows))
	}
	if got := queued(t); got != 0 {
		t.Fatalf("the guest holds %d queued proposals SQL does not have, want 0", got)
	}

	// And the successful one after it leaves exactly one proposal on BOTH sides — the assertion
	// that catches the divergence being written into the state blob rather than merely held.
	if err := h.ds.ProposeRemove(ctx, reg.GroupID, 1, id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, true)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("%d proposal rows, want 1", len(rows))
	}
	if got := queued(t); got != 1 {
		t.Fatalf("the guest holds %d queued proposals for 1 SQL row", got)
	}
}

// Invariant 6's second half: a Remove of a leaf that is already gone is DROPPED, not proposed.
func TestProposeRemoveOfALeafThatIsAlreadyGoneIsDropped(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	if err := h.ds.ProposeRemove(ctx, reg.GroupID, 99_999, id.New()); err == nil {
		t.Error("a Remove of a leaf that is not a member must be dropped, not proposed")
	}
	if rows, _ := h.repo.ListProposals(ctx, reg.GroupID, 6, true); len(rows) != 0 {
		t.Errorf("%d proposals were stored for a target that is gone, want 0", len(rows))
	}
}

// Invariant 6's "before proposing" gate: an expired KeyPackage never becomes a proposal.
func TestAnExpiredKeyPackageIsRefusedBeforeProposing(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	joiner := h.deviceWithKeyPackage(t)

	h.clk.Advance(100 * 24 * time.Hour) // past the fixture KeyPackage's lifetime
	if err := h.ds.ProposeAdd(ctx, reg.GroupID, joiner, id.New()); err == nil {
		t.Fatal("ProposeAdd accepted an expired KeyPackage")
	}
	if rows, _ := h.repo.ListProposals(ctx, reg.GroupID, 6, true); len(rows) != 0 {
		t.Fatalf("%d proposals were stored for an expired KeyPackage, want 0", len(rows))
	}
}

// A device with no KeyPackage at all is refused the same way, and nothing is written.
func TestProposeAddWithoutAKeyPackageIsRefused(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	err := h.ds.ProposeAdd(ctx, reg.GroupID, id.New(), id.New())
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_INVALID_REQUEST" {
		t.Fatalf("got %v, want E_INVALID_REQUEST", err)
	}
	if rows, _ := h.repo.ListProposals(ctx, reg.GroupID, 6, true); len(rows) != 0 {
		t.Fatalf("%d proposals were stored, want 0", len(rows))
	}
}

// ProposeAdd issues a real external Add and consumes the device's KeyPackage, so the same
// KeyPackage cannot be proposed twice.
func TestProposeAddIssuesAnExternalAddAndConsumesTheKeyPackage(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)
	joiner := h.deviceWithKeyPackage(t)

	action := id.New()
	if err := h.ds.ProposeAdd(ctx, reg.GroupID, joiner, action); err != nil {
		t.Fatalf("ProposeAdd: %v", err)
	}
	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("%d proposal rows, want 1", len(rows))
	}
	if rows[0].Kind != 1 {
		t.Errorf("kind = %d, want 1 (Add)", rows[0].Kind)
	}
	if rows[0].TargetDevice == nil || *rows[0].TargetDevice != joiner {
		t.Errorf("target_device = %v, want %s", rows[0].TargetDevice, joiner)
	}
	if rows[0].ActionID != action {
		t.Errorf("action_id = %s, want %s", rows[0].ActionID, action)
	}
	if len(rows[0].KeyPackage) == 0 {
		t.Error("the row must keep the KeyPackage the proposal was built from, for the re-issue")
	}

	// The KeyPackage is consumed: a second Add for the same device has nothing to use.
	if err := h.ds.ProposeAdd(ctx, reg.GroupID, joiner, id.New()); err == nil {
		t.Error("the KeyPackage was not consumed: a second ProposeAdd reused it")
	}
}

// ProposeAddBatch caps one commit's Adds at MaxAddsPerCommit, and it reads the outstanding count
// at the GROUP'S CURRENT EPOCH. Reading it at literal epoch 0 would see nothing past epoch 0, so
// `room` would always be the full 256 and successive batches would push straight past the cap —
// the one thing the batching exists to prevent.
func TestProposeAddBatchNeverExceedsTwoHundredAndFiftySixAddsPerCommit(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	// 256 Adds are already outstanding at the group's epoch.
	for i := 0; i < ds.DefaultPolicy().MaxAddsPerCommit; i++ {
		h.putDSAddProposal(t, reg.GroupID, 6)
	}
	devices := make([]id.ID, 8)
	for i := range devices {
		devices[i] = h.deviceWithKeyPackage(t)
	}
	if err := h.ds.ProposeAddBatch(ctx, reg.GroupID, devices); err != nil {
		t.Fatalf("ProposeAddBatch: %v", err)
	}
	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) > ds.DefaultPolicy().MaxAddsPerCommit {
		t.Fatalf("%d Adds outstanding for one commit, want at most %d",
			len(rows), ds.DefaultPolicy().MaxAddsPerCommit)
	}
	// The remainder is not dropped: it waits for the next epoch.
	if got := ds.PendingJoinsForTest(h.ds, reg.GroupID); got != len(devices) {
		t.Errorf("%d devices queued for the next commit, want %d — a dropped tail stalls a join storm",
			got, len(devices))
	}
}

// A batch that fits issues real Adds, and one unusable KeyPackage does not sink the rest.
func TestProposeAddBatchSkipsAnUnusableKeyPackageAndKeepsGoing(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	good := h.deviceWithKeyPackage(t)
	bad := id.New() // no KeyPackage at all
	if err := h.ds.ProposeAddBatch(ctx, reg.GroupID, []id.ID{bad, good}); err != nil {
		t.Fatalf("ProposeAddBatch: %v", err)
	}
	rows, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(rows) != 1 || rows[0].TargetDevice == nil || *rows[0].TargetDevice != good {
		t.Fatalf("the batch did not continue past the unusable device: %+v", rows)
	}
}

// ------------------------------------------------------------- the re-issue

// The logical action survives, and it is DROPPED when the target leaf is already gone: invariant
// 6's "retried with a fresh KeyPackage, or dropped if the target leaf is already gone".
func TestAReissuedActionKeepsItsActionIdAndIsDroppedWhenTheTargetIsGone(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, _ := h.mustRegister(t)

	action := id.New()
	if err := h.ds.ProposeRemove(ctx, reg.GroupID, 1, action); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	before, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil || len(before) != 1 {
		t.Fatalf("ListProposals: %+v %v", before, err)
	}

	// A re-issue at the same epoch supersedes the row rather than adding a second one, and the
	// logical action is carried across.
	if err := h.ds.ReissueFor(ctx, reg.GroupID, action); err != nil {
		t.Fatalf("ReissueFor: %v", err)
	}
	after, err := h.repo.ListProposals(ctx, reg.GroupID, 6, false)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(after) != 1 {
		t.Fatalf("%d proposals after the re-issue, want 1: the superseded row must be retired, "+
			"or invariant 4's clause 1 demands a ref no commit can reference", len(after))
	}
	if after[0].ActionID != action {
		t.Errorf("action_id = %s after the re-issue, want %s — the logical action survives",
			after[0].ActionID, action)
	}

	// The target leaves the group. The action is now satisfied, not retried.
	h.dropMember(t, reg.GroupID, 1)
	if err := h.ds.ReissueFor(ctx, reg.GroupID, action); err != nil {
		t.Fatalf("ReissueFor after the target left: %v", err)
	}
	gone, err := h.repo.ListProposals(ctx, reg.GroupID, 6, true)
	if err != nil {
		t.Fatalf("ListProposals: %v", err)
	}
	if len(gone) != 0 {
		t.Fatalf("%d proposals survive a target that is already gone, want 0", len(gone))
	}
}

// ReissueFor names an action nobody issued.
func TestReissueForAnUnknownActionIsNotFound(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	err := h.ds.ReissueFor(context.Background(), reg.GroupID, id.New())
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("got %v, want E_NOT_FOUND", err)
	}
}

// ------------------------------------------------------ the gaps, named in code

// Invariant 5's nobody-online exception ends in a re-issue FOR THE NEW EPOCH, and the assertion
// that distinguishes it from doing nothing is that the re-issued ref differs. A ProposalRef is
// taken over the proposal's framed content, which carries the group context's epoch, so two
// epochs are needed and this package can reach only one.
func TestWithNobodyOnlineAnExternalCommitIsAcceptedAndTheProposalsAreReissued(t *testing.T) {
	t.Skip("needs an ACCEPTED external commit, so a second epoch: testkit/fixtures/ds-1500 ships " +
		"one GroupInfo (group_info.mls, epoch 6) and invariant 4 wants epoch n+1, so no commit in " +
		"this repository merges (commit_test.go records the same blocker). The external path is " +
		"task 25's besides: checkAppliedProposals refuses every external commit today. Exporting " +
		"a merged group_info beside commits/09.mls is the one fixture change that unblocks it")
}

// ---------------------------------------------------------------- the helpers

// fixtureExternalSenderKey re-derives the instance signing key the committed fixture put in the
// group's `external_senders` extension. Without it no proposal this package builds would be
// ACCEPTED by the guest: `queue_proposal` resolves an external proposal's sender through that
// extension and verifies the signature (core/dilla-core/src/public_group/state.rs:260-285), so a
// key of the test's own invention would refuse every ProposeAdd and ProposeRemove and leave the
// whole issuing path untested.
//
// The derivation is testkit/src/client.rs:57-80 in Go: the seed's big-endian bytes and
// seed*0x9e3779b9's fill the first sixteen of a 32-byte ChaCha20 seed, the rest is zero, and the
// first 32 bytes of that stream are the Ed25519 secret. testkit/src/fixtures.rs:116 makes the
// instance's seed `spec.seed ^ 0x0d15_0d15`, and the fixture was generated with the CLI's default
// seed 0x5eed (testkit/src/bin/dilla-testkit.rs:33).
//
// It is not a hardcoded constant on purpose: a regenerated fixture with a different seed must
// change ONE number here, and the tests that use the key fail loudly rather than silently
// skipping the accept path.
func fixtureExternalSenderKey() [32]byte {
	const seed = uint64(0x5eed) ^ 0x0d15_0d15
	var material [32]byte
	binary.BigEndian.PutUint64(material[0:8], seed)
	binary.BigEndian.PutUint64(material[8:16], seed*0x9e37_79b9)
	var nonce [12]byte
	c, err := chacha20.NewUnauthenticatedCipher(material[:], nonce[:])
	if err != nil {
		panic(err)
	}
	var out [32]byte
	c.XORKeyStream(out[:], out[:])
	return out
}

// putDSProposalWithTTL is putDSProposal with the TTL the caller's group kind implies, which is
// what the sweep reads.
func (h *dsHarness) putDSProposalWithTTL(t *testing.T, groupID id.ID, epoch, ttl uint64) []byte {
	t.Helper()
	ref := id.New()
	row := store.ProposalRow{
		GroupID: groupID, Ref: ref[:], Epoch: epoch, Kind: 3, Origin: 0,
		ActionID: id.New(), IssuedAt: h.clk.Now().Unix(), TTL: ttl,
	}
	if err := h.repo.PutProposal(context.Background(), row); err != nil {
		t.Fatalf("PutProposal: %v", err)
	}
	return row.Ref
}

// putDSAddProposal is one instance-originated Add row, which is what ProposeAddBatch counts.
func (h *dsHarness) putDSAddProposal(t *testing.T, groupID id.ID, epoch uint64) []byte {
	t.Helper()
	ref := id.New()
	row := store.ProposalRow{
		GroupID: groupID, Ref: ref[:], Epoch: epoch, Kind: 1, Origin: 0,
		ActionID: id.New(), IssuedAt: h.clk.Now().Unix(), TTL: 86400,
	}
	if err := h.repo.PutProposal(context.Background(), row); err != nil {
		t.Fatalf("PutProposal: %v", err)
	}
	return row.Ref
}

// bareGroup is one more open group row, with no MLS state: the sweep reads `mls_pending_proposals`
// and never touches the guest, so a row is all a paging test needs.
func (h *dsHarness) bareGroup(t *testing.T) id.ID {
	t.Helper()
	gid := id.New()
	if err := h.repo.CreateGroup(context.Background(), store.GroupRow{
		GroupID: gid, Binding: []byte{0xf6}, Kind: 0, TargetID: id.New(),
		Ciphersuite: 1, Epoch: 0, Created: h.clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	return gid
}

// deviceWithKeyPackage registers one user and one device with the instance and stores the
// fixture's committed KeyPackage for it. `key_packages.device_id` references `devices(id)`, so the
// two rows are not optional. The blob is real material a real `validate_key_package` accepts; only
// the identities are the test's.
func (h *dsHarness) deviceWithKeyPackage(t *testing.T) id.ID {
	t.Helper()
	ctx := context.Background()
	now := h.clk.Now().Unix()
	user := id.New()
	if err := h.repo.CreateUser(ctx, store.UserRow{
		ID: user, Username: "u" + user.String()[:12], Display: "joiner", Kind: 0,
		UMKPub: bytes.Repeat([]byte{1}, 32), SSKPub: bytes.Repeat([]byte{2}, 32),
		SigUMKSSK: bytes.Repeat([]byte{3}, 64), Created: now,
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	device := id.New()
	if err := h.repo.CreateDevice(ctx, store.DeviceRow{
		ID: device, UserID: user, DSKPub: bytes.Repeat([]byte{4}, 32),
		Tier: 0, SignerTier: 0, CredentialBlob: []byte{0xf6}, LastSeen: now, Created: now,
	}); err != nil {
		t.Fatalf("CreateDevice: %v", err)
	}
	ref := id.New()
	if err := h.repo.PutKeyPackages(ctx, device, []store.KeyPackageRow{{
		DeviceID: device, KPRef: ref[:], Blob: fixtureFile(t, "key_package.mls"), LastResort: 0,
		Expires: h.clk.Now().Add(80 * 24 * time.Hour).Unix(), Created: now,
	}}); err != nil {
		t.Fatalf("PutKeyPackages: %v", err)
	}
	return device
}

// dropMember rewrites the group's leaf table without the given leaf, which is what a commit that
// removed it would leave behind.
func (h *dsHarness) dropMember(t *testing.T, groupID id.ID, leaf uint32) {
	t.Helper()
	ctx := context.Background()
	members, err := h.repo.ListMembers(ctx, groupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	kept := make([]store.MemberRow, 0, len(members))
	for _, m := range members {
		if m.LeafIndex != leaf {
			kept = append(kept, m)
		}
	}
	if err := h.repo.Tx(ctx, func(tx store.Repository) error {
		return tx.ReplaceMembers(ctx, groupID, 6, kept)
	}); err != nil {
		t.Fatalf("ReplaceMembers: %v", err)
	}
}

// online puts the session's device on a REAL gateway connection: hello, identify, ready, over a
// real WebSocket against the real handler. `Gateway.Online` is the single source invariant 5 reads
// and it is defined over a connection in state ready, so a test that faked it would be asserting
// the fake.
func (h *dsHarness) online(t *testing.T, session auth.Session) {
	t.Helper()
	h.auth.add(session)

	srv := httptest.NewServer(h.gw.Handler())
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), &websocket.DialOptions{
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + h.auth.token(session)}},
		Subprotocols: []string{"dilla.v1"},
	})
	if err != nil {
		t.Fatalf("dial the gateway: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })

	if op := readGatewayOp(t, ctx, c); op != gateway.OpHello {
		t.Fatalf("first frame op %d, want hello", op)
	}
	payload, err := cborx.Marshal([]any{"", uint64(1), uint64(1), uint64(1), uint64(0)})
	if err != nil {
		t.Fatalf("encode identify: %v", err)
	}
	frame, err := gateway.Encode(gateway.Frame{Op: gateway.OpIdentify, Payload: cborx.Raw(payload)}, 1)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, frame); err != nil {
		t.Fatalf("write identify: %v", err)
	}
	if op := readGatewayOp(t, ctx, c); op != gateway.OpReady {
		t.Fatalf("op %d, want ready", op)
	}
	if !h.gw.Online(session.DeviceID) {
		t.Fatal("a device that reached ready is not online")
	}
}

// readGatewayOp reads one server frame and returns its opcode. The frame is the four-element
// array [op, n, group_id, payload]; only the opcode matters here.
func readGatewayOp(t *testing.T, ctx context.Context, c *websocket.Conn) gateway.Op {
	t.Helper()
	typ, b, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("message type %v, want binary: dilla's wire is CBOR, never text", typ)
	}
	var frame []cbor.RawMessage
	if err := cborx.Unmarshal(b, &frame); err != nil {
		t.Fatalf("decode the frame: %v", err)
	}
	if len(frame) != 4 {
		t.Fatalf("the frame has %d elements, want 4", len(frame))
	}
	var op uint64
	if err := cborx.Unmarshal(frame[0], &op); err != nil {
		t.Fatalf("decode the opcode: %v", err)
	}
	return gateway.Op(op)
}
