package ds

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// Handshake kinds, as protocol/02's "Handshake records" fixes them.
const (
	handshakeProposal       uint8 = 0
	handshakeCommit         uint8 = 1
	handshakeExternalCommit uint8 = 2
)

// WelcomeFor is one addressed Welcome a commit carries: the joining device and the blob only that
// device can open.
type WelcomeFor struct {
	DeviceID id.ID
	Blob     []byte
}

// CommitRequest is POST /v1/groups/{id}/commit. RatchetTree exists on the shape only because
// POST /heal shares it (interfaces §5.1 row 5); on this endpoint it must be empty, and the
// refusal is invariant 2's.
type CommitRequest struct {
	Epoch       uint64
	Commit      []byte
	GroupInfo   []byte
	Welcomes    []WelcomeFor
	RatchetTree []byte
}

type CommitResult struct {
	Seq   uint64
	Epoch uint64
}

// Commit is invariants 3 and 4, in the order the invariants are written. Each numbered step is a
// named test in commit_test.go; the order IS the invariant, and reordering it changes what the
// delivery service accepts.
func (d *DS) Commit(ctx context.Context, s Session, groupID id.ID, c CommitRequest) (CommitResult, error) {
	return d.commit(ctx, s, groupID, c, commitOptions{})
}

// commitOptions are the knobs the later external-commit paths turn. Task 20 sets none of them:
// `Commit` is the member path, and every field below is false or zero for it. They are declared
// here, with the one caller they have, because the branches they guard are written into `commit`
// now and the tasks that own those branches — 21 (the freeze), 24 (Welcomes) and 25 (resync and
// external join) — turn them on without reshaping the function.
type commitOptions struct {
	external         bool  // an external commit: resync and join
	joining          bool  // an external commit by a device that holds no leaf: a join (B36)
	skipFreeze       bool  // R25: resync is exempt, under its own two guards
	allowRatchetTree bool  // invariant 11's heal endpoint, the one route that DOES take a tree
	handshakeKind    uint8 // 0 means "derive it from `external`"
}

// CheckCommit is Commit's first two steps — the enrolled scope, a current leaf in the group, and
// invariant 3's epoch — answered from the path, the session and the epoch alone, with the same
// refusals Commit gives. POST /commit runs it BEFORE it reads a body the Welcome headroom lets grow
// to 16 MiB (deviation B37), so a stranger or a committer a round behind is refused for the price
// of a header. Commit runs both steps again under the group lock; this is an early answer, not
// the check.
func (d *DS) CheckCommit(ctx context.Context, s Session, groupID id.ID, epoch uint64) error {
	_, err := d.commitPreflight(ctx, s, groupID, epoch, false)
	return err
}

// commitPreflight is steps (1) and (2) of the commit path.
func (d *DS) commitPreflight(ctx context.Context, s Session, groupID id.ID, epoch uint64, external bool) (store.GroupRow, error) {
	// (1) scope and membership.
	// Named, not the literal 0: a future reordering of auth.Scope's constants would silently
	// change what this line means without touching it.
	if s.Scope != auth.ScopeEnrolled {
		return store.GroupRow{}, errForbidden("a commit needs an enrolled session")
	}
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return store.GroupRow{}, errNotFound("group")
	}
	if err != nil {
		return store.GroupRow{}, err
	}
	if !external {
		if _, err := d.leafOf(ctx, groupID, s.DeviceID); err != nil {
			return store.GroupRow{}, err
		}
	}

	// (2) one commit per epoch (invariant 3). protocol/02 defines the conflict as "a later one
	// for the SAME epoch", so a client AHEAD of the instance — after a restore, say — is a
	// structural error, not a conflict: winningCommit has nothing to return for a future epoch,
	// and a conflict body with a null winner is one the client cannot act on.
	if epoch > row.Epoch {
		return store.GroupRow{}, errCommitInvalid("epoch_ahead",
			fmt.Sprintf("the commit is for epoch %d; this instance is at %d", epoch, row.Epoch))
	}
	if epoch != row.Epoch {
		outstanding, err := d.refsOf(ctx, groupID, row.Epoch)
		if err != nil {
			return store.GroupRow{}, err
		}
		winner, err := d.winningCommit(ctx, groupID, epoch)
		if err != nil {
			return store.GroupRow{}, err
		}
		return store.GroupRow{}, errCommitConflict(winner, outstanding)
	}
	return row, nil
}

func (d *DS) commit(ctx context.Context, s Session, groupID id.ID, c CommitRequest, o commitOptions) (CommitResult, error) {
	defer d.flushEvictions(ctx, groupID) // after the unlock below: defers run last-in, first-out
	unlock := d.lock(groupID)
	defer unlock()
	return d.commitLocked(ctx, s, groupID, c, o)
}

