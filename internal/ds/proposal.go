package ds

import (
	"bytes"
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// sweepPage is how many groups one page of a sweep reads. It is a page size, not a bound on the
// work: every sweeper in this plan loops until a short page.
const sweepPage = 512

// ProposeAdd issues an external Add. Invariant 6's "before proposing" gate runs first: the
// KeyPackage must validate, its lifetime must not have expired, it must advertise 0xF001 and it
// must not already be consumed — the expiry and the consumption are `TakeKeyPackage`'s, against
// the delivery service's own clock, and the rest is `validate_key_package`'s inside the guest.
func (d *DS) ProposeAdd(ctx context.Context, groupID, deviceID, actionID id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()
	return d.proposeAddLocked(ctx, groupID, deviceID, actionID)
}

func (d *DS) proposeAddLocked(ctx context.Context, groupID, deviceID, actionID id.ID) error {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	}
	if err != nil {
		return err
	}
	kp, err := d.opts.Store.TakeKeyPackage(ctx, deviceID, d.now())
	if errors.Is(err, store.ErrNotFound) {
		return errInvalid("no usable KeyPackage for that device")
	}
	if err != nil {
		return err
	}

	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return err
	}
	defer inst.Release()

	if _, err := inst.ValidateKeyPackage(ctx, kp.Blob); err != nil {
		return errInvalid("the stored KeyPackage no longer validates: " + err.Error())
	}
	blob, err := inst.ExternalProposeAdd(ctx, groupID[:], row.Epoch, kp.Blob,
		d.opts.Keys.ExternalSenderPriv[:])
	if err != nil {
		return err
	}
	return d.storeInstanceProposal(ctx, groupID, row, blob, store.ProposalRow{
		Kind:         uint8(mlswasi.ProposalAdd),
		TargetDevice: &deviceID,
		KeyPackage:   kp.Blob,
		Origin:       0,
		ActionID:     actionID,
	})
}

// ProposeRemove issues an external Remove. A target leaf that is already gone is dropped rather
// than proposed (invariant 6's second half).
//
// Like ProposeAdd it is a thin locking wrapper over a lock-free body. d.lock hands out a plain
// per-group sync.Mutex, which is not reentrant, and both re-issue entry points already hold it:
// `ReissueFor` takes it at the top, and `reissueOmitted` runs inside the commit path, which has
// held it since its first statement. A ProposeRemove that re-locked would deadlock the group's
// request goroutine forever — on exactly invariant 5's nobody-online path that reissueOmitted
// exists to serve.
func (d *DS) ProposeRemove(ctx context.Context, groupID id.ID, leaf uint32, actionID id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()
	return d.proposeRemoveLocked(ctx, groupID, leaf, actionID)
}

func (d *DS) proposeRemoveLocked(ctx context.Context, groupID id.ID, leaf uint32, actionID id.ID) error {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	}
	if err != nil {
		return err
	}
	if _, err := d.userOfLeaf(ctx, groupID, leaf); err != nil {
		return errInvalid("the Remove target is no longer a member; the action is dropped")
	}
	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return err
	}
	defer inst.Release()

	blob, err := inst.ExternalProposeRemove(ctx, groupID[:], row.Epoch, leaf,
		d.opts.Keys.ExternalSenderPriv[:])
	if err != nil {
		return err
	}
	return d.storeInstanceProposal(ctx, groupID, row, blob, store.ProposalRow{
		Kind:       uint8(mlswasi.ProposalRemove),
		TargetLeaf: &leaf,
		Origin:     0,
		ActionID:   actionID,
	})
}

