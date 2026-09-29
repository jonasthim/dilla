package ds

import (
	"bytes"
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// maxHealTail is how many handshakes a healing member may upload. Clients keep the last 64 per
// group (protocol/02, "Retention"), so 64 is both the client's buffer and the server's bound.
const maxHealTail = 64

type HealStatus struct {
	Epoch       uint64
	NextSeq     uint64
	Generation  uint64
	NeedFromSeq uint64
}

type HealTailItem struct {
	Seq    uint64
	Epoch  uint64
	Kind   uint8
	Sender *uint32
	Blob   []byte
}

type HealRequest struct {
	GroupInfo   []byte
	Tail        []HealTailItem
	RatchetTree []byte
}

// OnRestore is invariant 11's first half. It runs once, after `dillad restore` has replaced the
// database, and it is deliberately loud: everything it does is visible to every client on its next
// request, through the generation.
//
// The `generation` parameter is the generation the caller wants the instance to be at — `dillad
// restore` passes the one it read out of the backup's manifest. It is honoured, not ignored: a
// blind `BumpGeneration` would silently disregard a caller that named a specific value. Passing 0
// means "just bump". `SetGeneration` is monotone in SQL, so a manifest older than the instance's
// own generation cannot walk the number backwards and revive the resume tokens an earlier restore
// already killed.
func (d *DS) OnRestore(ctx context.Context, generation uint64) error {
	if generation != 0 {
		if err := d.opts.Store.SetGeneration(ctx, generation); err != nil {
			return err
		}
	} else if _, err := d.opts.Store.BumpGeneration(ctx); err != nil {
		return err
	}
	deadline := d.opts.Clock.Now().Add(d.opts.Policy.HealWindow).Unix()

	// Both bulk writes are single statements, not a per-group loop: OnRestore runs once and
	// correctness, not latency, governs it, and a paged loop that stopped at a fixed batch would
	// leave every group past the batch serving state the restored database no longer matches.
	// `MarkAllGroupsEpochUnknown` and `EndAllVoiceSessions` are the shapes Plan 2 records as
	// P2-D19 for the same invariant-11 work; part 1b uses them and adds them to `store.MLS`
	// (deviation B13) so the two plans declare one surface instead of two.
	if err := d.opts.Store.MarkAllGroupsEpochUnknown(ctx, deadline); err != nil {
		return err
	}
	if err := d.opts.Store.EndAllVoiceSessions(ctx, d.now()); err != nil {
		return err
	}

	// Every cached handle from before the restore describes a group state the database no longer
	// holds. Dropping the whole cache is one call and cannot miss a group.
	if err := d.states.closeAll(ctx); err != nil {
		return err
	}
	// All non-last-resort KeyPackages are purged: whatever was published before the restore may
	// already have been consumed by a client the backup does not know about.
	if _, err := d.opts.Store.PurgeKeyPackages(ctx, true); err != nil {
		return err
	}

	// "every response carries the new generation" reaches the WEBSOCKET only through this call.
	// `gateway.Options.Generation` is read once at construction, so without it a restored instance
	// would keep greeting clients with the old number and — worse — keep ACCEPTING resume tokens
	// minted before the restore, replaying a ring of frames about epochs it no longer holds to a
	// client that never learned the database changed underneath it. The SQL read below is what
	// makes the published number the one that actually landed, monotone clamp included.
	if d.opts.Gateway != nil {
		inst, err := d.opts.Store.GetInstance(ctx)
		if err != nil {
			return err
		}
		d.opts.Gateway.SetGeneration(inst.Generation)
	}
	return nil
}

// HealStatus tells a member what the instance still needs.
//
// It is member-only, like every other group-scoped read: a caller whose device is not a member is
// answered E_NOT_FOUND, so neither the group's existence nor its epoch, high-water and generation
// can be probed by any enrolled device on the instance (`requireMember`'s own comment).
func (d *DS) HealStatus(ctx context.Context, s Session, groupID id.ID) (HealStatus, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return HealStatus{}, errNotFound("group")
	}
	if err != nil {
		return HealStatus{}, err
	}
	if err := d.requireMember(ctx, groupID, s); err != nil {
		return HealStatus{}, err
	}
	instance, err := d.opts.Store.GetInstance(ctx)
	if err != nil {
		return HealStatus{}, err
	}
	return HealStatus{
		Epoch:       row.Epoch,
		NextSeq:     row.Seq + 1,
		Generation:  instance.Generation,
		NeedFromSeq: row.Seq + 1,
	}, nil
}

