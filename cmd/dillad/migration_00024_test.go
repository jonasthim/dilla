package main

// migration_00024_test.go: the rollback of migration 00024 (UP6b, correction I5). web3.11's core
// refuses a whole handshake page that carries a kind above 2 (wire.rs), so `migrate down --to=23`
// must leave no kind-3 row and no withdrawn proposal behind, and the previous release's binary must
// start on the database it leaves.

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestDown00024ThenOldBinary(t *testing.T) {
	h := newCLIHarness(t)
	ctx := context.Background()
	repo := h.repo(t)
	g := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: 1, TargetID: id.New(), Ciphersuite: 1,
		ExternalSenderKeyID: id.New(), E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1, Created: 1,
	}
	if err := repo.CreateGroup(ctx, g); err != nil {
		t.Fatalf("CreateGroup: %v", err)
	}
	leaf := uint32(1)
	dev := id.New()
	for _, ref := range []string{"withdrawn", "standing"} {
		if err := repo.PutProposal(ctx, store.ProposalRow{
			GroupID: g.GroupID, Ref: []byte(ref), Kind: 3, TargetLeaf: &leaf, TargetDevice: &dev,
			ActionID: id.New(), IssuedAt: 1, TTL: 30, Withdrawable: true,
		}); err != nil {
			t.Fatalf("PutProposal: %v", err)
		}
	}
	for seq, kind := range map[uint64]uint8{1: 0, 2: 3} {
		if err := repo.AppendHandshake(ctx, store.HandshakeRow{
			GroupID: g.GroupID, Seq: seq, Kind: kind, Blob: []byte{0x81, 0x41, 0x01}, Created: 1,
		}); err != nil {
			t.Fatalf("AppendHandshake: %v", err)
		}
	}
	if marked, err := repo.WithdrawProposal(ctx, g.GroupID, []byte("withdrawn"), 1, 2); err != nil || !marked {
		t.Fatalf("WithdrawProposal = %v, %v", marked, err)
	}
	_ = repo.Close()

	if code, out := h.Run(t, "migrate", "down", "--to=23", "--i-know-what-i-am-doing", "--config="+h.ConfigPath); code != 0 {
		t.Fatalf("migrate down --to=23 = %d:\n%s", code, out)
	}
	db, err := openSQLiteForTest(h.cfg.DB.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var kinds, proposals int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mls_handshakes WHERE kind > 2`).Scan(&kinds); err != nil || kinds != 0 {
		t.Fatalf("after the down step: %d handshakes above kind 2, %v", kinds, err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mls_pending_proposals`).Scan(&proposals); err != nil || proposals != 1 {
		t.Fatalf("after the down step: %d proposals, %v; want the standing one alone", proposals, err)
	}
	var version int64
	if err := db.QueryRowContext(ctx, `SELECT MAX(version_id) FROM goose_db_version`).Scan(&version); err != nil || version != 23 {
		t.Fatalf("after the down step: schema %d, %v; want 23", version, err)
	}
	_ = db.Close()

	// The previous release's binary starts on the database the down step left: its migrate status
	// reads schema 23 as its own. DILLA_PREV_DILLAD names that binary (built from the previous
	// release tag); without it the leg is skipped, and the in-tree checks above still ran.
	prev := os.Getenv("DILLA_PREV_DILLAD")
	if prev == "" {
		t.Skip("DILLA_PREV_DILLAD is unset: the previous release's binary is not on this box")
	}
	out, err := exec.CommandContext(ctx, prev, "migrate", "status", "--config="+h.ConfigPath).CombinedOutput()
	if err != nil {
		t.Fatalf("the previous binary's migrate status failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "23") {
		t.Fatalf("the previous binary's migrate status does not report schema 23:\n%s", out)
	}
}