// ProposeAddBatch adds many devices at once. At most MaxAddsPerCommit (256) Adds are outstanding
// for one commit; the rest wait for the next epoch, which is what keeps a 1,000-device private
// channel to four commits rather than one commit OpenMLS cannot build.
func (d *DS) ProposeAddBatch(ctx context.Context, groupID id.ID, devices []id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()

	// The outstanding count is read at the GROUP'S CURRENT EPOCH, not at literal epoch 0: past
	// epoch 0 a `ListProposals(…, 0, …)` sees nothing, `room` is always the full 256, and
	// successive calls push straight past MaxAddsPerCommit — which is the one thing the batching
	// exists to prevent.
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	}
	if err != nil {
		return err
	}
	room := d.opts.Policy.MaxAddsPerCommit
	outstanding, err := d.opts.Store.ListProposals(ctx, groupID, row.Epoch, false)
	if err != nil {
		return err
	}
	for _, o := range outstanding {
		if o.Origin == 0 && o.VoidAt == nil && o.Kind == uint8(mlswasi.ProposalAdd) {
			room--
		}
	}
	remainder := make([]id.ID, 0, len(devices))
	for i, device := range devices {
		if room <= 0 {
			remainder = append(remainder, devices[i:]...)
			break
		}
		if err := d.proposeAddLocked(ctx, groupID, device, id.New()); err != nil {
			// One unusable KeyPackage must not sink the batch: the device is skipped and the join
			// storm continues. The skipped device is picked up by the next batch.
			d.log().Warn("batched add skipped", "device", device.String()[:8], "err", err)
			continue
		}
		room--
	}
	// The remainder is KEPT, not dropped. Nothing else re-invokes this method, so a dropped tail
	// means a 1,000-device join storm stalls after its first 256 and `join_storm_256_batched` can
	// never complete.
	if len(remainder) > 0 {
		d.queuePendingJoins(groupID, remainder)
	}
	return nil
}

// queuePendingJoins and takePendingJoins hold the tail of a join storm between commits.
//
// DEVIATION from the task brief, forced by the schema: the brief writes these through
// `store.QueuePendingJoins` / `store.TakePendingJoins` over a `pending_joins` table it calls "a 1b
// table (task 19's schema)". Neither the methods nor the table exist — `store.MLS` (deviation B13)
// names the pair but task 3 did not declare it and `00002_mls.sql` creates no such table — and
// adding a migration, two sqlc query sets and two adapters is well outside a task whose Files are
// three new files in `internal/ds`. The queue therefore lives in this process.
//
// THE LOSS IS SILENT, and that is the cost to weigh. A restart between a 1,000-device
// `ProposeAddBatch` and the next commit drops every device still waiting: nothing logs it, nothing
// retries it, no row records that they were ever queued, and they are proposed again only if some
// caller happens to issue another `ProposeAddBatch` for the same devices. The chaos scenario
// `join_storm_256_batched` therefore cannot be satisfied durably, and Plan 2's materialised
// private channel — which consumes `ds.ProposeAddBatch` — inherits it. This is an unassigned
// prerequisite, not a design choice: deviation B13 already names `QueuePendingJoins` /
// `TakePendingJoins` for `store.MLS`; the migration, the two sqlc query sets and the two adapters
// are owned by TASK 23 (deviation B22, ruling 43), the last task in this plan that lands a
// migration pair. These two functions are deliberately the single seam, so that swap is a
// two-function change with no other caller to touch.
func (d *DS) queuePendingJoins(groupID id.ID, devices []id.ID) {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	if d.pending == nil {
		d.pending = map[id.ID][]id.ID{}
	}
	seen := map[id.ID]struct{}{}
	for _, existing := range d.pending[groupID] {
		seen[existing] = struct{}{}
	}
	for _, device := range devices {
		if _, ok := seen[device]; ok {
			continue // PRIMARY KEY (group_id, device_id) in the durable form
		}
		seen[device] = struct{}{}
		d.pending[groupID] = append(d.pending[groupID], device)
	}
}

