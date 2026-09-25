package ds_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

// Invariant 1: a text group is refused for an invite or discoverable channel and for a
// readable-mode channel.
//
// Each case gets its own harness because the committed fixture is ONE group with one group id
// baked into its GroupInfo, and `Register` refuses a body whose group id is not the group
// context's — so two successful registrations cannot share a database.
func TestRegisterRefusesATextGroupOnAReadableOrOpenChannel(t *testing.T) {
	for _, c := range []struct {
		name       string
		visibility uint8 // 0 private, 1 invite, 2 discoverable
		mode       uint8 // 0 e2ee, 1 readable
		wantCode   string
	}{
		{"text on a private e2ee channel", 0, 0, ""},
		{"text on an invite channel", 1, 0, "E_MODE_READABLE"},
		{"text on a discoverable channel", 2, 0, "E_MODE_READABLE"},
		{"text on a readable channel", 0, 1, "E_MODE_READABLE"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newDSHarness(t)
			channel := h.channel(t, c.visibility, c.mode)
			_, err := h.ds.Register(context.Background(), h.registerRequest(t, channel))
			if c.wantCode == "" {
				if err != nil {
					t.Fatalf("Register: %v", err)
				}
				return
			}
			var dsErr *ds.Error
			if !errors.As(err, &dsErr) || dsErr.Code != c.wantCode {
				t.Fatalf("got %v, want %s", err, c.wantCode)
			}
			if dsErr.Status != http.StatusForbidden {
				t.Errorf("status = %d, want 403", dsErr.Status)
			}
		})
	}
}

// The other half of invariant 1: a CALL group is allowed on a discoverable or readable channel.
// The committed fixture is a text group, so the rule is exercised on the clause itself rather
// than through a Register that no fixture can supply.
func TestTheChannelModeRuleLetsACallGroupOntoAnyChannel(t *testing.T) {
	h := newDSHarness(t)
	target := h.channel(t, 2, 1) // discoverable AND readable: the strictest channel there is
	for _, kind := range []uint8{1 /* call */, 2 /* pairing */, 3 /* interaction */} {
		b := dsFixture(t).binding
		b.Kind = kind
		b.TargetID = target
		if err := ds.CheckChannelModeForTest(h.ds, context.Background(), b); err != nil {
			t.Errorf("kind %d on a discoverable readable channel: %v, want no refusal", kind, err)
		}
	}
	text := dsFixture(t).binding
	text.TargetID = target
	if err := ds.CheckChannelModeForTest(h.ds, context.Background(), text); err == nil {
		t.Error("a TEXT group on the same channel was allowed; invariant 1 refuses it")
	}
}

// A target with no channel row at all — a DM or a pairing group — is not subject to the mode rule.
func TestTheChannelModeRuleIgnoresATargetThatIsNotAChannel(t *testing.T) {
	h := newDSHarness(t)
	b := dsFixture(t).binding
	b.TargetID = id.New() // never declared to the Channels source
	if err := ds.CheckChannelModeForTest(h.ds, context.Background(), b); err != nil {
		t.Fatalf("a target with no channel row was refused: %v", err)
	}
}

func TestRegisterRefusesADuplicateGroupID(t *testing.T) {
	h := newDSHarness(t)
	req := h.registerRequest(t, h.channel(t, 0, 0))
	if _, err := h.ds.Register(context.Background(), req); err != nil {
		t.Fatalf("first Register: %v", err)
	}
	var dsErr *ds.Error
	if _, err := h.ds.Register(context.Background(), req); !errors.As(err, &dsErr) || dsErr.Code != "E_GROUP_EXISTS" {
		t.Fatalf("got %v, want E_GROUP_EXISTS", err)
	}
}

// The body's binding must equal extension 0xF001 inside the uploaded GroupInfo's group context.
//
// Two separate refusals share that sentence and they are pinned separately, because a single
// case cannot pin both: mutating the encoding takes the decoder's branch and never reaches the
// equality check. The fixture's last byte is `media_version`'s 0x00 and 0x00^0xff is 0xff, CBOR's
// break byte, so the "flip a byte" case alone would still pass with the equality check deleted.
func TestRegisterRefusesABindingThatDoesNotMatchTheGroupInfo(t *testing.T) {
	// A WELL-FORMED eight-element binding that differs from the signed one in exactly one field.
	// This is the case the byte-for-byte equality check in Register exists for: a client that
	// signs one binding into the group context and declares another in the body.
	t.Run("a well formed binding that differs in one field", func(t *testing.T) {
		h := newDSHarness(t)
		req := h.registerRequest(t, h.channel(t, 0, 0))
		altered := dsFixture(t).binding
		altered.PolicyVersion = 99 // the fixture signs policy_version = 1
		encoded, err := cborx.Marshal(altered)
		if err != nil {
			t.Fatalf("encode the altered binding: %v", err)
		}
		if bytes.Equal(encoded, req.Binding) {
			t.Fatal("the altered binding encodes to the fixture's own bytes; the case proves nothing")
		}
		if _, err := ds.DecodeBindingForTest(encoded); err != nil {
			t.Fatalf("the altered binding must stay decodable, or the decode branch refuses it: %v", err)
		}
		req.Binding = encoded
		mustRefuseWithBindingInvalid(t, h, req)
	})

	// And the decode branch: bytes that are not a dilla_binding at all.
	t.Run("undecodable binding bytes", func(t *testing.T) {
		h := newDSHarness(t)
		req := h.registerRequest(t, h.channel(t, 0, 0))
		req.Binding = append([]byte(nil), req.Binding...)
		req.Binding[len(req.Binding)-1] ^= 0xff
		if _, err := ds.DecodeBindingForTest(req.Binding); err == nil {
			t.Fatal("the mutated bytes still decode; this case no longer pins the decode branch")
		}
		mustRefuseWithBindingInvalid(t, h, req)
	})
}

