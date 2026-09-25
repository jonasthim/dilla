package ds_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/store"
)

// Invariant 8: the DS reads C from private_message.authenticated_data and refuses an upload whose
// authenticated_data is not exactly 32 bytes.
func TestAnUploadWithTheWrongCommitmentLengthIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	for _, n := range []int{0, 31, 33} {
		_, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageWithAAD(t, g, n))
		var dsErr *ds.Error
		if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMITMENT_INVALID" {
			t.Fatalf("%d-byte authenticated_data: got %v, want E_COMMITMENT_INVALID", n, err)
		}
		if dsErr.Status != 422 {
			t.Errorf("status = %d, want 422", dsErr.Status)
		}
	}
	if _, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageWithAAD(t, g, 32)); err != nil {
		t.Fatalf("32 bytes must be accepted: %v", err)
	}
}

// facts-ds-contract.md §1.2 fixes endpoint 7's parse: "strip u16 version + u16 wire format
// (must be 2), then read opaque<V> group_id, uint64 epoch, u8 content_type (MUST BE 1), then
// opaque<V> authenticated_data". The guest reports the byte; only the delivery service can refuse
// on it.
//
// It is not a formality. The instance is the SOLE SEQUENCER for handshakes (invariants 1-5): a
// Commit or a Proposal accepted here would reach every member as `message.ct`, carrying a seq out
// of the group's one shared seq space with no `mls_handshakes` row behind it — precisely the fork
// invariant 9 exists to detect.
func TestOnlyAnApplicationMessageMayBeUploaded(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	// 2 is proposal, 3 is commit. Both are well formed in every other respect: the group's own
	// epoch, a 32-byte commitment, an ordinary ciphertext.
	for _, ct := range []byte{2, 3} {
		_, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageOfContentType(t, g, ct))
		var dsErr *ds.Error
		if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
			t.Fatalf("content_type %d: got %v, want E_COMMIT_INVALID", ct, err)
		}
		if dsErr.Rule != "content_type" {
			t.Errorf("content_type %d: rule = %q, want content_type", ct, dsErr.Rule)
		}
	}
	// Nothing was sequenced, stored or franked by either refusal.
	rows, err := h.ds.Messages(context.Background(), g.id, g.session, 0, 10)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("a refused handshake left %d rows in mls_app_messages", len(rows))
	}
	if _, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageOfContentType(t, g, 1)); err != nil {
		t.Fatalf("content_type 1 must be accepted: %v", err)
	}
}

func TestAnUploadFromADeviceWhoseLeafIsGoneIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	h.removeLeafOfDevice(t, g, g.device)
	_, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("got %v, want E_LEAF_NOT_CURRENT", err)
	}
}

// R6/R32/D7: the cap is 131072 bytes of MLS ciphertext, exactly.
func TestTheCiphertextCapIsExactlyOneHundredAndThirtyOneThousandAndSeventyTwoBytes(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	if _, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageOfSize(t, g, 131072)); err != nil {
		t.Fatalf("131072 bytes must be accepted: %v", err)
	}
	_, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.messageOfSize(t, g, 131073))
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_TOO_LARGE" {
		t.Fatalf("131073 bytes: got %v, want E_TOO_LARGE", err)
	}
	if dsErr.Status != 413 {
		t.Errorf("status = %d, want 413", dsErr.Status)
	}
}

// R30: message.ct reaches the uploader too, so the per-group seq stream is dense on every device,
// and the response carries seq.
func TestMessageCTReachesTheUploaderAndTheResponseCarriesSeq(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	h.online(g.device)
	out, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if out.Seq == 0 {
		t.Fatal("the upload response must carry seq")
	}
	if len(out.FrankingTag) != 32 {
		t.Fatalf("franking tag is %d bytes, want 32", len(out.FrankingTag))
	}
	h.expectDeviceFrames(t, g.device, "message.ct")
}

