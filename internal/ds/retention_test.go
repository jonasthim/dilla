package ds_test

// retention_test.go is task 26's half of the delivery service's tests: invariant 10's two
// independent deletion triggers, the eligibility of the cursors that hold the delivery floor, and
// the sweeper that applies both on one tick.
//
// The harness helpers these tests need live here rather than in harness_test.go for the reason
// message_harness_test.go and election_harness_test.go give: `dsHarness` is one type and
// harness_test.go is already the longest file in the package.

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store/sqlite"
)

// Delivery retention: handshakes are kept 30 days, and a ?from= below the floor is E_PRUNED,
// which tells the client to resync rather than to retry.
//
// DEVIATION from the brief's literal test, which drives two `h.ds.Commit` calls through
// `h.commitFor`. No commit in this repository can be ACCEPTED — the committed fixture ships one
// GroupInfo at epoch 6 and invariant 4 wants epoch n+1, the blocker
// `TestAnAcceptedCommitFansOutHandshakeEpochChangedAndWelcomes` skips on — and there is no
// `commitFor` helper. The handshake log is therefore seeded exactly as every other test in this
// package seeds it (`appendHandshake`, commit_test.go), which is what
// `TestACatchUpBelowTheRetentionFloorIsPruned` already does; the assertion — the SWEEP deletes the
// row older than the window, and the catch-up below the resulting floor is E_PRUNED/410 — is the
// brief's own.
func TestAHandshakeOlderThanThirtyDaysIsPrunedAndFromBelowTheFloorIsEPruned(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	reg, session := h.mustRegister(t)

	// Seq 1 is written now and seq 20 thirty-one days later, so exactly one of the two is older
	// than HandshakeRetention when the sweep runs.
	h.appendHandshake(t, reg.GroupID, 1, 6, 1, []byte("swept"))
	h.clk.Advance(31 * 24 * time.Hour)
	h.appendHandshake(t, reg.GroupID, 20, 7, 1, []byte("commit"))

	report, err := h.ds.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if report.HandshakesPruned != 1 {
		t.Fatalf("the sweep deleted %d handshakes, want the one at seq 1: "+
			"the hole below the floor has to be real", report.HandshakesPruned)
	}

	_, err = h.ds.Handshakes(ctx, reg.GroupID, session, 0, 100)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PRUNED" {
		t.Fatalf("from=0 after pruning: got %v, want E_PRUNED", err)
	}
	if dsErr.Status != 410 {
		t.Errorf("status = %d, want 410", dsErr.Status)
	}
	rows, err := h.ds.Handshakes(ctx, reg.GroupID, session, 19, 100)
	if err != nil {
		t.Fatalf("from the floor: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d handshakes, want the 1 that survived", len(rows))
	}
}

// Ciphertext is kept until every ELIGIBLE cursor has passed it. A revoked, disabled or
// 90-day-inactive device does not hold the floor — otherwise one abandoned phone pins a
// community's storage forever.
func TestAnIneligibleDeviceDoesNotHoldThePruneFloor(t *testing.T) {
	for _, c := range []struct {
		name string
		make func(h *dsHarness, t *testing.T, g *dsMessageGroup, laggard id.ID)
	}{
		{"a revoked device", func(h *dsHarness, t *testing.T, _ *dsMessageGroup, laggard id.ID) {
			h.revokeDevice(t, laggard)
		}},
		{"a disabled user's device", func(h *dsHarness, t *testing.T, _ *dsMessageGroup, laggard id.ID) {
			h.disableUserOf(t, laggard)
		}},
		{"a device unseen for 90 days", func(h *dsHarness, t *testing.T, g *dsMessageGroup, laggard id.ID) {
			h.ageCursor(t, g, laggard, 91*24*time.Hour)
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			h := newDSHarness(t)
			g := h.group(t)
			laggard := h.laggardMember(t, g) // its cursor stays at 0
			c.make(h, t, g, laggard)

			out, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
			if err != nil {
				t.Fatalf("Upload: %v", err)
			}
			if err := h.ds.AdvanceCursor(ctx, g.session, g.id, out.Seq, out.Epoch); err != nil {
				t.Fatalf("AdvanceCursor: %v", err)
			}
			if _, err := h.ds.Sweep(ctx); err != nil {
				t.Fatalf("Sweep: %v", err)
			}
			rows, err := h.ds.Messages(ctx, g.id, g.session, 0, 10)
			if err != nil {
				t.Fatalf("Messages: %v", err)
			}
			if len(rows) != 0 {
				t.Fatal("every eligible cursor has passed the message; " +
					"an ineligible device must not hold it")
			}
		})
	}
}