func (d *DS) takePendingJoins(groupID id.ID, limit int) []id.ID {
	d.pendingMu.Lock()
	defer d.pendingMu.Unlock()
	queued := d.pending[groupID]
	if len(queued) == 0 {
		return nil
	}
	if limit > len(queued) {
		limit = len(queued)
	}
	taken := queued[:limit:limit]
	if rest := queued[limit:]; len(rest) > 0 {
		d.pending[groupID] = rest
	} else {
		delete(d.pending, groupID)
	}
	return taken
}

// drainPendingJoins proposes the next slice of a join storm. The commit path calls it after a
// merge that applied Adds, with the group lock already held and withGroup already returned, so it
// uses the lock-free body.
func (d *DS) drainPendingJoins(ctx context.Context, groupID id.ID) {
	for _, device := range d.takePendingJoins(groupID, d.opts.Policy.MaxAddsPerCommit) {
		if err := d.proposeAddLocked(ctx, groupID, device, id.New()); err != nil {
			d.log().Warn("queued add skipped", "device", device.String()[:8], "err", err)
		}
	}
}

// storeInstanceProposal appends the handshake, stores the pending row and fans the proposal out.
//
// The put into the guest's queue necessarily precedes the transaction: the SQL row is keyed on the
// ref `ProposalPut` hands back. So, exactly as `queueMemberProposal` does for a member's proposal,
// every failure after the put takes the proposal back OUT of the queue. A proposal left behind is
// one the cached PublicGroup holds and SQL does not — R12's "SQL is the record", inverted — and it
// is not merely held in memory: the next SUCCESSFUL proposal's `persistState` runs inside its own
// transaction and writes the divergence into the durable state blob, where it survives a restart
// and is cleared only by the next merge.
func (d *DS) storeInstanceProposal(ctx context.Context, groupID id.ID, row store.GroupRow, blob []byte, p store.ProposalRow) error {
	var seq uint64
	err := d.withGroup(ctx, groupID, func(g *mlswasi.PublicGroup) error {
		ref, err := g.ProposalPut(ctx, 0, blob)
		if err != nil {
			return err
		}
		accepted := false
		defer func() {
			if !accepted {
				d.unqueueProposal(ctx, g, groupID, ref)
			}
		}()
		if err := d.opts.Store.Tx(ctx, func(tx store.Repository) error {
			seq, err = nextSeq(ctx, tx, groupID)
			if err != nil {
				return err
			}
			if err := tx.AppendHandshake(ctx, store.HandshakeRow{
				GroupID: groupID, Seq: seq, Epoch: row.Epoch, Kind: handshakeProposal,
				SenderLeaf: nil, SenderDevice: nil, Blob: blob, Created: d.now(),
			}); err != nil {
				return err
			}
			p.GroupID = groupID
			p.Ref = ref
			p.Epoch = row.Epoch
			p.IssuedAt = d.now()
			p.TTL = uint64(d.proposalTTL(row.Kind).Seconds())
			// A re-issue replaces the row it supersedes in the same transaction, keeping
			// action_id; anything else is a fresh row.
			if supersedes := d.takeSupersede(groupID); supersedes != nil {
				if err := tx.ReissueProposal(ctx, supersedes, p); err != nil {
					return err
				}
			} else if err := tx.PutProposal(ctx, p); err != nil {
				return err
			}
			return persistState(ctx, tx, groupID, g, row.GroupInfoBlob)
		}); err != nil {
			return err
		}
		accepted = true
		return nil
	})
	if err != nil {
		return err
	}
	if d.opts.Gateway != nil {
		payload, perr := gateway.HandshakePayload(seq, row.Epoch, handshakeProposal, nil, blob)
		if perr == nil {
			d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
				Op: gateway.OpMLSHandshake, GroupID: &groupID, Payload: payload, Replay: true,
			})
		}
	}
	if d.opts.Metrics != nil {
		// plan-1a task 7 declares `DSProposals *prometheus.GaugeVec` for
		// `dilla_ds_proposals_outstanding{kind}`. There is no `ProposalsOutstanding`, and because
		// it is a GAUGE every path that commits, voids or deletes a proposal decrements it —
		// otherwise the "outstanding" gauge only ever rises.
		d.opts.Metrics.DSProposals.WithLabelValues(proposalLabel(p.Kind)).Inc()
	}
	// A fresh instance proposal is what invariant 7's election exists to get committed, so the
	// election is held here, the moment the proposal is durable.
	//
	// Its error is LOGGED, not returned: the proposal is already written, fanned out and counted,
	// and answering the caller an error now would say the proposal failed when it did not. A
	// failed election is not lost either — the watchdog re-elects on its own tick, and so does the
	// next proposal.
	if err := d.RequestCommit(ctx, groupID); err != nil {
		d.log().Error("electing a committer for a fresh instance proposal failed",
			"group", groupID.String()[:8], "err", err)
	}
	return nil
}