// R29: only the uploading user's devices may delete, and a tombstone keeps everything but the
// ciphertext.
func TestDeleteIsUploaderOnlyAndKeepsTheTombstoneFields(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	out, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	stranger := h.sessionOfAnotherUser(t, g)
	err = h.ds.DeleteMessage(context.Background(), stranger, g.id, out.Seq)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_UPLOADER" {
		t.Fatalf("delete by another user: got %v, want E_NOT_UPLOADER", err)
	}

	sibling := h.otherDeviceOfSameUser(t, g)
	if err := h.ds.DeleteMessage(context.Background(), sibling, g.id, out.Seq); err != nil {
		t.Fatalf("any device of the uploading user may delete: %v", err)
	}

	rows, err := h.ds.Messages(context.Background(), g.id, g.session, 0, 10)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("catch-up returned %d rows, want 1 tombstone", len(rows))
	}
	row := rows[0]
	if row.Blob != nil {
		t.Error("a tombstone keeps no ciphertext")
	}
	if row.DeletedAt == nil {
		t.Error("a tombstone must carry deleted_at")
	}
	if row.Seq != out.Seq || row.Epoch == 0 || len(row.FrankingTag) != 32 || len(row.CommitmentC) != 32 {
		t.Error("a tombstone keeps seq, epoch, uploader_device, commitment_c, franking_tag and recv_ts")
	}
}

// interfaces.md §5.1 row 12 lists E_PRUNED as GET /v1/groups/{id}/messages' error, and the sibling
// handshake path already enforces it. Without it a client whose cursor is below the floor gets a
// silently short list starting at the floor and cannot tell "these are gone, resync" from
// "nothing new" — the precise failure the 410 exists to prevent.
func TestACatchUpBelowTheMessageRetentionFloorIsPruned(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	ctx := context.Background()
	first, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	// Thirty-one days pass between the two uploads, so exactly one of them is older than
	// MessageRetention when the sweep runs.
	h.clk.Advance(31 * 24 * time.Hour)
	second, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	rows, err := h.ds.Messages(ctx, g.id, g.session, 0, 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("before the sweep: %d rows, %v — want both messages", len(rows), err)
	}

	// The sweep task 26 owns, with its three retention parameters (D14): no eligible cursor has
	// acknowledged anything, so only the DELIVERY floor — now - MessageRetention — deletes, and
	// it takes exactly the message below it.
	n, err := h.repo.PruneAppMessages(ctx, g.id, 0,
		h.clk.Now().Add(-ds.DefaultPolicy().MessageRetention).Unix(), h.clk.Now().Unix())
	if err != nil {
		t.Fatalf("PruneAppMessages: %v", err)
	}
	if n != 1 {
		t.Fatalf("the sweep deleted %d rows, want the one at seq %d", n, first.Seq)
	}

	_, err = h.ds.Messages(ctx, g.id, g.session, 0, 10)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PRUNED" {
		t.Fatalf("a cursor below the floor: got %v, want E_PRUNED", err)
	}
	if dsErr.Status != 410 {
		t.Errorf("status = %d, want 410", dsErr.Status)
	}

	// A cursor contiguous with the floor has no hole and is served.
	rows, err = h.ds.Messages(ctx, g.id, g.session, first.Seq, 10)
	if err != nil {
		t.Fatalf("a cursor at the floor - 1 must be served: %v", err)
	}
	if len(rows) != 1 || rows[0].Seq != second.Seq {
		t.Fatalf("got %d rows, want the surviving message at seq %d", len(rows), second.Seq)
	}
}

// The other half of the same predicate, and the reason it is not the floor alone: `from` is a
// cursor in the ONE seq space handshakes and application messages share, so a group whose early
// seqs carry handshakes is below its message floor with nothing ever deleted. protocol/02's error
// table makes E_PRUNED mean "resync by external commit", so refusing that would send a healthy
// member through a full rejoin.
func TestAGroupWhoseEarlySeqsAreNotMessagesIsServed(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	ctx := context.Background()
	// Burn seq 1 the way a handshake does: the seq space is the group's, not the table's.
	if err := h.repo.Tx(ctx, func(tx store.Repository) error {
		_, err := tx.NextSeq(ctx, g.id)
		return err
	}); err != nil {
		t.Fatalf("NextSeq: %v", err)
	}
	out, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if out.Seq != 2 {
		t.Fatalf("the message took seq %d, want 2", out.Seq)
	}
	rows, err := h.ds.Messages(ctx, g.id, g.session, 0, 10)
	if err != nil {
		t.Fatalf("a group younger than MessageRetention has lost nothing: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want the one message", len(rows))
	}
}

