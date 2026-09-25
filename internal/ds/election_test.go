package ds_test

import (
	"context"
	"testing"
	"time"
)

// Every test in this file issues an instance proposal FIRST. RequestCommit returns immediately on
// a group with no outstanding proposals —
//
//	refs, _ := d.refsOf(...); if len(refs) == 0 { d.clearElection(groupID); return nil }
//
// — so calling it on a proposal-free group sends no mls.commit_needed at all, and
// h.expectDeviceFrames would time out on every one of them. h.proposeRemoveOf issues an instance
// Remove, whose storeInstanceProposal already ends in RequestCommit, so the frame under test is
// the one that call produced. `h.groupWithMembers` issues one seed Remove of its own, of a leaf no
// test names, so that TestTheWatchdogNudgesTheNextCandidate — which calls RequestCommit without
// proposing anything — has something to elect for too; see the helper.
//
// TWO TESTS OF THE BRIEF ARE NOT HERE, and neither is silently dropped:
//
//   - TestTheBackoffWindowIsAdvertisedInHello asserts backoff_ms and backoff_jitter_ms as two new
//     elements of the `hello` payload. `hello` is a SEVEN-element frame in protocol/02 §2.3 (line
//     133), in gateway.HelloPayload, in opSpecs[OpHello], in packages/protocol-vectors/src/
//     frames.ts and in the committed protocol/vectors/frames.json the Rust guest's vectors_check
//     reads — adding two elements is a wire amendment across three languages and a wasm rebuild,
//     with no seam for Policy.Backoff to reach the gateway (gateway.Options has no such field).
//     Task 22's Files are three new files in internal/ds; the amendment is not made here.
//   - TestACommitThatReissuesAnOmittedRemoveDoesNotDeadlock needs an EXTERNAL commit the delivery
//     service accepts. commit.go step (6) refuses every commit whose processed.SenderLeaf is nil
//     ("the committer's leaf is unknown, so the GroupInfo's signer cannot be checked") and
//     freeze.go says of reissueOmitted, in terms: "IT CANNOT FIRE UNTIL TASK 25 (deviation B21,
//     ruling 42)". There is also no external-commit blob in testkit/fixtures/ds-1500 and no MLS
//     client in Go to make one. The deadlock it guards is nonetheless real, and the lock-free
//     `proposeRemoveLocked` it depends on is already in place and commented for it.
//
// Both are reported to the reviewer as carried work, with the exact shape each needs.

// Invariant 7: mls.commit_needed goes to the lowest-index online device, bot devices first.
func TestCommitNeededGoesToTheLowestIndexOnlineDeviceBotsFirst(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 3)
	h.online(g.members[0], g.members[1], g.members[2])
	h.setLeaves(g, map[int]uint32{0: 5, 1: 2, 2: 9})
	h.proposeRemoveOf(t, g, 9) // an outstanding instance proposal, and the election it triggers

	h.expectDeviceFrames(t, g.members[1], "mls.commit_needed") // leaf 2 is the lowest
	h.expectNoFrames(t, g.members[0], g.members[2])

	h.markBot(g.members[2])
	if err := h.ds.RequestCommit(context.Background(), g.id); err != nil {
		t.Fatalf("RequestCommit: %v", err)
	}
	h.expectDeviceFrames(t, g.members[2], "mls.commit_needed") // bots first, whatever the leaf
}