// Heal is invariant 11's second half. The instance rebuilds its PublicGroup from its OWN restored
// state blob and replays the member's tail through it; it adopts the result only when its stored
// epoch is <= the uploaded GroupInfo's epoch, the tail replays cleanly, and the GroupInfo's
// tree_hash equals the rebuilt tree's.
//
// The reseed path is the one exception: when the instance holds no usable blob, the healing member
// uploads the ratchet tree in the same request and the instance reseeds from it. That is the one
// upload where the tree is allowed, because the instance has none, and RFC 9420 §12.4.3.3's signed
// tree_hash is what makes that source safe.
//
// Heal is NOT a second commit path. It is refused unless a restore has marked the group
// epoch-unknown and the heal window is still open, and every commit the tail replays passes
// invariant 4's clauses (`checkHealedCommit`) before it is merged. Without both, any enrolled
// member could merge an Add the channel ACL refuses by uploading it as a one-item "tail" together
// with a GroupInfo it signs itself for the result — every adoption check below only proves that
// the member built the state it claims.
func (d *DS) Heal(ctx context.Context, s Session, groupID id.ID, h HealRequest) (CommitResult, error) {
	if len(h.Tail) > maxHealTail {
		return CommitResult{}, errInvalid("the handshake tail carries more than 64 items")
	}
	if s.Scope != auth.ScopeEnrolled {
		return CommitResult{}, errForbidden("a heal needs an enrolled session")
	}
	unlock := d.lock(groupID)
	defer unlock()

	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return CommitResult{}, errNotFound("group")
	}
	if err != nil {
		return CommitResult{}, err
	}
	if err := d.checkHealState(row); err != nil {
		return CommitResult{}, err
	}

	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return CommitResult{}, err
	}
	release := true
	defer func() {
		if release {
			inst.Release()
		}
	}()

	var group *mlswasi.PublicGroup
	reseeded := false
	switch {
	case len(row.PublicGroupState) > 0:
		group, err = inst.PublicGroupImport(ctx, row.PublicGroupState, groupID[:])
		if err != nil {
			return CommitResult{}, errCommitInvalid("state",
				"the restored state blob does not import: "+err.Error())
		}
	case len(h.RatchetTree) > 0:
		group, err = inst.PublicGroupFromExternal(ctx, h.RatchetTree, h.GroupInfo)
		if err != nil {
			return CommitResult{}, errCommitInvalid("reseed", err.Error())
		}
		reseeded = true
	default:
		return CommitResult{}, errCommitInvalid("reseed",
			"the instance holds no state for this group and the request carries no ratchet tree")
	}
	// The handle belongs to this call until it is either installed in the cache or dropped. A
	// refusal below that returned without closing it would leak one PublicGroup inside the guest
	// for every rejected heal, and the instance it lives in goes back to the pool holding it.
	closeGroup := true
	defer func() {
		if closeGroup {
			_ = group.Close(ctx)
		}
	}()

	base, err := group.State(ctx)
	if err != nil {
		return CommitResult{}, err
	}
	// Replay the tail. Every item the rebuilt group does not already hold is processed, checked
	// and merged (or queued) in order; a gap or a rejection is a refusal, not a partial adoption.
	replayed, err := d.replayHealTail(ctx, groupID, group, healBase{
		seq: row.Seq, epoch: base.Epoch, reseeded: reseeded,
	}, h.Tail)
	if err != nil {
		return CommitResult{}, err
	}

	state, err := group.State(ctx)
	if err != nil {
		return CommitResult{}, err
	}
	// The uploaded GroupInfo is the member's claim; its signature, epoch and tree hash are what
	// make the claim checkable. The signer is the leaf the GroupInfo names, which the DS now has
	// in its own rebuilt tree.
	signer, err := d.signerLeafOf(s.DeviceID, state)
	if err != nil {
		return CommitResult{}, err
	}
	check, err := group.ValidateGroupInfo(ctx, h.GroupInfo, signer)
	if err != nil {
		return CommitResult{}, errCommitInvalid("group_info", err.Error())
	}
	if !check.SignatureOK {
		return CommitResult{}, errCommitInvalid("group_info_signature",
			"the healing GroupInfo is not member-signed")
	}
	if !bytes.Equal(check.GroupID, groupID[:]) {
		return CommitResult{}, errCommitInvalid("group_info",
			"the healing GroupInfo names another group")
	}
	if check.Epoch < row.Epoch {
		return CommitResult{}, errCommitInvalid("heal_epoch",
			"the uploaded GroupInfo is older than the instance's own stored epoch")
	}
	if !bytes.Equal(check.TreeHash, state.TreeHash) {
		return CommitResult{}, errCommitInvalid("tree_hash",
			"the rebuilt tree does not match the GroupInfo's tree_hash")
	}

	// The replayed tail is APPENDED to mls_handshakes and the group's high-water advances with it.
	// Without this the group is healed for the one device that uploaded the tail and permanently
	// behind for everyone else: every other member catches up with
	// `GET /handshakes?from=<its cursor>` and would receive nothing for the epochs the instance
	// just adopted, while the response's `next_seq` still reported the pre-heal high-water.
	//
	// Every column is what the REPLAY derived, never what the member claimed: `GetCommitAtEpoch`
	// selects on kind and epoch to name a winning commit, the catch-up serves both to every other
	// member, and invariant 9 quarantines the SenderDevice of a reported commit. An item the
	// restored log already holds (its seq is at or below the restored high-water) is not written a
	// second time.
	var high uint64
	var members memberView
	err = d.opts.Store.Tx(ctx, func(tx store.Repository) error {
		high = row.Seq
		for _, r := range replayed {
			if r.item.Seq <= row.Seq {
				continue // already in the restored log
			}
			seq, err := nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID:      groupID,
				Seq:          seq,
				Epoch:        r.epoch,
				Kind:         r.kind,
				SenderLeaf:   r.senderLeaf,
				SenderDevice: r.senderDevice,
				Blob:         r.item.Blob,
				Created:      d.now(),
			}); err != nil {
				return err
			}
			high = seq
		}
		if err := persistState(ctx, tx, groupID, group, h.GroupInfo); err != nil {
			return err
		}
		var mErr error
		if members, mErr = d.replaceMembersTx(ctx, tx, groupID, state); mErr != nil {
			return mErr
		}
		return tx.ClearEpochUnknown(ctx, groupID)
	})
	if err != nil {
		return CommitResult{}, err
	}

	// The member set the heal adopted is the one invariant 7 elects a committer over and the one
	// every fan-out addresses. Register republishes both after it writes `mls_members`, and a heal
	// that did not would leave the gateway electing devices the rebuilt tree no longer holds.
	if d.opts.Gateway != nil {
		d.opts.Gateway.SetGroupMembers(groupID, members.devices)
		d.opts.Gateway.SetGroupLeaves(groupID, members.leaves)
	}

	if err := d.states.put(ctx, groupID, inst, group); err != nil {
		return CommitResult{}, err
	}
	release = false
	closeGroup = false

	// §2.5's POST /heal response is [epoch, next_seq], so the result carries the NEW high-water.
	return CommitResult{Seq: high, Epoch: state.Epoch}, nil
}