// commitLocked is the commit path with the group lock ALREADY HELD.
//
// The split exists for `Resync` (R25), which has to read the group's epoch and run its own guard
// against the same epoch the commit will compare `c.Epoch` with. `d.lock` is a plain sync.Mutex
// and is not reentrant, so a resync that read the epoch through `commit` would either take the
// lock twice — deadlocking that group's request goroutine for the life of the process — or read
// the epoch outside it, where a commit landing in between turns a valid resync into a spurious
// E_COMMIT_CONFLICT. The device that is already out of the epoch is exactly the one that cannot
// recover from that.
func (d *DS) commitLocked(ctx context.Context, s Session, groupID id.ID, c CommitRequest, o commitOptions) (CommitResult, error) {
	// (1) scope and membership, (2) one commit per epoch: commitPreflight.
	row, err := d.commitPreflight(ctx, s, groupID, c.Epoch, o.external)
	if err != nil {
		return CommitResult{}, err
	}

	// (1a) an outstanding instance Add whose device or user has become ineligible is voided before
	// clause 1 is applied, so a commit that leaves it out can land (VoidIneligibleAdds says why no
	// commit could otherwise). A question the ACL cannot answer voids nothing and is logged: the
	// clauses below then decide exactly as they would have.
	if _, verr := d.voidIneligibleAddsLocked(ctx, groupID); verr != nil {
		d.log().Warn("checking the outstanding Adds' eligibility before a commit failed",
			"group", groupID.String()[:8], "err", verr)
	}

	// (2a) invariant 2: the delivery service serves the ratchet tree from its own PublicGroup, so
	// a committer never uploads one. Accepting-and-ignoring the field would leave the one route a
	// client could smuggle a tree through unguarded and untested.
	if !o.allowRatchetTree && len(c.RatchetTree) != 0 {
		return CommitResult{}, errInvalid(
			"ratchet_tree must be null on POST /commit: the delivery service serves the tree from its own PublicGroup")
	}

	// (3) the freeze (invariant 5) belongs HERE, between the epoch check and the parse: an
	// external commit is refused while a non-void proposal is outstanding and some member device
	// is online, and a resync skips it under R25's two guards. Task 20 never sets `o.external`,
	// so no path reaching this line is subject to the freeze until task 24 or 25 turns the flag
	// on — but the clause is written and reached from the one place the invariant puts it, not
	// left for the task that needs it to remember.
	//
	// A MEMBER commit is never refused here: it is the thing that lifts the freeze.
	if o.external && !o.skipFreeze {
		frozen, refs, ferr := d.freezeState(ctx, groupID, row.Epoch)
		if ferr != nil {
			return CommitResult{}, ferr
		}
		if frozen {
			return CommitResult{}, errCommitRequired(refs,
				uint64(d.opts.Policy.CommitDeadline.Milliseconds())) //nolint:gosec // G115: a non-negative duration in milliseconds
		}
	}

	var result CommitResult
	// The applied list and the epoch the commit came FROM are carried out of the closure: the
	// re-issue of whatever an external commit omitted (invariant 5's nobody-online exception) and
	// the next slice of a join storm both call back into the proposal path, which takes withGroup
	// again — and withGroup's handle lock is a plain sync.Mutex. Running either inside the closure
	// would deadlock this group's request goroutine for the life of the process.
	var applied []mlswasi.AppliedProposal
	oldEpoch := row.Epoch
	err = d.withGroup(ctx, groupID, func(g *mlswasi.PublicGroup) error {
		// (4) structural validation.
		processed, err := g.Process(ctx, c.Commit)
		if err != nil {
			return errCommitInvalid("structural", err.Error())
		}
		// Every refusal from HERE on — the structural checks below included — must release the
		// staged commit: public_group_process inserts one for every StagedCommitMessage it
		// accepts, public_group_merge is the only other consumer, and merging is exactly what a
		// refusal must not do. Registering this after the structural checks would leak one handle
		// per refused external commit, which any enrolled device drives in a loop until the guest
		// runs out of linear memory.
		merged := false
		defer func() {
			if !merged && processed.Staged != nil {
				if derr := g.Discard(ctx, *processed.Staged); derr != nil {
					d.log().Warn("discarding a refused staged commit failed",
						"group", groupID, "err", derr)
				}
			}
		}()

		// A commit is KindCommit on BOTH paths. KindExternalJoin (2) is the external-join
		// PROPOSAL arm — exports.rs returns `(2, None, None, Some(proposal_ref))` for it, with no
		// staged commit at all — while a genuine external commit is a StagedCommitMessage and so
		// arrives as KindCommit (1). What tells the two apart is the SENDER, not the kind:
		// `Sender::NewMemberCommit` maps to no sender leaf (interfaces.md:774), and that is the
		// sole marker the R25 scope guard is keyed on.
		if processed.Kind != mlswasi.KindCommit {
			return errCommitInvalid("structural", "the uploaded message is not a commit")
		}
		if processed.Staged == nil {
			return errCommitInvalid("structural", "the commit did not stage")
		}
		if o.external {
			if processed.SenderLeaf != nil {
				return errCommitInvalid("structural", "an external commit must not name a leaf")
			}
		} else if processed.SenderLeaf == nil {
			return errCommitInvalid("structural", "a member commit must name its leaf")
		}

		// (5) invariant 4's clauses over the applied list.
		if err := d.checkAppliedProposals(ctx, g, groupID, row, s, processed, o); err != nil {
			return err
		}

		// (5a) every addressed Welcome names a device THIS commit adds.
		if err := checkAddressedWelcomes(processed.Applied, c.Welcomes); err != nil {
			return err
		}

		// (6) the GroupInfo: epoch n+1, signed by the committer.
		//
		// The signer is the committer's own leaf, and leaf 0 is not a safe default for a commit
		// that names none: on the external path it would check the joiner's GroupInfo against the
		// CREATOR's signature key, which is a different question from the one invariant 4 asks.
		//
		// On the external path the joiner occupies no leaf of the current tree, so there is no
		// tree key to check against: ABI v3 reports the leaf the joiner lands on (`NewLeaf`) and
		// checks the GroupInfo under the key the staged commit's UpdatePath brings for it
		// (deviation B33, closing B30(a)). Both happen BEFORE the merge, which is irreversible. A
		// commit that reports no new leaf still fails closed rather than borrowing leaf 0's key.
		var check mlswasi.GroupInfoCheck
		if o.external {
			if processed.NewLeaf == nil {
				return errCommitInvalid("group_info_signature",
					"the joiner's leaf is unknown, so the GroupInfo's signer cannot be checked")
			}
			check, err = g.ValidateStagedGroupInfo(ctx, *processed.Staged, c.GroupInfo)
		} else {
			if processed.SenderLeaf == nil {
				return errCommitInvalid("group_info_signature",
					"the committer's leaf is unknown, so the GroupInfo's signer cannot be checked")
			}
			check, err = g.ValidateGroupInfo(ctx, c.GroupInfo, *processed.SenderLeaf)
		}
		if err != nil {
			return errCommitInvalid("group_info", err.Error())
		}
		if check.Epoch != row.Epoch+1 {
			return errCommitInvalid("group_info_epoch",
				fmt.Sprintf("GroupInfo is at epoch %d, want %d", check.Epoch, row.Epoch+1))
		}
		if !check.SignatureOK {
			return errCommitInvalid("group_info_signature",
				"the GroupInfo is not signed by the committer's leaf")
		}

		// (7) one transaction: merge, persist, append, replace members, drop proposals.
		//
		// Merge is irreversible: it consumes the staged handle and advances the guest's in-memory
		// group. If any later statement fails, SQL rolls back to epoch n while the cached handle
		// sits at n+1, and R12's "SQL is the record" is violated for the rest of the process's
		// life — every later commit for that group then validates against the wrong epoch. So a
		// failure after Merge EVICTS the group from the state cache, and the next request
		// re-imports the committed blob.
		var members memberView
		var handshakeKind uint8
		// The welcoming epoch's tree, carried out of the transaction to the fan-out below.
		var welcomeTree, welcomeTreeHash []byte
		mergeRan := false
		txErr := d.opts.Store.Tx(ctx, func(tx store.Repository) error {
			epoch, err := g.Merge(ctx, *processed.Staged)
			if err != nil {
				return err
			}
			mergeRan = true
			merged = true
			seq, err := nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			kind := o.handshakeKind
			if kind == 0 {
				kind = handshakeCommit
				if o.external {
					kind = handshakeExternalCommit
				}
			}
			handshakeKind = kind
			senderDevice := s.DeviceID
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID:      groupID,
				Seq:          seq,
				Epoch:        epoch,
				Kind:         kind,
				SenderLeaf:   processed.SenderLeaf,
				SenderDevice: &senderDevice,
				Blob:         c.Commit,
				Created:      d.now(),
			}); err != nil {
				return err
			}
			if err := persistState(ctx, tx, groupID, g, c.GroupInfo); err != nil {
				return err
			}
			state, err := g.State(ctx)
			if err != nil {
				return err
			}
			// The joiner's own leaf is checked against the session that uploaded it, on the
			// merged state because that is the first place the leaf exists. A refusal here rolls
			// the transaction back and the stale handle is evicted below, as for any failure
			// after the merge.
			if o.external {
				if err := d.checkExternalJoiner(ctx, g, groupID, s, state, processed.NewLeaf, o.joining); err != nil {
					return err
				}
			}
			members, err = d.replaceMembersTx(ctx, tx, groupID, row.Kind, state)
			if err != nil {
				return err
			}
			refs := make([][]byte, 0, len(processed.Applied))
			for _, a := range processed.Applied {
				refs = append(refs, a.ProposalRef)
			}
			if err := tx.DeleteProposals(ctx, groupID, refs); err != nil {
				return err
			}
			// The addressed Welcomes are stored HERE, in this same transaction: a Welcome row
			// that outlives a rolled-back commit addresses an epoch that never happened. `g` has
			// already merged, so the epoch tree it writes beside them is the welcoming epoch's —
			// and it hands that tree back for the fan-out, which needs the same two values for
			// every joiner and must not read one copy of them back per joiner.
			welcomeTree, welcomeTreeHash, err = d.storeWelcomesTx(ctx, tx, groupID, epoch, seq, g, c.Welcomes)
			if err != nil {
				return err
			}
			result = CommitResult{Seq: seq, Epoch: epoch}
			return nil
		})
		if txErr != nil {
			if mergeRan {
				// withGroup holds the handle's own lock, so evict cannot be called from here —
				// it would wait on that same lock. The eviction is recorded and performed by the
				// caller, below, once withGroup has returned.
				d.markStaleAfterFailedMerge(groupID)
			}
			return txErr
		}
		// The devices this commit took out of a call group leave the call's room once the group lock
		// is released (commit's deferred flushEvictions; G29).
		d.queueEviction(groupID, members.removed)

		// (8) fan out. Everything reachable from here runs with the group lock ALREADY HELD by
		// commit, so it must be lock-free: the re-issue below and drainPendingJoins call only the
		// …Locked forms of the proposal API.
		applied = processed.Applied
		if d.opts.Gateway != nil {
			d.opts.Gateway.SetGroupMembers(groupID, members.devices)
			d.opts.Gateway.SetGroupLeaves(groupID, members.leaves)
		}
		d.fanOutCommit(ctx, groupID, result, processed, c, handshakeKind, welcomeTree, welcomeTreeHash)
		return nil
	})
	if d.takeStaleAfterFailedMerge(groupID) {
		// Outside withGroup, so the handle lock is free.
		if evErr := d.states.evict(ctx, groupID); evErr != nil {
			d.log().Error("evicting a group whose merge outran its transaction failed",
				"group", groupID, "err", evErr)
		}
	}
	if err != nil {
		if d.opts.Metrics != nil {
			d.opts.Metrics.DSCommits.WithLabelValues("refused").Inc()
		}
		return CommitResult{}, err
	}
	d.accepted.Add(1)
	if d.opts.Metrics != nil {
		// plan-1a task 7 declares `DSCommits *prometheus.CounterVec` for
		// `dilla_ds_commits_total{result}`. There is no `CommitsTotal`.
		d.opts.Metrics.DSCommits.WithLabelValues("accepted").Inc()
	}

	// (8b) the round is WON. Invariant 7's watchdog charges a lost round to the candidate of an
	// overdue election that was acknowledged, and three of those remove the device from the group
	// by an instance Remove — so the election must learn that this committer did what it was asked
	// to do. Nothing else tells it: `clearElection`'s other call sites are all inside
	// RequestCommit, and `e.acked` is cleared only by the next round.
	//
	// The refs this commit applied are deleted in the transaction above, so the fresh election
	// step (9) and the next proposal hold is over the NEW epoch's outstanding work, from round one
	// of a fresh rotation. RunWatchdogOnce carries the same rule for the window in which its tick
	// beats this line: an election whose epoch the group has already left is won, never lost.
	d.clearElection(groupID)

	// (9) invariant 5's tail, with the group lock still held and withGroup returned. A commit can
	// only OMIT an outstanding instance proposal through the nobody-online exception above, so
	// the re-issue runs exactly on that path: every proposal the commit did not reference is
	// re-signed for the new epoch, keeping its action_id, and the freeze stays.
	if o.external {
		if rerr := d.reissueOmitted(ctx, groupID, oldEpoch, applied); rerr != nil {
			d.log().Error("re-issuing the proposals an external commit omitted failed",
				"group", groupID, "err", rerr)
		}
	}
	// And the next slice of a join storm, once this commit has landed. Without it a 1,000-device
	// batch stalls after its first 256. It runs after EVERY accepted commit, not only one that
	// applied Adds: a commit of Removes, or one after the storm's own Adds were voided, frees room
	// too, and an empty queue costs one read. The committer's request context is not the drain's —
	// the commit is durable, and a client that hangs up now must not cut the next slice short.
	if _, derr := d.drainPendingJoins(context.WithoutCancel(ctx), groupID); derr != nil {
		d.log().Error("proposing the next slice of a join storm failed; the sweeper retries it",
			"group", groupID, "err", derr)
	}
	// F9, a call group's epoch boundary: a voided instance Remove this commit left out — voided by the
	// TTL, or by its member's own Remove, which a commit may leave out too — whose leaf survived is
	// re-driven at the new epoch. The sweep re-drives within an epoch and never reads the old one.
	if row.Kind == groupKindCall {
		if rerr := d.redriveCallRemovesLocked(context.WithoutCancel(ctx), groupID, oldEpoch, result.Epoch); rerr != nil {
			d.log().Error("re-driving the call Removes a commit left out failed",
				"group", groupID, "err", rerr)
		}
	}
	return result, nil
}