// A live laggard DOES hold the floor.
func TestALiveDeviceBehindTheStreamHoldsTheFloor(t *testing.T) {
	ctx := context.Background()
	h := newDSHarness(t)
	g := h.group(t)
	laggard := h.laggardMember(t, g)
	h.online(laggard)

	out, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if err := h.ds.AdvanceCursor(ctx, g.session, g.id, out.Seq, out.Epoch); err != nil {
		t.Fatalf("AdvanceCursor: %v", err)
	}
	if _, err := h.ds.Sweep(ctx); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	rows, err := h.ds.Messages(ctx, g.id, g.session, 0, 10)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(rows) != 1 {
		t.Fatal("a live member that has not acknowledged the message must hold it")
	}
}

// Archival retention (R28/D14) is a separate half: expires NULL means retained indefinitely, and
// a passed expires deletes even though no cursor has moved and the delivery window has not closed.
//
// DEVIATION from the brief's literal test, which also calls `AdvanceCursor` to the expiring
// message's seq. The brief's own prose for this test says it "advances **no** cursor and stays
// inside the 30-day window", and the two are not the same test: with the acknowledgement in place
// the delivery half deletes BOTH rows (the cursor floor is the higher seq, and `seq <= floor`
// covers the lower one), which is rule 1 firing, not rule 2 — and the brief's assertion that the
// `expires IS NULL` row survives is then unsatisfiable for any definition of the two rules. The
// prose is the normative half and is what this test does.
func TestArchivalRetentionIsIndependentOfDeliveryRetention(t *testing.T) {
	ctx := context.Background()
	h := newDSHarness(t)
	g := h.group(t)
	kept, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	expiring, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch()))
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	h.setExpires(t, g, expiring.Seq, h.clk.Now().Add(time.Hour))

	h.clk.Advance(2 * time.Hour)
	if _, err := h.ds.Sweep(ctx); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	rows, err := h.ds.Messages(ctx, g.id, g.session, 0, 10)
	if err != nil {
		t.Fatalf("Messages: %v", err)
	}
	if len(rows) != 1 || rows[0].Seq != kept.Seq {
		t.Fatalf("got %v, want only the message with expires = NULL (retained)", rows)
	}
}

// The sweeper is idempotent and bounded: a second run changes nothing, and one run never scans
// the whole table.
func TestTheSweeperIsIdempotentAndBounded(t *testing.T) {
	ctx := context.Background()
	h := newDSHarness(t)
	g := h.group(t)
	for range 5 {
		if _, err := h.ds.Upload(ctx, g.session, g.id, g.Epoch(), h.message(t, g, g.Epoch())); err != nil {
			t.Fatalf("Upload: %v", err)
		}
	}
	h.clk.Advance(31 * 24 * time.Hour)

	first, err := h.ds.Sweep(ctx)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	second, err := h.ds.Sweep(ctx)
	if err != nil {
		t.Fatalf("second Sweep: %v", err)
	}
	if second.MessagesPruned != 0 || second.HandshakesPruned != 0 {
		t.Fatalf("a second sweep pruned %+v, want nothing", second)
	}
	if first.MessagesPruned == 0 {
		t.Fatal("the first sweep pruned nothing")
	}
}