// checkHealState is the gate that keeps Heal the post-restore path it is written for. protocol/02
// invariant 11 defines the heal over a group a restore made epoch-unknown, inside the 24-hour
// window; outside that state the one way to move a group's epoch is POST /commit, with invariants
// 3, 4 and 5 in front of it.
func (d *DS) checkHealState(row store.GroupRow) error {
	if row.ClosedAt != nil {
		return errCommitInvalid("heal_state", "the group is closed")
	}
	if !row.EpochUnknown {
		return errCommitInvalid("heal_state",
			"the group is not awaiting a heal: no restore has marked it epoch-unknown")
	}
	if row.HealDeadline != nil && d.now() >= *row.HealDeadline {
		return errCommitInvalid("heal_state", "the heal window has closed")
	}
	return nil
}

// healBase is what the rebuilt group already holds before the tail is replayed.
type healBase struct {
	seq      uint64 // the restored log's high-water
	epoch    uint64 // the rebuilt group's epoch
	reseeded bool   // built from the member's tree rather than the instance's own blob
}

// healTailAlreadyApplied reports whether the rebuilt group already holds the item, so replaying
// it would be a wrong-epoch (or duplicate) refusal of a legitimate heal.
//
// On the blob path the restored blob covers exactly the log up to its high-water, so the answer is
// the item's seq. On the RESEED path the group was built from the member's tree at the uploaded
// GroupInfo's epoch — the member's tip — so every item for an EARLIER epoch is already baked into
// it, whatever its seq; an item at the tip epoch (a proposal the tip has not committed yet) is not.
// A member that misstates an item's epoch or seq gains nothing: an item it hides is simply not
// replayed or appended, and one it misplaces fails to process.
func healTailAlreadyApplied(item HealTailItem, b healBase) bool {
	if b.reseeded {
		return item.Epoch < b.epoch
	}
	return item.Seq <= b.seq
}