// markStaleAfterFailedMerge and takeStaleAfterFailedMerge carry one bit from inside withGroup's
// handle lock to outside it, so the eviction happens where it cannot deadlock.
func (d *DS) markStaleAfterFailedMerge(groupID id.ID) {
	d.staleMu.Lock()
	if d.stale == nil {
		d.stale = map[id.ID]struct{}{}
	}
	d.stale[groupID] = struct{}{}
	d.staleMu.Unlock()
}

func (d *DS) takeStaleAfterFailedMerge(groupID id.ID) bool {
	d.staleMu.Lock()
	defer d.staleMu.Unlock()
	_, ok := d.stale[groupID]
	delete(d.stale, groupID)
	return ok
}

// checkAppliedProposals is invariant 4's clauses over the applied list. The clause numbers are
// protocol/02's own.
func (d *DS) checkAppliedProposals(ctx context.Context, g DeviceListVerifier, groupID id.ID, row store.GroupRow, s Session, p mlswasi.Processed, o commitOptions) error {
	outstanding, err := d.opts.Store.ListProposals(ctx, groupID, row.Epoch, false)
	if err != nil {
		return err
	}
	applied := map[string]struct{}{}
	for _, a := range p.Applied {
		applied[string(a.ProposalRef)] = struct{}{}
	}
	// Clause 1: every outstanding non-void DS proposal is referenced.
	//
	// THE EXEMPTION (deviation B21, ruling 42). An external commit cannot reference the instance's
	// outstanding proposals — it is built by a device that is not in the epoch — and there are
	// exactly two places protocol/02 accepts one anyway:
	//
	//  1. Invariant 5's nobody-online case. The freeze has LIFTED because no member device is
	//     online, the external commit is accepted, and the proposals it omitted are re-issued for
	//     the new epoch by `reissueOmitted` at step (9). Without this exemption step (9) is
	//     unreachable and `reissueOmitted` can never fire.
	//  2. R25's resync, which is exempt from the freeze under its own two guards and re-issues
	//     the outstanding proposals for the new epoch immediately afterwards (`reissueAll`).
	//
	// The freeze's own answer is what decides case 1 — never an unconditional external carve-out,
	// which would let an outsider commit straight through a live freeze — and `o.skipFreeze`,
	// which only `Resync` sets, is what decides case 2.
	exemptFromClause1, err := d.clause1Exempt(ctx, groupID, row.Epoch, o)
	if err != nil {
		return err
	}
	for _, pending := range outstanding {
		if pending.Origin != 0 || pending.VoidAt != nil {
			continue
		}
		if exemptFromClause1 {
			continue
		}
		if _, ok := applied[string(pending.Ref)]; !ok {
			return errCommitInvalid("outstanding_proposals",
				fmt.Sprintf("the commit does not reference the outstanding proposal %x", pending.Ref))
		}
	}
	for _, a := range p.Applied {
		switch a.Kind {
		case mlswasi.ProposalUpdate:
			// Clause 2: no Update from the committer. A committer who wants to rotate its own
			// leaf uses the commit's UpdatePath, which is not a proposal.
			if a.SenderLeaf != nil && p.SenderLeaf != nil && *a.SenderLeaf == *p.SenderLeaf {
				return errCommitInvalid("committer_update", "the commit carries the committer's own Update")
			}
		case mlswasi.ProposalRemove:
			// Clause 3: every member-originated Remove targets its proposer's own user — the
			// committer's for a Remove the commit carries by value, the proposing member's for a
			// member Remove proposal the commit references. The second is how a member leaves
			// (protocol/01 "Leaving", DEV-47): a device cannot commit its own removal, so it
			// proposes it and another member commits it. Proposal already refused a member proposal
			// that removes anybody else.
			if a.SenderLeaf == nil || a.TargetLeaf == nil {
				continue // an instance Remove, which invariant 6 governs instead
			}
			target, err := d.userOfLeaf(ctx, groupID, *a.TargetLeaf)
			if err != nil {
				return err
			}
			owner := s.UserID
			if p.SenderLeaf != nil && *a.SenderLeaf != *p.SenderLeaf {
				if owner, err = d.userOfLeaf(ctx, groupID, *a.SenderLeaf); err != nil {
					return err
				}
			}
			if target != owner {
				return errCommitInvalid("member_remove_scope",
					"a member-originated Remove may only target its proposer's own user")
			}
		case mlswasi.ProposalAdd:
			// Clause 4: the added KeyPackage validates, its user is eligible and its DSK is in
			// the newest device list.
			if err := d.checkAddedMember(ctx, g, groupID, a); err != nil {
				return err
			}
		}
	}
	if o.external {
		// R25: an external commit may remove nobody but the joiner's own prior leaf.
		return d.checkExternalCommitScope(ctx, groupID, s, p.Applied)
	}
	return nil
}