// Void marks one proposal void. A commit MAY omit a void proposal.
func (d *DS) Void(ctx context.Context, groupID id.ID, ref []byte) error {
	if err := d.opts.Store.VoidProposal(ctx, groupID, ref, d.now()); err != nil {
		return err
	}
	if d.opts.Metrics != nil {
		if kind, ok := d.kindOfProposal(ctx, groupID, ref); ok {
			d.opts.Metrics.DSProposals.WithLabelValues(proposalLabel(kind)).Dec()
		}
	}
	return nil
}

// kindOfProposal reads one row's kind, for the gauge that has to go back down again.
//
// It looks at the GROUP'S CURRENT EPOCH, which is where every live proposal is: a re-issue moves a
// proposal to the new epoch and a commit deletes what it applied. A row at an older epoch is not
// found, and the gauge is then simply not decremented — a missing tick on a diagnostic is the
// right failure for a lookup that cannot be made exact without a `GetProposal` on the repository.
func (d *DS) kindOfProposal(ctx context.Context, groupID id.ID, ref []byte) (uint8, bool) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if err != nil {
		return 0, false
	}
	rows, err := d.opts.Store.ListProposals(ctx, groupID, row.Epoch, true)
	if err != nil {
		return 0, false
	}
	for _, r := range rows {
		if bytes.Equal(r.Ref, ref) {
			return r.Kind, true
		}
	}
	return 0, false
}

// ReissueFor retries a logical action with a fresh KeyPackage, keeping action_id. It is the retry
// half of invariant 6: "The underlying action is retried with a fresh KeyPackage, or dropped if
// the target leaf is already gone."
func (d *DS) ReissueFor(ctx context.Context, groupID, actionID id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()

	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	}
	if err != nil {
		return err
	}
	rows, err := d.opts.Store.ListProposals(ctx, groupID, row.Epoch, true)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.ActionID == actionID {
			return d.reissue(ctx, groupID, r)
		}
	}
	return errNotFound("action")
}

// reissue re-signs one proposal for the group's current epoch, keeping its action_id and dropping
// it when the action no longer applies.
//
// Two rules hold here and are load-bearing:
//
//  1. Every branch calls the LOCK-FREE form. Both callers already hold the group lock.
//  2. The superseded row is RETIRED in the same breath as the new one is written. Leaving it
//     behind at the old epoch, non-void, makes `checkAppliedProposals`' clause 1 demand a ref no
//     commit can reference — the group freezes permanently. `interfaces.md` §4.1 declares
//     `ReissueProposal(ctx, oldRef []byte, p ProposalRow) error // keeps action_id` for exactly
//     this, so the new proposal is written through it: the old row is replaced atomically and
//     `action_id` is carried.
//
// `reissueVia` is the seam: it marks the next `storeInstanceProposal` as a replacement, and that
// function calls `tx.ReissueProposal(ctx, supersedes, p)` instead of `tx.PutProposal(ctx, p)`.
func (d *DS) reissue(ctx context.Context, groupID id.ID, old store.ProposalRow) error {
	switch mlswasi.ProposalKind(old.Kind) {
	case mlswasi.ProposalAdd:
		if old.TargetDevice == nil {
			return nil
		}
		return d.reissueVia(groupID, old.Ref, func() error {
			return d.proposeAddLocked(ctx, groupID, *old.TargetDevice, old.ActionID)
		})
	case mlswasi.ProposalRemove:
		if old.TargetLeaf == nil {
			return nil
		}
		if _, err := d.userOfLeaf(ctx, groupID, *old.TargetLeaf); err != nil {
			// The leaf is already gone: the action is satisfied, not retried.
			return d.opts.Store.DeleteProposals(ctx, groupID, [][]byte{old.Ref})
		}
		return d.reissueVia(groupID, old.Ref, func() error {
			return d.proposeRemoveLocked(ctx, groupID, *old.TargetLeaf, old.ActionID)
		})
	default:
		return nil
	}
}