// healReplayed is one tail item as the replay saw it: every field but the item itself is derived
// by the guest or from the tree, never taken from the member's upload.
type healReplayed struct {
	item         HealTailItem
	epoch        uint64
	kind         uint8
	senderLeaf   *uint32
	senderDevice *id.ID
}

// leafIdentity is the device and user behind one leaf, read from the leaf's own credential.
type leafIdentity struct {
	device id.ID
	user   id.ID
}

func leafIdentities(state mlswasi.GroupState) map[uint32]leafIdentity {
	out := make(map[uint32]leafIdentity, len(state.Members))
	for _, m := range state.Members {
		device, user, err := decodeCredentialIdentity(m.CredentialIdentity)
		if err != nil {
			continue
		}
		out[m.LeafIndex] = leafIdentity{device: device, user: user}
	}
	return out
}

func deviceAtLeaf(leaves map[uint32]leafIdentity, leaf *uint32) *id.ID {
	if leaf == nil {
		return nil
	}
	who, ok := leaves[*leaf]
	if !ok {
		return nil
	}
	device := who.device
	return &device
}

// replayHealTail processes every tail item the rebuilt group does not already hold, in order.
//
// A proposal is queued in the guest, not merely processed: `Process` writes nothing, and a later
// commit in the same tail that references the proposal by ref would otherwise fail to process —
// and the healed state would be missing a proposal the members hold. A commit goes through
// `replayHealCommit`, which checks it before it merges it.
func (d *DS) replayHealTail(ctx context.Context, groupID id.ID, g *mlswasi.PublicGroup, b healBase, tail []HealTailItem) ([]healReplayed, error) {
	out := make([]healReplayed, 0, len(tail))
	for _, item := range tail {
		if healTailAlreadyApplied(item, b) {
			continue
		}
		before, err := g.State(ctx)
		if err != nil {
			return nil, err
		}
		leaves := leafIdentities(before)
		processed, err := g.Process(ctx, item.Blob)
		if err != nil {
			return nil, errCommitInvalid("tail", err.Error())
		}
		switch processed.Kind {
		case mlswasi.KindProposal, mlswasi.KindExternalJoin:
			if _, err := g.ProposalPut(ctx, 0, item.Blob); err != nil {
				return nil, errCommitInvalid("tail", err.Error())
			}
			out = append(out, healReplayed{
				item:         item,
				epoch:        processed.Epoch,
				kind:         handshakeProposal,
				senderLeaf:   processed.SenderLeaf,
				senderDevice: deviceAtLeaf(leaves, processed.SenderLeaf),
			})
		case mlswasi.KindCommit:
			r, err := d.replayHealCommit(ctx, groupID, g, leaves, processed)
			if err != nil {
				return nil, err
			}
			r.item = item
			out = append(out, r)
		default:
			return nil, errCommitInvalid("tail", "the tail carries a message the group rejects")
		}
	}
	return out, nil
}