// clause1Exempt answers whether this commit may omit the instance's outstanding proposals. The
// two cases are written out at clause 1 itself; a member commit is never exempt, and it is the
// thing that lifts the freeze.
func (d *DS) clause1Exempt(ctx context.Context, groupID id.ID, epoch uint64, o commitOptions) (bool, error) {
	if !o.external {
		return false, nil
	}
	if o.skipFreeze {
		// R25's resync. `reissueAll` re-issues whatever it omitted, for the new epoch.
		return true, nil
	}
	frozen, _, err := d.freezeState(ctx, groupID, epoch)
	if err != nil {
		return false, err
	}
	// Invariant 5's nobody-online exception: exempt exactly when the freeze is NOT holding.
	return !frozen, nil
}

// checkAddressedWelcomes is the clause that keeps `CommitRequest.Welcomes` inside the commit that
// carries it: every addressed device must be one this commit's applied Add proposals name.
//
// Without it `storeWelcomesTx` writes whatever the committer addressed, so any enrolled member can
// queue an opaque blob to an arbitrary device id at that group's epoch. The recipient cannot open
// it — the blob is no Welcome for its key material — but it learns the group_id and the epoch of a
// group it was never added to, and its Welcome queue holds that row for the 30-day retention;
// `mls_welcomes` is unique only on (device_id, blob_sha256), so varying the blob defeats the
// dedupe and the queue grows one row per request.
//
// protocol/02 does not state the clause and task 24's brief did not ask for it; it is added here
// because the material is already in hand (invariant 4's Add clause decodes the same credentials)
// and because an unvalidated addressed Welcome left unstated in the code is the worst of the
// options. Recorded as deviation B26 in the plan.
func checkAddressedWelcomes(applied []mlswasi.AppliedProposal, welcomes []WelcomeFor) error {
	if len(welcomes) == 0 {
		return nil
	}
	added := make(map[id.ID]struct{}, len(applied))
	for _, a := range applied {
		if a.Kind != mlswasi.ProposalAdd {
			continue
		}
		deviceID, _, err := decodeCredentialIdentity(a.CredentialIdentity)
		if err != nil {
			// The same refusal invariant 4's Add clause gives an undecodable credential; reaching
			// this line means that clause has already passed it, so it is belt and braces.
			return errCommitInvalid("add_key_package", "undecodable credential identity")
		}
		added[deviceID] = struct{}{}
	}
	for _, wf := range welcomes {
		if _, ok := added[wf.DeviceID]; !ok {
			return errCommitInvalid("welcome_addressee",
				fmt.Sprintf("the commit addresses a Welcome to device %s, which it does not add", wf.DeviceID))
		}
	}
	return nil
}