// deadline_ms is re-based at the writer, not at election time: a frame that waited 400 ms in the
// queue arrives with 400 ms less on its clock.
// The re-base happens when the frame is DEQUEUED, before sink.write, so an idle writer dequeues
// in the same instant the frame is enqueued and `waited` is 0. To make the frame actually wait in
// the queue, a first frame must already be blocking the writer INSIDE sink.write: only then does
// the commit_needed frame sit in the queue while the clock advances. This is the one place D11's
// queue-wait semantics are exercised, so the ordering is spelled out rather than implied.
func TestTheDeadlineIsRebasedAtTheWriter(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 1)
	h.online(g.members[0])

	// (1) a frame that blocks the writer inside write.
	h.stallWriter(g.members[0])
	h.sendFiller(t, g.members[0])
	h.waitWriterBlocked(t, g.members[0])

	// (2) the commit_needed frame, which now queues behind it.
	h.proposeRemoveOf(t, g, 1)

	// (3) the clock advances while it waits, and only then is the writer released.
	h.clk.Advance(400 * time.Millisecond)
	h.releaseWriter(g.members[0])

	h.waitDeviceFrame(t, g.members[0], "filler")
	frame := h.waitDeviceFrame(t, g.members[0], "mls.commit_needed")
	deadline := h.deadlineMSOf(t, frame)
	full := uint64(h.policy().CommitDeadline / time.Millisecond)
	if deadline >= full {
		t.Fatalf("deadline_ms = %d, want less than %d — it is re-based when the frame reaches the writer",
			deadline, full)
	}
}

// An UNacknowledged round does not count against a device; three acknowledged-and-lost rounds do.
// The rounds are read back from the delivery service, never counted by the test: every
// RequestCommit — including the ones RunWatchdogOnce triggers — increments the round, so by the
// second loop the live round is well past 3 and acking 1, 2, 3 acks nothing at all.
func TestOnlyAcknowledgedRoundsCountAgainstADevice(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 1)
	h.online(g.members[0])
	h.proposeRemoveOf(t, g, 1) // something to commit, and the first round

	for range 5 {
		h.clk.Advance(h.policy().WatchdogInterval + time.Second)
		h.ds.RunWatchdogOnce(context.Background())
	}
	if h.removedLeaves(t, g) != 0 {
		t.Fatal("unacknowledged rounds must only advance the election, never remove a device")
	}

	for range 3 {
		round := h.ds.CurrentRound(g.id)
		if round == 0 {
			t.Fatal("no election is armed; RequestCommit found no outstanding proposal")
		}
		if err := h.ds.AckCommitNeeded(context.Background(), g.id, g.members[0], round); err != nil {
			t.Fatalf("AckCommitNeeded: %v", err)
		}
		h.clk.Advance(h.policy().WatchdogInterval + time.Second)
		h.ds.RunWatchdogOnce(context.Background())
	}
	if h.removedLeaves(t, g) != 1 {
		t.Fatal("three acknowledged-and-lost rounds must remove the device by an instance Remove")
	}
}

// The watchdog nudges the next candidate after 2 s; the others back off 300 ms + rand(0..300 ms).
func TestTheWatchdogNudgesTheNextCandidate(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.online(g.members[0], g.members[1])
	h.setLeaves(g, map[int]uint32{0: 1, 1: 2})

	if err := h.ds.RequestCommit(context.Background(), g.id); err != nil {
		t.Fatalf("RequestCommit: %v", err)
	}
	h.expectDeviceFrames(t, g.members[0], "mls.commit_needed")
	h.clk.Advance(h.policy().WatchdogInterval + time.Second)
	h.ds.RunWatchdogOnce(context.Background())
	h.expectDeviceFrames(t, g.members[1], "mls.commit_needed")
}

// A group with nobody online arms no timer and re-elects on the next ready.
func TestAGroupWithNobodyOnlineArmsNoTimer(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 1)
	h.offline(g.members[0])
	h.proposeRemoveOf(t, g, 1) // an outstanding proposal, so the election has something to elect for

	if h.armedElections() != 0 {
		t.Fatal("an election with no candidate must arm no timer")
	}
	h.online(g.members[0])
	if err := h.ds.RequestCommit(context.Background(), g.id); err != nil {
		t.Fatalf("RequestCommit: %v", err)
	}
	h.expectDeviceFrames(t, g.members[0], "mls.commit_needed")
}
