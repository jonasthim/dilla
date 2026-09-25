package ds

import (
	"context"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// contentTypeApplication is RFC 9420's ContentType `application`, the only one endpoint 7
// accepts. `proposal` (2) and `commit` (3) are handshakes and reach the instance through
// endpoints 5 and 6, which sequence them into `mls_handshakes`.
const contentTypeApplication = 1

// UploadResult carries Epoch as well as the endpoint's three response elements. The endpoint's
// body is [seq, franking_tag, recv_ts] (§5.1 row 7) and does NOT carry the epoch; the Go value
// does, because every in-process caller — AdvanceCursor, the retention tests, the testkit host —
// needs the epoch the message was accepted at. Recorded as deviation B14 against §6.2.
type UploadResult struct {
	Seq         uint64
	Epoch       uint64
	FrankingTag []byte
	RecvTS      uint64
}

// Upload is invariant 8. The order is fixed: size, then the freeze, then the current-leaf check,
// then the commitment, then the tag.
func (d *DS) Upload(ctx context.Context, s Session, groupID id.ID, epoch uint64, pm []byte) (UploadResult, error) {
	if len(pm) > d.opts.Policy.MaxCiphertextBytes {
		return UploadResult{}, errTooLarge(len(pm), d.opts.Policy.MaxCiphertextBytes)
	}
	unlock := d.lock(groupID)
	defer unlock()

	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return UploadResult{}, errNotFound("group")
	}
	if err != nil {
		return UploadResult{}, err
	}
	if err := d.requireNoFreeze(ctx, groupID, row.Epoch); err != nil {
		return UploadResult{}, err
	}
	if _, err := d.leafOf(ctx, groupID, s.DeviceID); err != nil {
		return UploadResult{}, err
	}

	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return UploadResult{}, err
	}
	defer inst.Release()

	// The commitment travels only in private_message.authenticated_data; there is no separate
	// field on the upload, and a length other than 32 is E_COMMITMENT_INVALID.
	meta, err := inst.PrivateMessageAAD(ctx, pm)
	if err != nil {
		return UploadResult{}, errCommitmentInvalid(0)
	}
	if len(meta.AuthenticatedData) != 32 {
		return UploadResult{}, errCommitmentInvalid(len(meta.AuthenticatedData))
	}
	// facts-ds-contract.md §1.2's parse ends "u8 content_type (must be 1)". 2 is a Proposal and 3
	// a Commit, and both are handshakes: the instance is the sole sequencer for them (invariants
	// 1-5), so one accepted here would reach every member as `message.ct` with a seq out of the
	// group's one shared seq space and no `mls_handshakes` row behind it — the fork invariant 9
	// exists to detect. The guest reports the byte without decrypting; only this layer can refuse
	// on it.
	if meta.ContentType != contentTypeApplication {
		return UploadResult{}, errCommitInvalid("content_type",
			"only application messages may be uploaded here")
	}
	if meta.Epoch != row.Epoch {
		return UploadResult{}, errCommitInvalid("epoch", "the message's epoch is not the group's")
	}

	recvTS := uint64(d.now())
	var out UploadResult
	err = d.opts.Store.Tx(ctx, func(tx store.Repository) error {
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		tag := FrankingTag(d.opts.Keys.FrankingKey, groupID, row.Epoch, seq, s.DeviceID, meta.AuthenticatedData, recvTS)
		if err := tx.PutAppMessage(ctx, store.AppMessageRow{
			GroupID:        groupID,
			Seq:            seq,
			Epoch:          row.Epoch,
			UploaderDevice: s.DeviceID,
			Blob:           pm,
			CommitmentC:    meta.AuthenticatedData,
			FrankingTag:    tag,
			Size:           uint64(len(pm)),
			Created:        int64(recvTS),
			// Archival retention: NULL means retained. The community policy fills it in Plan 2;
			// delivery retention is the sweeper's business, not this column's.
			Expires: nil,
		}); err != nil {
			return err
		}
		out = UploadResult{Seq: seq, Epoch: row.Epoch, FrankingTag: tag, RecvTS: recvTS}
		return nil
	})
	if err != nil {
		return UploadResult{}, err
	}

	// R30: the uploader's own devices receive it too, so every device sees a dense seq stream.
	payload, err := gateway.MessageCTPayload(out.Seq, out.Epoch, s.DeviceID, pm, out.FrankingTag, out.RecvTS)
	if err == nil {
		d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
			Op: gateway.OpMessageCT, GroupID: &groupID, Payload: payload, Replay: true,
		})
	}
	return out, nil
}