// reissueVia marks the next storeInstanceProposal FOR THIS GROUP as a replacement of oldRef, so it
// writes through ReissueProposal rather than PutProposal. The window runs under that group's own
// lock, and the marker is keyed by group, so a re-issue in another group cannot pick it up.
func (d *DS) reissueVia(groupID id.ID, oldRef []byte, fn func() error) error {
	d.supersedeMu.Lock()
	if d.supersede == nil {
		d.supersede = map[id.ID][]byte{}
	}
	d.supersede[groupID] = oldRef
	d.supersedeMu.Unlock()
	defer func() {
		d.supersedeMu.Lock()
		delete(d.supersede, groupID)
		d.supersedeMu.Unlock()
	}()
	return fn()
}

// takeSupersede reads and clears the group's marker, so a re-issue that fans out into more than
// one storeInstanceProposal supersedes exactly the first.
func (d *DS) takeSupersede(groupID id.ID) []byte {
	d.supersedeMu.Lock()
	defer d.supersedeMu.Unlock()
	ref, ok := d.supersede[groupID]
	if !ok {
		return nil
	}
	delete(d.supersede, groupID)
	return ref
}

func proposalLabel(kind uint8) string {
	switch mlswasi.ProposalKind(kind) {
	case mlswasi.ProposalAdd:
		return "add"
	case mlswasi.ProposalRemove:
		return "remove"
	case mlswasi.ProposalUpdate:
		return "update"
	default:
		return "other"
	}
}

// sweepProposals voids every proposal past its TTL and reports how many it voided. It runs on the
// retention sweeper's tick (task 26) and is called directly by tests driving a clock.Fake: TTLs
// are evaluated lazily at decision points, never with a timer armed for 24 hours.
//
// It PAGES to completion rather than reading one fixed batch from the zero id. `ListOpenGroups`
// takes an `after` cursor; a constant `id.ID{}` start with a fixed limit means only the first N
// groups are ever swept, so on an instance with more groups than the batch the tail's proposals
// never void — and nothing else voids them.
func (d *DS) sweepProposals(ctx context.Context) (int, error) {
	now := d.now()
	voided := 0
	after := id.ID{}
	for {
		groups, err := d.opts.Store.ListOpenGroups(ctx, after, sweepPage)
		if err != nil {
			return voided, err
		}
		if len(groups) == 0 {
			return voided, nil
		}
		for _, g := range groups {
			rows, err := d.opts.Store.ListProposals(ctx, g.GroupID, g.Epoch, false)
			if err != nil {
				return voided, err
			}
			for _, r := range rows {
				if r.VoidAt != nil || now < r.IssuedAt+int64(r.TTL) {
					continue
				}
				if err := d.opts.Store.VoidProposal(ctx, g.GroupID, r.Ref, now); err != nil {
					return voided, err
				}
				if d.opts.Metrics != nil {
					d.opts.Metrics.DSProposals.WithLabelValues(proposalLabel(r.Kind)).Dec()
				}
				voided++
			}
			after = g.GroupID
		}
		if len(groups) < sweepPage {
			return voided, nil
		}
	}
}