// replayHealCommit is invariant 4 over one replayed commit, then the merge.
//
// The clauses that are about the commit's CONTENT run here exactly as the commit path runs them:
// no Update from the committer, a member-originated Remove only of the committer's own user, every
// Add's device known, unrevoked, in its user's newest signed device list and eligible under the
// channel ACL, and an external commit's Remove only of the joiner's own previous leaf. The
// identities come from the rebuilt tree as it stood before the commit — the committer is whoever
// signed it, not the device uploading the heal, and `mls_members` describes the restored epoch,
// not the one the replay has reached.
//
// Clause 1 (every outstanding instance proposal is referenced) and invariant 5's freeze are NOT
// re-run: both are judged against the instance's live proposal queue at the moment of the original
// commit, and the restored database's queue describes the backup's epoch, not the ones the tail
// crosses. A replayed commit that legitimately omitted a proposal voided after the backup would be
// refused by them.
func (d *DS) replayHealCommit(ctx context.Context, groupID id.ID, g *mlswasi.PublicGroup, leaves map[uint32]leafIdentity, p mlswasi.Processed) (healReplayed, error) {
	if p.Staged == nil {
		return healReplayed{}, errCommitInvalid("tail", "a commit in the tail did not stage")
	}
	merged := false
	defer func() {
		if !merged {
			if derr := g.Discard(ctx, *p.Staged); derr != nil {
				d.log().Warn("discarding a refused heal commit failed", "group", groupID, "err", derr)
			}
		}
	}()
	if err := d.checkHealedCommit(ctx, g, groupID, leaves, p); err != nil {
		return healReplayed{}, err
	}
	epoch, err := g.Merge(ctx, *p.Staged)
	if err != nil {
		return healReplayed{}, errCommitInvalid("tail", err.Error())
	}
	merged = true

	r := healReplayed{epoch: epoch, senderLeaf: p.SenderLeaf}
	if p.SenderLeaf != nil {
		r.kind = handshakeCommit
		r.senderDevice = deviceAtLeaf(leaves, p.SenderLeaf)
		return r, nil
	}
	r.kind = handshakeExternalCommit
	after, err := g.State(ctx)
	if err != nil {
		return healReplayed{}, err
	}
	joiner, err := d.checkHealedExternalCommit(ctx, g, groupID, leaves, after, p.Applied)
	if err != nil {
		return healReplayed{}, err
	}
	r.senderDevice = &joiner
	return r, nil
}

