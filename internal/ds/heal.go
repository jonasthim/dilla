package ds

import (
	"bytes"
	"context"
	"errors"

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
func (d *DS) HealStatus(ctx context.Context, groupID id.ID) (HealStatus, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return HealStatus{}, errNotFound("group")
	}
	if err != nil {
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
func (d *DS) Heal(ctx context.Context, s Session, groupID id.ID, h HealRequest) (CommitResult, error) {
	if len(h.Tail) > maxHealTail {
		return CommitResult{}, errInvalid("the handshake tail carries more than 64 items")
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

	// Replay the tail. Every item is processed and merged in order; a gap or a rejection is a
	// refusal, not a partial adoption.
	for _, item := range h.Tail {
		if healTailAlreadyApplied(item, row) {
			continue // already applied before the backup was taken
		}
		processed, err := group.Process(ctx, item.Blob)
		if err != nil {
			return CommitResult{}, errCommitInvalid("tail", err.Error())
		}
		if processed.Staged == nil {
			continue // a proposal: queued, not merged
		}
		if _, err := group.Merge(ctx, *processed.Staged); err != nil {
			return CommitResult{}, errCommitInvalid("tail", err.Error())
		}
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
	var high uint64
	var members memberView
	err = d.opts.Store.Tx(ctx, func(tx store.Repository) error {
		high = row.Seq
		for _, item := range h.Tail {
			if healTailAlreadyApplied(item, row) {
				continue // already in the log before the backup was taken
			}
			seq, err := nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID:    groupID,
				Seq:        seq,
				Epoch:      item.Epoch,
				Kind:       item.Kind,
				SenderLeaf: item.Sender,
				Blob:       item.Blob,
				Created:    d.now(),
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

// healTailAlreadyApplied reports whether the instance's own restored state already covers the
// item. It is one function because the replay loop and the append loop must agree exactly: a
// predicate that drifted between them would either replay a handshake the blob already holds
// (which the guest refuses, turning a legitimate heal into E_COMMIT_INVALID) or write a row for an
// epoch it never replayed.
//
// The blob check is the second half for a reason: on the RESEED path the instance holds no state
// at all, so nothing in the tail has been applied and every item must be replayed, whatever its
// seq claims.
func healTailAlreadyApplied(item HealTailItem, row store.GroupRow) bool {
	return item.Seq <= row.Seq && len(row.PublicGroupState) > 0
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