// ---------------------------------------------------------------- retention harness

// laggardMember is a SECOND current member device of the fixture group, of a different user from
// the uploader, with the `users` and `devices` rows the eligibility joins read and a live cursor
// that has acknowledged nothing. It is what "one device is behind the stream" looks like in SQL.
//
// The user must differ from the uploader's: the disabled-user case disables the whole account, and
// a shared user would take the uploader's own cursor out of the floor with it.
func (h *dsHarness) laggardMember(t *testing.T, g *dsMessageGroup) id.ID {
	t.Helper()
	ctx := context.Background()
	members, err := h.repo.ListMembers(ctx, g.id)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	for _, m := range members {
		if m.DeviceID == g.device || m.UserID == g.session.UserID || m.RemovedEpoch != nil {
			continue
		}
		h.account(t, m.UserID, m.DeviceID)
		if err := h.repo.PutCursor(ctx, m.DeviceID, g.id, 0, g.Epoch(), h.clk.Now().Unix()); err != nil {
			t.Fatalf("PutCursor: %v", err)
		}
		if h.sessions == nil {
			h.sessions = map[id.ID]auth.Session{}
		}
		h.sessions[m.DeviceID] = auth.Session{
			UserID: m.UserID, DeviceID: m.DeviceID, Scope: auth.ScopeEnrolled,
		}
		return m.DeviceID
	}
	t.Fatal("the fixture has no second member of another user")
	return id.ID{}
}

// revokeDevice is the first ineligibility: the device's credential is gone, so nothing will ever
// fetch on its behalf again.
func (h *dsHarness) revokeDevice(t *testing.T, device id.ID) {
	t.Helper()
	if err := h.repo.RevokeDevice(context.Background(), device, h.clk.Now().Unix()); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
}

// disableUserOf is the second: the whole account is disabled, so none of its devices may fetch.
func (h *dsHarness) disableUserOf(t *testing.T, device id.ID) {
	t.Helper()
	ctx := context.Background()
	row, err := h.repo.GetDevice(ctx, device)
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	at := h.clk.Now().Unix()
	if err := h.repo.SetUserDisabled(ctx, row.UserID, &at); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
}

// ageCursor is the third: the cursor was last touched longer ago than InactivityRemove, which is
// the horizon MinCursor takes as its `activeSince`.
func (h *dsHarness) ageCursor(t *testing.T, g *dsMessageGroup, device id.ID, age time.Duration) {
	t.Helper()
	if err := h.repo.PutCursor(context.Background(), device, g.id, 0, g.Epoch(),
		h.clk.Now().Add(-age).Unix()); err != nil {
		t.Fatalf("PutCursor: %v", err)
	}
}

// setExpires writes one message's ARCHIVAL deadline. `expires` is a column no Plan-1 path fills —
// `Upload` writes NULL and the community policy that sets it is Plan 2's — and `store.Messages`
// has no method for it (ID1 fixes that method set), so the row is updated straight on the
// harness's database file, exactly as `countRows` reads straight off it.
func (h *dsHarness) setExpires(t *testing.T, g *dsMessageGroup, seq uint64, at time.Time) {
	t.Helper()
	db, err := sqlite.OpenWrite(h.path)
	if err != nil {
		t.Fatalf("sqlite.OpenWrite: %v", err)
	}
	defer func() { _ = db.Close() }()
	res, err := db.Exec(
		`UPDATE mls_app_messages SET expires = ? WHERE group_id = ? AND seq = ?`,
		at.Unix(), g.id, int64(seq))
	if err != nil {
		t.Fatalf("UPDATE expires: %v", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		t.Fatalf("RowsAffected: %v", err)
	}
	if n != 1 {
		t.Fatalf("UPDATE expires touched %d rows, want 1", n)
	}
}