// checkHealedCommit is invariant 4's content clauses over one replayed commit, before its merge.
// The clause numbers are protocol/02's, as in `checkAppliedProposals`.
func (d *DS) checkHealedCommit(ctx context.Context, g DeviceListVerifier, groupID id.ID, leaves map[uint32]leafIdentity, p mlswasi.Processed) error {
	var committer *leafIdentity
	if p.SenderLeaf != nil {
		who, ok := leaves[*p.SenderLeaf]
		if !ok {
			return errCommitInvalid("structural", "a commit in the tail names a leaf the group does not hold")
		}
		committer = &who
	}
	for _, a := range p.Applied {
		switch a.Kind {
		case mlswasi.ProposalUpdate:
			// Clause 2: no Update from the committer.
			if a.SenderLeaf != nil && p.SenderLeaf != nil && *a.SenderLeaf == *p.SenderLeaf {
				return errCommitInvalid("committer_update", "the commit carries the committer's own Update")
			}
		case mlswasi.ProposalRemove:
			// Clause 3: every member-originated Remove targets the committer's own user. An
			// instance Remove (no sender leaf) is invariant 6's, and an external commit's own
			// Remove is checked after the merge, where the joiner can be seen.
			if a.SenderLeaf == nil || a.TargetLeaf == nil || committer == nil {
				continue
			}
			target, ok := leaves[*a.TargetLeaf]
			if !ok || target.user != committer.user {
				return errCommitInvalid("member_remove_scope",
					"a member-originated Remove may only target the committer's own user")
			}
		case mlswasi.ProposalAdd:
			// Clause 4: the added device is known, unrevoked, listed and eligible.
			if err := d.checkAddedMember(ctx, g, groupID, a); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkHealedExternalCommit is R25's scope clause over a replayed external commit, and returns the
// joining device. An external commit adds exactly one leaf, the joiner's: on a resync it also
// Removes that same device's previous leaf, so a removed device must be back in the tree after the
// merge; on a fresh join nothing is removed and the joiner is the one device the merge added,
// which must pass the same eligibility clause an Add does.
func (d *DS) checkHealedExternalCommit(ctx context.Context, g DeviceListVerifier, groupID id.ID, before map[uint32]leafIdentity, after mlswasi.GroupState, applied []mlswasi.AppliedProposal) (id.ID, error) {
	present := make(map[id.ID]struct{}, len(before))
	for _, who := range before {
		present[who.device] = struct{}{}
	}
	now := make(map[id.ID][]byte, len(after.Members))
	for _, m := range after.Members {
		device, _, err := decodeCredentialIdentity(m.CredentialIdentity)
		if err != nil {
			continue
		}
		now[device] = m.CredentialIdentity
	}

	var joiner id.ID
	found := false
	for _, a := range applied {
		if a.Kind != mlswasi.ProposalRemove || a.TargetLeaf == nil {
			continue
		}
		target, ok := before[*a.TargetLeaf]
		if _, back := now[target.device]; !ok || !back || (found && target.device != joiner) {
			return id.ID{}, errCommitInvalid("external_commit_remove_scope",
				"an external commit may only Remove the joining device's own previous leaf")
		}
		joiner, found = target.device, true
	}
	if found {
		return joiner, nil
	}

	var added []id.ID
	for device := range now {
		if _, was := present[device]; !was {
			added = append(added, device)
		}
	}
	if len(added) != 1 {
		return id.ID{}, errCommitInvalid("structural", "an external commit must add exactly one device")
	}
	if err := d.checkAddedMember(ctx, g, groupID, mlswasi.AppliedProposal{
		Kind: mlswasi.ProposalAdd, CredentialIdentity: now[added[0]],
	}); err != nil {
		return id.ID{}, err
	}
	return added[0], nil
}

// signerLeafOf is the leaf the healing device occupies in the rebuilt tree.
func (d *DS) signerLeafOf(deviceID id.ID, state mlswasi.GroupState) (uint32, error) {
	for _, m := range state.Members {
		device, _, err := decodeCredentialIdentity(m.CredentialIdentity)
		if err != nil {
			continue
		}
		if device == deviceID {
			return m.LeafIndex, nil
		}
	}
	return 0, errForbidden("the healing device is not a member of the rebuilt tree")
}

// closeUnhealedGroups runs on the sweeper: a group that has not been healed within the heal window
// is closed, and the channel owner's device re-creates it.
//
// It PAGES to completion, like every other sweeper in this plan: a fixed batch from the zero id
// would leave a group beyond the batch un-closed forever, still serving state the restored
// database no longer matches.
//
// The cursor advances on every row, closed or not: `ListOpenGroups` filters on `closed_at IS NULL`,
// so a page whose groups this pass closes would otherwise be a page the NEXT query no longer
// returns while `after` still pointed before it — and the loop would re-read the same window
// forever on an instance with more unhealed groups than one page.
func (d *DS) closeUnhealedGroups(ctx context.Context) error {
	now := d.now()
	after := id.ID{}
	for {
		groups, err := d.opts.Store.ListOpenGroups(ctx, after, sweepPage)
		if err != nil {
			return err
		}
		if len(groups) == 0 {
			return nil
		}
		for _, g := range groups {
			after = g.GroupID
			if !g.EpochUnknown || g.HealDeadline == nil || now < *g.HealDeadline {
				continue
			}
			if err := d.Close(ctx, g.GroupID); err != nil {
				return err
			}
			d.log().Warn("group closed: no heal within the window", "group", g.GroupID.String()[:8])
		}
		if len(groups) < sweepPage {
			return nil
		}
	}
}