// checkAddedMember validates one Add's credential against the device list the delivery service
// holds and the channel ACL. v is the guest the caller already holds, which the device list is
// verified in (DeviceLists.Entries says why a second instance must not be acquired here).
func (d *DS) checkAddedMember(ctx context.Context, v DeviceListVerifier, groupID id.ID, a mlswasi.AppliedProposal) error {
	deviceID, userID, err := decodeCredentialIdentity(a.CredentialIdentity)
	if err != nil {
		return errCommitInvalid("add_key_package", "undecodable credential identity")
	}
	device, err := d.opts.Store.GetDevice(ctx, deviceID)
	if errors.Is(err, store.ErrNotFound) {
		return errCommitInvalid("add_key_package", "the added device is unknown to this instance")
	}
	if err != nil {
		return err
	}
	if device.UserID != userID {
		return errCommitInvalid("add_key_package", "the credential's user does not own the device")
	}
	if device.RevokedAt != nil {
		return errCommitInvalid("add_key_package", "the added device is revoked")
	}

	// The device-list clause. A substring search over the serialized blob is NOT membership: a
	// 32-byte window can fall inside another entry's signature or inside any attacker-influenced
	// field, and a blob whose ssk_signature does not verify would be accepted outright. This is
	// the clause that stops a compromised instance or a stale list from admitting a device the
	// user never authorised, so the list is decoded, its signature verified, and the comparison
	// made against a decoded entry.
	entries, err := d.opts.DeviceLists.Entries(ctx, v, userID)
	if err != nil {
		// A missing or unverifiable list is a refusal, never a pass: an Add of an unlisted device
		// must not be accepted because the user happens to have no device_lists row.
		return errCommitInvalid("add_key_package",
			"no verifiable signed device list for the added user: "+err.Error())
	}
	found := false
	for _, dsk := range entries {
		if bytes.Equal(dsk, device.DSKPub) {
			found = true
			break
		}
	}
	if !found {
		return errCommitInvalid("add_key_package",
			"the added device's DSK is not in the newest signed device list")
	}

	// The ACL clause (protocol/02 invariant 4, spec line 458).
	ok, err := d.opts.ACL.Eligible(ctx, groupID, userID)
	if err != nil {
		return errCommitInvalid("add_acl", "the channel ACL cannot be resolved: "+err.Error())
	}
	if !ok {
		return errCommitInvalid("add_acl", "the added user is not eligible under the channel's ACL")
	}
	return nil
}