// A cursor is a group-scoped write, so it carries the same authorisation as every group-scoped
// read: a device with no leaf in the group is E_NOT_FOUND, never E_FORBIDDEN and never 204.
//
// Two things ride on it. `device_cursors` feeds `store.Cursors.MinCursor`, which task 26 makes the
// retention floor, so a stranger's row would let any enrolled device that knows a group id pin
// that group's messages at floor 0 forever; and answering 204 where a member gets 204 but an
// unknown group gets 404 is the group-existence oracle requireMember's own comment refuses to
// give.
func TestACursorFromANonMemberIsRefused(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	stranger := h.sessionOfAnotherUser(t, g)

	err := h.ds.AdvanceCursor(context.Background(), stranger, g.id, 0, g.Epoch())
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("a non-member's cursor: got %v, want E_NOT_FOUND", err)
	}
	if dsErr.Status != 404 {
		t.Errorf("status = %d, want 404", dsErr.Status)
	}
	if got := h.cursorOf(t, stranger.DeviceID, g.id); got != 0 {
		t.Fatalf("a non-member wrote a cursor: last_seq = %d", got)
	}
}

// The floor task 26 builds on MinCursor must only ever move forward, and an acknowledgement can
// only name something the instance actually sequenced.
func TestACursorNeverPassesTheHighWaterAndNeverRewinds(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	ctx := context.Background()
	out, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	// Above the group's high-water there is nothing to acknowledge.
	err = h.ds.AdvanceCursor(ctx, g.session, g.id, out.Seq+1, out.Epoch)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_INVALID_REQUEST" {
		t.Fatalf("a cursor above the high-water: got %v, want E_INVALID_REQUEST", err)
	}
	if got := h.cursorOf(t, g.device, g.id); got != 0 {
		t.Fatalf("the refused cursor was written anyway: last_seq = %d", got)
	}

	if err := h.ds.AdvanceCursor(ctx, g.session, g.id, out.Seq, out.Epoch); err != nil {
		t.Fatalf("AdvanceCursor: %v", err)
	}
	// A rewind is idempotent, not an error — a retried or reordered acknowledgement is ordinary —
	// but it must not move the retention floor backwards.
	if err := h.ds.AdvanceCursor(ctx, g.session, g.id, 0, out.Epoch); err != nil {
		t.Fatalf("a rewind must be accepted and ignored, not refused: %v", err)
	}
	if got := h.cursorOf(t, g.device, g.id); got != out.Seq {
		t.Fatalf("cursor = %d after a rewind, want %d", got, out.Seq)
	}
}

// A cursor advances only on the explicit POST /cursor, never on fan-out.
func TestACursorAdvancesOnlyOnAnExplicitAcknowledgement(t *testing.T) {
	h := newDSHarness(t)
	g := h.group(t)
	h.online(g.device)
	out, err := h.ds.Upload(context.Background(), g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if got := h.cursorOf(t, g.device, g.id); got != 0 {
		t.Fatalf("cursor = %d after fan-out, want 0 — a frame on a writer queue is not a delivery", got)
	}
	// Epoch is a field on UploadResult, not a method.
	if err := h.ds.AdvanceCursor(context.Background(), g.session, g.id, out.Seq, out.Epoch); err != nil {
		t.Fatalf("AdvanceCursor: %v", err)
	}
	if got := h.cursorOf(t, g.device, g.id); got != out.Seq {
		t.Fatalf("cursor = %d, want %d", got, out.Seq)
	}
}