func mustRefuseWithBindingInvalid(t *testing.T, h *dsHarness, req ds.RegisterRequest) {
	t.Helper()
	var dsErr *ds.Error
	if _, err := h.ds.Register(context.Background(), req); !errors.As(err, &dsErr) || dsErr.Code != "E_BINDING_INVALID" {
		t.Fatalf("got %v, want E_BINDING_INVALID", err)
	}
	if dsErr.Status != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", dsErr.Status)
	}
}

func TestRegisterAnswersNextSeqOneAndInfoAgrees(t *testing.T) {
	h := newDSHarness(t)
	got, session := h.mustRegister(t)
	if got.NextSeq != 1 {
		t.Fatalf("NextSeq = %d, want 1 (high-water 0 + 1)", got.NextSeq)
	}
	info, err := h.ds.Info(context.Background(), got.GroupID, session)
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if info.NextSeq != got.NextSeq {
		t.Errorf("Info.NextSeq = %d, want %d", info.NextSeq, got.NextSeq)
	}
	if len(info.TreeHash) != 32 {
		t.Errorf("tree_hash is %d bytes, want 32", len(info.TreeHash))
	}
}

// The DS serves the tree from its own PublicGroup; a committer uploads a GroupInfo WITHOUT one
// (invariant 2).
func TestTreeIsServedFromTheDSsOwnPublicGroup(t *testing.T) {
	h := newDSHarness(t)
	reg, session := h.mustRegister(t)
	tree, err := h.ds.Tree(context.Background(), reg.GroupID, session)
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}
	if len(tree.RatchetTree) == 0 {
		t.Fatal("the DS served an empty ratchet tree")
	}
	info, err := h.ds.Info(context.Background(), reg.GroupID, session)
	if err != nil {
		t.Fatalf("Info: %v", err)
	}
	if string(tree.TreeHash) != string(info.TreeHash) {
		t.Error("the served tree hash and the stored GroupInfo's disagree")
	}
}

// Both reads are member-only, and a non-member is answered E_NOT_FOUND rather than E_FORBIDDEN:
// a 403 would tell any authenticated device on the instance which group ids are live.
func TestInfoAndTreeAnswerNotFoundToANonMember(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	stranger := h.memberSession(t, reg.GroupID, 0)
	stranger.DeviceID = id.New()

	var dsErr *ds.Error
	if _, err := h.ds.Info(context.Background(), reg.GroupID, stranger); !errors.As(err, &dsErr) ||
		dsErr.Code != "E_NOT_FOUND" {
		t.Errorf("Info: got %v, want E_NOT_FOUND", err)
	}
	if _, err := h.ds.Tree(context.Background(), reg.GroupID, stranger); !errors.As(err, &dsErr) ||
		dsErr.Code != "E_NOT_FOUND" {
		t.Errorf("Tree: got %v, want E_NOT_FOUND", err)
	}
}

// Registration records the group's leaves in the SAME transaction as the group row: a registered
// group with no member rows would refuse every later commit from its own creator.
func TestRegisterRecordsTheGroupsLeaves(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	members, err := h.repo.ListMembers(context.Background(), reg.GroupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) != 1500 {
		t.Fatalf("mls_members holds %d leaves, want the fixture's 1500", len(members))
	}
	groups, err := h.repo.GroupsForDevice(context.Background(), members[0].DeviceID)
	if err != nil {
		t.Fatalf("GroupsForDevice: %v", err)
	}
	if len(groups) != 1 || groups[0] != reg.GroupID {
		t.Fatalf("GroupsForDevice = %v, want [%s]", groups, reg.GroupID)
	}
}

// Close marks the group closed and drops the cached handle; the row survives, because the
// handshake log is still readable to a device catching up.
func TestCloseMarksTheGroupClosed(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	if err := h.ds.Close(context.Background(), reg.GroupID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	row, err := h.repo.GetGroup(context.Background(), reg.GroupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	if row.ClosedAt == nil {
		t.Fatal("closed_at is still NULL after Close")
	}
}