// checkExternalJoiner is invariant 4's Add clause applied to the leaf an external commit creates:
// an external commit adds its committer, so the leaf must be the uploading session's own device and
// user — a joiner may not land a leaf in another device's name — and, for a device joining rather
// than resyncing, its user must be eligible under the channel ACL and its DSK, which is the leaf's
// signature key, must be in the newest signed device list, exactly as for an Add by proposal
// (`checkAddedMember`). Deviation B36.
func (d *DS) checkExternalJoiner(ctx context.Context, v DeviceListVerifier, groupID id.ID, s Session, state mlswasi.GroupState, newLeaf *uint32, joining bool) error {
	if newLeaf == nil {
		return errCommitInvalid("external_joiner", "the joiner's leaf is unknown")
	}
	var leaf *mlswasi.Member
	for i := range state.Members {
		if state.Members[i].LeafIndex == *newLeaf {
			leaf = &state.Members[i]
			break
		}
	}
	if leaf == nil {
		return errCommitInvalid("external_joiner", "the merged tree holds no leaf where the joiner landed")
	}
	deviceID, userID, err := decodeCredentialIdentity(leaf.CredentialIdentity)
	if err != nil {
		return errCommitInvalid("external_joiner", "undecodable credential identity")
	}
	if deviceID != s.DeviceID || userID != s.UserID {
		return errCommitInvalid("external_joiner",
			"an external commit's leaf must be the uploading device's own")
	}
	if !joining {
		return nil
	}
	device, err := d.opts.Store.GetDevice(ctx, deviceID)
	if err != nil {
		return err
	}
	if device.RevokedAt != nil {
		return errCommitInvalid("external_joiner", "the joining device is revoked")
	}
	if !bytes.Equal(leaf.SignatureKey, device.DSKPub) {
		return errCommitInvalid("external_joiner", "the joiner's leaf key is not its device key")
	}
	entries, err := d.opts.DeviceLists.Entries(ctx, v, userID)
	if err != nil {
		return errCommitInvalid("external_joiner",
			"no verifiable signed device list for the joining user: "+err.Error())
	}
	for _, dsk := range entries {
		if bytes.Equal(dsk, device.DSKPub) {
			return nil
		}
	}
	return errCommitInvalid("external_joiner",
		"the joining device's DSK is not in the newest signed device list")
}

// fanOutCommit sends mls.handshake and mls.epoch_changed to the group. Every payload is encoded
// once (facts-gateway-design §3.3).
//
// kind is the value the transaction actually stored, not a constant: a resync and an external join
// store kind 2 (external_commit), and hardcoding 1 here would make the same handshake kind 1 over
// the gateway and kind 2 in GET /v1/groups/{id}/handshakes — a contradiction for any client that
// reconciles the two streams, and a violation of protocol/02's "Handshake records".
//
// The addressed mls.welcome fan-out comes AFTER the two frames below; protocol/02 fixes that
// order, so a Welcome never precedes the epoch change that produced it.
func (d *DS) fanOutCommit(ctx context.Context, groupID id.ID, r CommitResult, p mlswasi.Processed, c CommitRequest, kind uint8, welcomeTree, welcomeTreeHash []byte) {
	if d.opts.Gateway == nil {
		return
	}
	hs, err := gateway.HandshakePayload(r.Seq, r.Epoch, kind, p.SenderLeaf, c.Commit)
	if err != nil {
		return
	}
	d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
		Op: gateway.OpMLSHandshake, GroupID: &groupID, Payload: hs, Replay: true,
	})
	ec, err := gateway.EpochChangedPayload(r.Epoch, r.Seq)
	if err != nil {
		return
	}
	d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
		Op: gateway.OpMLSEpochChanged, GroupID: &groupID, Payload: ec, Replay: true,
	})
	d.fanOutWelcomes(ctx, groupID, r.Epoch, welcomeTree, welcomeTreeHash, c.Welcomes)
}