// Messages serves the catch-up stream. A tombstoned row comes back with no blob and deleted = 1.
func (d *DS) Messages(ctx context.Context, groupID id.ID, session Session, from uint64, limit int32) ([]store.AppMessageRow, error) {
	// Member-only: the ciphertext, the commitments and the franking tags of a group are enough to
	// correlate membership and message timing across communities.
	if err := d.requireMember(ctx, groupID, session); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 256 {
		limit = 256
	}
	rows, err := d.opts.Store.ListAppMessages(ctx, groupID, from, limit)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// DeleteMessage tombstones one message. At v1 only the uploading user may delete, from any of
// their devices; moderator deletion of E2EE messages needs a signed moderation event and is a
// later card (R29).
func (d *DS) DeleteMessage(ctx context.Context, s Session, groupID id.ID, seq uint64) error {
	row, err := d.opts.Store.GetAppMessage(ctx, groupID, seq)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("message")
	}
	if err != nil {
		return err
	}
	uploader, err := d.opts.Store.GetDevice(ctx, row.UploaderDevice)
	if err != nil {
		return err
	}
	if uploader.UserID != s.UserID {
		return errNotUploader()
	}
	at := d.now()
	if err := d.opts.Store.TombstoneAppMessage(ctx, groupID, seq, at); err != nil {
		return err
	}
	payload, err := gateway.MessageDeletedPayload(seq, uint64(at))
	if err == nil {
		d.opts.Gateway.DeliverGroup(groupID, gateway.Frame{
			Op: gateway.OpMessageDeleted, GroupID: &groupID, Payload: payload, Replay: true,
		})
	}
	return nil
}

// AdvanceCursor is the only thing that moves a device's cursor. A frame put on a writer queue is
// not a delivery (protocol/02's retention wording, as amended).
//
// It is a group-scoped write and carries the same three guards: the caller must be a current
// member, the seq must be one the instance actually allocated, and the cursor only ever moves
// forward. All three exist because `device_cursors` is not a private scratch pad — it feeds
// `store.Cursors.MinCursor`, which task 26 makes the retention floor of the whole group.
func (d *DS) AdvanceCursor(ctx context.Context, s Session, groupID id.ID, seq, epoch uint64) error {
	// The read-modify-write below is only monotone if one goroutine at a time runs it; the
	// per-group lock is the same one Upload allocates seqs under.
	unlock := d.lock(groupID)
	defer unlock()

	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return errNotFound("group")
	} else if err != nil {
		return err
	}
	// Member-only, and E_NOT_FOUND rather than E_FORBIDDEN for the reason requireMember states: a
	// 403 here would tell any authenticated device on the instance which group ids are live. A
	// stranger's row would also sit in MinCursor forever, pinning the group's messages at floor 0.
	if err := d.requireMember(ctx, groupID, s); err != nil {
		return err
	}
	// `row.Seq` is the group's high-water in the one seq space; there is nothing above it to
	// acknowledge, and a cursor there would hold the floor above every message the group has.
	if seq > row.Seq {
		return errInvalid(fmt.Sprintf(
			"last_seq %d is above the group's high-water %d", seq, row.Seq))
	}
	cur, err := d.opts.Store.GetCursor(ctx, s.DeviceID, groupID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	// Monotone. Re-reading is done with `?from=`, not by rewinding the acknowledgement, so a lower
	// seq is a no-op rather than a refusal: a retried or reordered POST /cursor is ordinary and
	// the endpoint stays idempotent. What it must never do is move the retention floor backwards.
	if seq < cur.LastSeq {
		return nil
	}
	return d.opts.Store.PutCursor(ctx, s.DeviceID, groupID, seq, epoch, d.now())
}
