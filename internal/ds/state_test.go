package ds_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/store"
)

// R12: the PublicGroup state blob is written in the SAME transaction as the group row. A forced
// rollback must leave neither.
func TestAFailedTransactionLeavesNeitherTheGroupRowNorTheStateBlob(t *testing.T) {
	for _, failAt := range []string{"PutGroupState", "ReplaceMembers"} {
		t.Run(failAt, func(t *testing.T) {
			h := newDSHarness(t)
			h.failNextTx(failAt)
			req := h.registerRequest(t, h.channel(t, 0, 0))
			if _, err := h.ds.Register(context.Background(), req); err == nil {
				t.Fatal("Register must fail when its transaction fails")
			}
			if _, err := h.repo.GetGroup(context.Background(), req.GroupID); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetGroup after a rolled-back Register: %v, want ErrNotFound", err)
			}
			members, err := h.repo.ListMembers(context.Background(), req.GroupID)
			if err != nil {
				t.Fatalf("ListMembers: %v", err)
			}
			if len(members) != 0 {
				t.Fatalf("%d member rows survived a rolled-back Register", len(members))
			}
		})
	}
}

// On start the DS imports state blobs lazily, per group, through public_group_import_state —
// never from_external, which is O(n²) in credential validation at 1,500 leaves.
func TestARestartImportsTheStateBlobLazilyAndNeverRebuildsFromTheTree(t *testing.T) {
	h := newDSHarness(t)
	reg, session := h.mustRegister(t)
	before := h.wasmCalls("public_group_create")
	if before == 0 {
		t.Fatal("registration never called public_group_create; the counter is not wired")
	}

	h.restartDS()
	if got := h.wasmCalls("public_group_import_state"); got != 0 {
		t.Fatalf("a restart imported %d groups eagerly, want 0 — the import is lazy", got)
	}
	// Info is pure SQL: it must not touch the guest at all.
	if _, err := h.ds.Info(context.Background(), reg.GroupID, session); err != nil {
		t.Fatalf("Info after restart: %v", err)
	}
	if got := h.wasmCalls("public_group_import_state"); got != 0 {
		t.Fatalf("Info imported %d groups; it reads SQL, which is the record", got)
	}

	if _, err := h.ds.Tree(context.Background(), reg.GroupID, session); err != nil {
		t.Fatalf("Tree after restart: %v", err)
	}
	if got := h.wasmCalls("public_group_import_state"); got != 1 {
		t.Fatalf("public_group_import_state called %d times, want 1", got)
	}
	if got := h.wasmCalls("public_group_create"); got != before {
		t.Fatalf("public_group_create was called again after a restart (%d → %d): the DS must "+
			"import its own blob, never rebuild from the tree", before, got)
	}
	// A second read of the same group is served from the cached handle.
	if _, err := h.ds.Tree(context.Background(), reg.GroupID, session); err != nil {
		t.Fatalf("second Tree: %v", err)
	}
	if got := h.wasmCalls("public_group_import_state"); got != 1 {
		t.Fatalf("a cached group was re-imported: %d imports, want 1", got)
	}
}

// The committed identity vector is the one place the ten-element layout is written down outside
// the Rust encoder, so it is what the Go decoder is held to.
func TestCredentialIdentityDecodesTheCommittedVector(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol", "vectors", "identity.json"))
	if err != nil {
		t.Fatalf("identity.json: %v", err)
	}
	var doc struct {
		CredentialIdentity struct {
			CBOR   string `json:"cbor"`
			Fields struct {
				UserID   string `json:"user_id"`
				DeviceID string `json:"device_id"`
			} `json:"fields"`
		} `json:"credential_identity"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("identity.json: %v", err)
	}
	c := doc.CredentialIdentity
	if c.CBOR == "" {
		t.Fatal("identity.json carries no credential_identity.cbor; the decoder is unpinned")
	}
	blob, err := hex.DecodeString(c.CBOR)
	if err != nil {
		t.Fatalf("credential_identity.cbor: %v", err)
	}
	device, user, err := ds.DecodeCredentialIdentityForTest(blob)
	if err != nil {
		t.Fatalf("decodeCredentialIdentity: %v", err)
	}
	if got := hex.EncodeToString(user[:]); got != c.Fields.UserID {
		t.Errorf("user_id = %s, want %s", got, c.Fields.UserID)
	}
	if got := hex.EncodeToString(device[:]); got != c.Fields.DeviceID {
		t.Errorf("device_id = %s, want %s", got, c.Fields.DeviceID)
	}

	// A three-element array is the old, wrong shape; the length check is what rejects it.
	if _, _, err := ds.DecodeCredentialIdentityForTest([]byte{0x83, 0x01, 0x02, 0x03}); err == nil {
		t.Error("a three-element credential identity was accepted; the layout is ten elements")
	}
}

// And the binding: the fixture group's own dilla_binding, read back out of the column it was
// stored in.
func TestTheBindingDecodesAsEightFixedPositionElements(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	row, err := h.repo.GetGroup(context.Background(), reg.GroupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	b, err := ds.DecodeBindingForTest(row.Binding)
	if err != nil {
		t.Fatalf("decodeBinding: %v", err)
	}
	if b.V != 1 {
		t.Errorf("v = %d, want 1", b.V)
	}
	if b.TargetID != reg.GroupID {
		t.Errorf("target_id = %s, want %s", b.TargetID, reg.GroupID)
	}
	if b.CommunityID != nil {
		t.Errorf("community_id = %v, want null", b.CommunityID)
	}
	if b.Kind != 0 || b.PolicyVersion != 1 || b.E2EEVersion != 1 || b.MediaVersion != 0 {
		t.Errorf("kind/policy/e2ee/media = %d/%d/%d/%d, want 0/1/1/0",
			b.Kind, b.PolicyVersion, b.E2EEVersion, b.MediaVersion)
	}
	// A JSON decode of the same bytes must fail, which is what stops the old shape coming back.
	var scratch map[string]any
	if err := json.Unmarshal(row.Binding, &scratch); err == nil {
		t.Fatal("dilla_binding decoded as JSON; it is deterministic CBOR")
	}
	// Deviation B11: the column holds the binding's own bytes, not a re-encoding.
	if string(row.Binding) != string(h.registerRequest(t, reg.GroupID).Binding) {
		t.Error("the stored binding is not the bytes the group context signed")
	}
	// R9: a text group has no call id.
	if row.CallID != nil {
		t.Errorf("call_id = %v on a text group, want NULL", row.CallID)
	}
}