// Proposal accepts a member's own proposal. Only two shapes are allowed: an Update, and a Remove
// of one of the sender's own devices. ProposalInspect is what tells them apart — for a member
// proposal the delivery service knows neither kind nor target by construction.
func (d *DS) Proposal(ctx context.Context, s Session, groupID id.ID, epoch uint64, blob []byte) (uint64, error) {
	unlock := d.lock(groupID)
	defer unlock()

	if s.Scope != auth.ScopeEnrolled {
		return 0, errForbidden("a proposal needs an enrolled session")
	}
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return 0, errNotFound("group")
	}
	if err != nil {
		return 0, err
	}
	if epoch != row.Epoch {
		return 0, errCommitInvalid("epoch",
			fmt.Sprintf("proposal is for epoch %d, group is at %d", epoch, row.Epoch))
	}
	leaf, err := d.leafOf(ctx, groupID, s.DeviceID)
	if err != nil {
		return 0, err
	}

	var seq uint64
	var voidedRemoves int
	err = d.withGroup(ctx, groupID, func(g *mlswasi.PublicGroup) error {
		processed, err := g.Process(ctx, blob)
		if err != nil {
			return errCommitInvalid("structural", err.Error())
		}
		if processed.Kind != mlswasi.KindProposal {
			return errCommitInvalid("structural", "the uploaded message is not a proposal")
		}
		if processed.SenderLeaf == nil || *processed.SenderLeaf != leaf {
			return errForbidden("a member proposal must be signed by the sending device's own leaf")
		}
		ref, detail, err := d.queueMemberProposal(ctx, g, s, groupID, blob)
		if err != nil {
			return err
		}

		// senderDevice is taken once, outside the closure: `s` is the session parameter and must
		// not be shadowed by the seq variable below.
		senderDevice := s.DeviceID
		txErr := d.opts.Store.Tx(ctx, func(tx store.Repository) error {
			allocated, err := nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			seq = allocated
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID: groupID, Seq: seq, Epoch: row.Epoch, Kind: handshakeProposal,
				SenderLeaf: &leaf, SenderDevice: &senderDevice,
				Blob: blob, Created: d.now(),
			}); err != nil {
				return err
			}
			if err := tx.PutProposal(ctx, store.ProposalRow{
				GroupID:    groupID,
				Ref:        ref,
				Epoch:      row.Epoch,
				Kind:       uint8(detail.Kind),
				TargetLeaf: detail.TargetLeaf,
				Origin:     1, // member
				ActionID:   id.New(),
				IssuedAt:   d.now(),
				TTL:        uint64(d.proposalTTL(row.Kind).Seconds()),
			}); err != nil {
				return err
			}
			// DEV-45: a member's own Remove voids the instance's Remove of the same leaf, so the two are
			// never both live and the commit that carries the member's may omit the instance's.
			if detail.Kind == mlswasi.ProposalRemove && detail.TargetLeaf != nil {
				n, err := d.voidInstanceRemovesTx(ctx, tx, groupID, row.Epoch, *detail.TargetLeaf)
				if err != nil {
					return err
				}
				voidedRemoves = n
			}
			return persistState(ctx, tx, groupID, g, row.GroupInfoBlob)
		})
		if txErr != nil {
			// The put is already in the guest's queue and the row it was going to get has rolled
			// back. Take it out again, for the same reason the shape refusals do.
			d.unqueueProposal(ctx, g, groupID, ref)
			return txErr
		}
		return nil
	})
	if d.takeStaleAfterFailedMerge(groupID) {
		// Outside withGroup, so the handle lock is free. Reached only when the guest refused to
		// give a refused proposal back, which leaves the cached group ahead of SQL.
		if evErr := d.states.evict(ctx, groupID); evErr != nil {
			d.log().Error("evicting a group whose proposal queue outran its transaction failed",
				"group", groupID, "err", evErr)
		}
	}
	if err != nil {
		return 0, err
	}
	if voidedRemoves > 0 && d.opts.Metrics != nil {
		d.opts.Metrics.DSProposals.WithLabelValues(proposalLabel(uint8(mlswasi.ProposalRemove))).Sub(float64(voidedRemoves))
	}
	if d.opts.Gateway != nil {
		p, err := gateway.HandshakePayload(seq, row.Epoch, handshakeProposal, &leaf, blob)
		if err == nil {
			d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
				Op: gateway.OpMLSHandshake, GroupID: &groupID, Payload: p, Replay: true,
			})
		}
	}
	return seq, nil
}

