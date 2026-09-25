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
	skipFreeze       bool  // R25: resync is exempt, under its own two guards
	allowRatchetTree bool  // invariant 11's heal endpoint, the one route that DOES take a tree
	handshakeKind    uint8 // 0 means "derive it from `external`"
}

func (d *DS) commit(ctx context.Context, s Session, groupID id.ID, c CommitRequest, o commitOptions) (CommitResult, error) {
	unlock := d.lock(groupID)
	defer unlock()

	// (1) scope and membership.
	// Named, not the literal 0: a future reordering of auth.Scope's constants would silently
	// change what this line means without touching it.
	if s.Scope != auth.ScopeEnrolled {
		return CommitResult{}, errForbidden("a commit needs an enrolled session")
	}
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return CommitResult{}, errNotFound("group")
	}
	if err != nil {
		return CommitResult{}, err
	}
	if !o.external {
		if _, err := d.leafOf(ctx, groupID, s.DeviceID); err != nil {
			return CommitResult{}, err
		}
	}

	// (2) one commit per epoch (invariant 3). protocol/02 defines the conflict as "a later one
	// for the SAME epoch", so a client AHEAD of the instance — after a restore, say — is a
	// structural error, not a conflict: winningCommit has nothing to return for a future epoch,
	// and a conflict body with a null winner is one the client cannot act on.
	if c.Epoch > row.Epoch {
		return CommitResult{}, errCommitInvalid("epoch_ahead",
			fmt.Sprintf("the commit is for epoch %d; this instance is at %d", c.Epoch, row.Epoch))
	}
	if c.Epoch != row.Epoch {
		outstanding, err := d.refsOf(ctx, groupID, row.Epoch)
		if err != nil {
			return CommitResult{}, err
		}
		winner, err := d.winningCommit(ctx, groupID, c.Epoch)
		if err != nil {
			return CommitResult{}, err
		}
		return CommitResult{}, errCommitConflict(winner, outstanding)
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
				uint64(d.opts.Policy.CommitDeadline.Milliseconds()))
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
		if err := d.checkAppliedProposals(ctx, groupID, row, s, processed, o); err != nil {
			return err
		}

		// (6) the GroupInfo: epoch n+1, signed by the committer.
		//
		// The signer is the committer's own leaf, and leaf 0 is not a safe default for a commit
		// that names none: on the external path it would check the joiner's GroupInfo against the
		// CREATOR's signature key, which is a different question from the one invariant 4 asks.
		// Task 25 supplies the joiner's new leaf index here; until it does, a commit with no
		// sender leaf fails closed rather than borrowing leaf 0's key.
		if processed.SenderLeaf == nil {
			return errCommitInvalid("group_info_signature",
				"the committer's leaf is unknown, so the GroupInfo's signer cannot be checked")
		}
		check, err := g.ValidateGroupInfo(ctx, c.GroupInfo, *processed.SenderLeaf)
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
			members, err = d.replaceMembersTx(ctx, tx, groupID, state)
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
	// And the next slice of a join storm, once the Adds of this commit have landed. Without it a
	// 1,000-device batch stalls after its first 256.
	for _, a := range applied {
		if a.Kind == mlswasi.ProposalAdd {
			d.drainPendingJoins(ctx, groupID)
			break
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
func (d *DS) checkAppliedProposals(ctx context.Context, groupID id.ID, row store.GroupRow, s Session, p mlswasi.Processed, o commitOptions) error {
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
	// TASK 25 OWES THIS CLAUSE ONE EXEMPTION (deviation B21, ruling 42). Invariant 5's
	// nobody-online case requires the EXTERNAL commit to be ACCEPTED while instance proposals are
	// outstanding, and the omitted ones to be re-issued for the new epoch afterwards — which is
	// what `reissueOmitted` (freeze.go) exists to do at commit step (9). As written, clause 1
	// refuses ANY commit that omits a non-void origin-0 row at the current epoch, external or not,
	// so step (9) is never reached on the one path that needs it and `reissueOmitted` cannot fire.
	// The exemption task 25 must add here is: skip origin-0 rows when `o.external && !frozen`,
	// i.e. when the commit is external AND the freeze has lifted because nobody is online
	// (`freezeState`'s own answer — never an unconditional external carve-out, which would let an
	// outsider commit straight through a live freeze). Task 21 could not add it: nothing sets
	// `commitOptions.external` until task 24/25, and no fixture in this repository can produce an
	// acceptable commit, so the exemption would have shipped untested and unexercised.
	for _, pending := range outstanding {
		if pending.Origin != 0 || pending.VoidAt != nil {
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
			// Clause 3: every member-originated Remove targets the committer's own user.
			if a.SenderLeaf == nil || a.TargetLeaf == nil {
				continue // an instance Remove, which invariant 6 governs instead
			}
			target, err := d.userOfLeaf(ctx, groupID, *a.TargetLeaf)
			if err != nil {
				return err
			}
			if target != s.UserID {
				return errCommitInvalid("member_remove_scope",
					"a member-originated Remove may only target the committer's own user")
			}
		case mlswasi.ProposalAdd:
			// Clause 4: the added KeyPackage validates, its user is eligible and its DSK is in
			// the newest device list.
			if err := d.checkAddedMember(ctx, groupID, a); err != nil {
				return err
			}
		}
	}
	if o.external {
		// R25 — an external commit may remove nobody but the joiner's own prior leaf — is task
		// 25's `checkExternalCommitScope`, called from here. Task 20 sets `external` nowhere, so
		// the clause has no reachable caller yet and is not stubbed out permissively.
		return errCommitInvalid("external_commit_scope",
			"external commits are not accepted by this instance yet")
	}
	return nil
}

// checkAddedMember validates one Add's credential against the device list the delivery service
// holds and the channel ACL.
func (d *DS) checkAddedMember(ctx context.Context, groupID id.ID, a mlswasi.AppliedProposal) error {
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
	entries, err := d.opts.DeviceLists.Entries(ctx, userID)
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
	if groupKind == 1 { // call
		return d.opts.Policy.ProposalTTLCall
	}
	return d.opts.Policy.ProposalTTLText
}