// queueMemberProposal puts a member's proposal into the guest's queue and decides whether its
// shape is one a member may send. `ProposalInspect` is keyed on a ref the queue hands out, so the
// put necessarily precedes the decision.
//
// Every refusal after the put must take the proposal back OUT of the queue. A refused proposal
// left behind is one the cached PublicGroup holds and SQL does not — R12's "SQL is the record",
// inverted — and it stays there until the group is evicted, so an enrolled member grows the queue
// by one entry per refused request. The commit path guards its own equivalent with Discard; this
// is that guard.
func (d *DS) queueMemberProposal(ctx context.Context, g *mlswasi.PublicGroup, s Session, groupID id.ID, blob []byte) ([]byte, mlswasi.ProposalDetail, error) {
	ref, err := g.ProposalPut(ctx, 0, blob)
	if err != nil {
		return nil, mlswasi.ProposalDetail{}, err
	}
	accepted := false
	defer func() {
		if !accepted {
			d.unqueueProposal(ctx, g, groupID, ref)
		}
	}()
	detail, err := g.ProposalInspect(ctx, ref)
	if err != nil {
		return nil, mlswasi.ProposalDetail{}, err
	}
	switch detail.Kind {
	case mlswasi.ProposalUpdate:
	case mlswasi.ProposalRemove:
		if detail.TargetLeaf == nil {
			return nil, mlswasi.ProposalDetail{}, errForbidden("a member Remove must name its target")
		}
		target, err := d.userOfLeaf(ctx, groupID, *detail.TargetLeaf)
		if err != nil {
			return nil, mlswasi.ProposalDetail{}, err
		}
		if target != s.UserID {
			return nil, mlswasi.ProposalDetail{}, errForbidden("a member may only Remove its own user's devices")
		}
	default:
		return nil, mlswasi.ProposalDetail{}, errForbidden(
			"a member may only propose an Update or a Remove of its own devices")
	}
	accepted = true
	return ref, detail, nil
}

// unqueueProposal removes one proposal from the guest's queue by ref (public_group_proposal_put
// op 1). If the removal itself fails the cached PublicGroup is left holding a proposal SQL does
// not have, so the group is marked for eviction and the next request re-imports the committed
// state blob — the same escape hatch a merge that outran its transaction takes.
func (d *DS) unqueueProposal(ctx context.Context, g *mlswasi.PublicGroup, groupID id.ID, ref []byte) {
	if _, err := g.ProposalPut(ctx, 1, ref); err != nil {
		d.log().Warn("removing a refused proposal from the guest's queue failed",
			"group", groupID, "err", err)
		d.markStaleAfterFailedMerge(groupID)
	}
}

// leafOf is invariant 8's "current leaf" check, shared by Commit, Proposal and Upload.
func (d *DS) leafOf(ctx context.Context, groupID, deviceID id.ID) (uint32, error) {
	members, err := d.opts.Store.ListMembers(ctx, groupID)
	if err != nil {
		return 0, err
	}
	for _, m := range members {
		if m.DeviceID == deviceID && m.RemovedEpoch == nil {
			return m.LeafIndex, nil
		}
	}
	return 0, errLeafNotCurrent()
}

func (d *DS) userOfLeaf(ctx context.Context, groupID id.ID, leaf uint32) (id.ID, error) {
	members, err := d.opts.Store.ListMembers(ctx, groupID)
	if err != nil {
		return id.ID{}, err
	}
	for _, m := range members {
		if m.LeafIndex == leaf && m.RemovedEpoch == nil {
			return m.UserID, nil
		}
	}
	return id.ID{}, errCommitInvalid("member_remove_scope", "the Remove targets a leaf that is not a member")
}

// deviceOfLeaf is `userOfLeaf`'s sibling: the same `ListMembers` scan, answering with the leaf's
// DEVICE. R25's external-commit scope clause is about the device — "the joining device's own
// previous leaf" — and a user with two devices in one group would pass a user-level check while
// removing the other device's leaf.
func (d *DS) deviceOfLeaf(ctx context.Context, groupID id.ID, leaf uint32) (id.ID, error) {
	members, err := d.opts.Store.ListMembers(ctx, groupID)
	if err != nil {
		return id.ID{}, err
	}
	for _, m := range members {
		if m.LeafIndex == leaf && m.RemovedEpoch == nil {
			return m.DeviceID, nil
		}
	}
	return id.ID{}, errCommitInvalid("external_commit_remove_scope",
		"the Remove targets a leaf that is not a member")
}

func (d *DS) refsOf(ctx context.Context, groupID id.ID, epoch uint64) ([][]byte, error) {
	rows, err := d.opts.Store.ListProposals(ctx, groupID, epoch, false)
	if err != nil {
		return nil, err
	}
	refs := make([][]byte, 0, len(rows))
	for _, r := range rows {
		refs = append(refs, r.Ref)
	}
	return refs, nil
}

// winningCommit is the commit that already took the epoch the loser tried to take.
//
// It is a single indexed lookup, not a scan: paging `ListHandshakes(ctx, groupID, 0, 512)` from
// seq 0 and scanning backwards would, on any group with more than 512 handshakes above the
// retention floor — the 1,500-leaf fixture and every long-lived channel — leave the winner
// outside the page and send E_COMMIT_CONFLICT with a nil `winning_commit`. protocol/02 declares
// that element a `bstr` and the losing client processes it to catch up, so a null there breaks the
// conflict-recovery loop the whole invariant exists for (deviation B13).
func (d *DS) winningCommit(ctx context.Context, groupID id.ID, epoch uint64) ([]byte, error) {
	row, err := d.opts.Store.GetCommitAtEpoch(ctx, groupID, epoch+1)
	if errors.Is(err, store.ErrNotFound) {
		// The epoch bump is recorded but its handshake has been pruned. An empty bstr is honest;
		// a null is not, and the client's decoder expects a bstr.
		d.log().Warn("no handshake for the winning epoch; the log has been pruned past it",
			"group", groupID, "epoch", epoch+1)
		return []byte{}, nil
	}
	if err != nil {
		return nil, err
	}
	return row.Blob, nil
}

func (d *DS) proposalTTL(groupKind uint8) time.Duration {
	if groupKind == groupKindCall {
		return d.opts.Policy.ProposalTTLCall
	}
	return d.opts.Policy.ProposalTTLText
}
