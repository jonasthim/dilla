package ds_test

// heal_reseed_test.go is finding G2b of the second hardening review: heal's reseed adopts an
// uploaded ratchet tree (the instance holds no state blob after the restore), and before this it
// checked nothing about the tree's leaves - only that the GroupInfo is signed by the leaf naming the
// healer's device, names this group, is not older than the stored epoch, and carries the tree's
// hash. Every leaf of a reseeded tree now passes the clause an Add passes (invariant 4's Add
// clause: the device is known, owned by the credential's user, not revoked, keyed by its registered
// key, listed in its user's newest signed device list, and the user is eligible under the ACL), and
// the tree holds no leaf the delivery service cannot name.
//
// And T2 of the same review: the key check on a REPLAYED resync (heal.go's
// checkHealedExternalCommit) is pinned by its own test here.

import (
	"bytes"
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// leafEnrolment is what enrolLeaves makes of one leaf's device.
type leafEnrolment int

const (
	// enrolHonest: the device is registered under the key its leaf carries and listed.
	enrolHonest leafEnrolment = iota
	// enrolNone: the instance holds no row for the device.
	enrolNone
	// enrolOtherKey: the device is registered (and listed) under a key its leaf does not carry.
	enrolOtherKey
	// enrolUnlisted: the device is registered under its leaf key, but its user's list omits it.
	enrolUnlisted
)

// enrolLeaves makes the devices of a seeded group's leaves devices of this instance, as signup and
// pairing leave them: one user per distinct user id with an SSK, one device row per leaf, one
// signed device list per user. how decides each leaf's enrolment; nil is enrolHonest for all.
func (h *dsHarness) enrolLeaves(t *testing.T, groupID id.ID, how func(leaf uint32) leafEnrolment) {
	t.Helper()
	members, err := h.repo.ListMembers(context.Background(), groupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	ssk := testSSK(0x75)
	lists := map[id.ID][]listEntry{}
	var order []id.ID
	for _, m := range members {
		e := enrolHonest
		if how != nil {
			e = how(m.LeafIndex)
		}
		if _, seen := lists[m.UserID]; !seen {
			order = append(order, m.UserID)
			lists[m.UserID] = nil
			if _, err := h.repo.GetUser(context.Background(), m.UserID); err != nil {
				h.userWithSSK(t, m.UserID, ssk)
			}
		}
		switch e {
		case enrolNone:
			continue
		case enrolOtherKey:
			other := bytes.Repeat([]byte{0x5f}, 32)
			h.accountWithKey(t, m.UserID, m.DeviceID, other)
			lists[m.UserID] = append(lists[m.UserID], listEntry{DeviceID: m.DeviceID[:], DSKPub: other, AddedAt: 1})
		case enrolUnlisted:
			h.accountWithKey(t, m.UserID, m.DeviceID, m.SignatureKey)
		default:
			h.accountWithKey(t, m.UserID, m.DeviceID, m.SignatureKey)
			lists[m.UserID] = append(lists[m.UserID], listEntry{DeviceID: m.DeviceID[:], DSKPub: m.SignatureKey, AddedAt: 1})
		}
	}
	for _, user := range order {
		h.publishDeviceList(t, user, signedDeviceList(t, ssk, user, lists[user]))
	}
}

// enrolledGroup is h.group with every leaf of the fixture a real device of this instance: a reseed
// adopts the uploaded tree only when every leaf passes the Add clause (G2b), so a test of an
// accepted reseed needs the fixture's 1,500 devices to exist as signup left them.
func (h *dsHarness) enrolledGroup(t *testing.T) *dsMessageGroup {
	t.Helper()
	got, session := h.mustRegister(t)
	h.enrolLeaves(t, got.GroupID, nil)
	row, err := h.repo.GetGroup(context.Background(), got.GroupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	g := &dsMessageGroup{id: got.GroupID, device: session.DeviceID, session: session, epoch: row.Epoch}
	if h.sessions == nil {
		h.sessions = map[id.ID]auth.Session{}
	}
	h.sessions[g.device] = session
	return g
}

// G2b: a reseed whose tree holds a leaf that would not pass the Add clause is refused, and the group
// is left exactly as the restore left it (epoch-unknown, the restored member rows, no handshake
// row). Each case spoils one leaf - leaf 7, not the healer's - of an otherwise honest group; the
// honest reseed of the same group is accepted (TestAHealWithNoBlobReseedsFromTheSuppliedTree).
func TestAReseedRefusesATreeWithALeafThatWouldNotPassTheAddClause(t *testing.T) {
	const spoiled = 7
	for _, c := range []struct {
		name string
		how  leafEnrolment
		acl  bool // the leaf's user is forbidden by the ACL instead
		rule string
	}{
		{"a leaf's device is unknown to the instance", enrolNone, false, "add_key_package"},
		{"a leaf's key is not its device's registered key", enrolOtherKey, false, "add_key_package"},
		{"a leaf's device is not in its user's signed list", enrolUnlisted, false, "add_key_package"},
		{"a leaf's user is not eligible under the ACL", enrolHonest, true, "add_acl"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newDSHarness(t)
			got, session := h.mustRegister(t)
			h.enrolLeaves(t, got.GroupID, func(leaf uint32) leafEnrolment {
				if leaf == spoiled {
					return c.how
				}
				return enrolHonest
			})
			members, err := h.repo.ListMembers(context.Background(), got.GroupID)
			if err != nil {
				t.Fatalf("ListMembers: %v", err)
			}
			if c.acl {
				for _, m := range members {
					if m.LeafIndex == spoiled {
						h.acl.forbid(m.UserID)
					}
				}
			}
			g := &dsMessageGroup{id: got.GroupID, device: session.DeviceID, session: session, epoch: 6}
			tree := h.currentTree(t, g)
			groupInfo := h.groupInfoAt(t, g, g.Epoch())
			if err := h.ds.OnRestore(context.Background(), h.generation(t)+1); err != nil {
				t.Fatalf("OnRestore: %v", err)
			}
			h.destroyStateBlob(t, g)

			_, err = h.ds.Heal(context.Background(), session, g.id, ds.HealRequest{
				GroupInfo: groupInfo, RatchetTree: tree,
			})
			if !hasRule(err, c.rule) {
				t.Fatalf("got %v, want E_COMMIT_INVALID/%s", err, c.rule)
			}
			if !h.epochUnknown(t, g.id) {
				t.Error("a refused reseed must leave the group epoch-unknown")
			}
			if got := h.handshakeCount(t, g.id); got != 0 {
				t.Errorf("a refused reseed wrote %d handshake rows", got)
			}
			after, err := h.repo.ListMembers(context.Background(), g.id)
			if err != nil || len(after) != len(members) {
				t.Errorf("the member rows changed: %d -> %d (%v)", len(members), len(after), err)
			}
		})
	}
}

// T2: the key check on a replayed resync (checkHealedExternalCommit) is pinned. A replayed external
// commit that removes the joiner's previous leaf and lands the device back with a key that is not
// its registered key is refused with the joiner's rule; the same check passes when the key is the
// registered one. The clause is asserted over the merged state it is defined on - the fixture holds
// no external commit, and the honest replayed resync is driven end to end by internal/testkit's
// heal scenarios.
func TestAReplayedResyncMustLandOnTheDevicesRegisteredKey(t *testing.T) {
	h := newDSHarness(t)
	got, _ := h.mustRegister(t)
	members, err := h.repo.ListMembers(context.Background(), got.GroupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	var joiner store.MemberRow
	for _, m := range members {
		if m.LeafIndex == 3 {
			joiner = m
		}
	}
	h.enrolLeaves(t, got.GroupID, nil)
	identity, _, _ := h.memberIdentity(t, got.GroupID, 3)
	before := map[uint32][2]id.ID{}
	for _, m := range members {
		before[m.LeafIndex] = [2]id.ID{m.DeviceID, m.UserID}
	}
	removed := joiner.LeafIndex
	applied := []mlswasi.AppliedProposal{{Kind: mlswasi.ProposalRemove, TargetLeaf: &removed}}
	after := func(key []byte) mlswasi.GroupState {
		return mlswasi.GroupState{Members: []mlswasi.Member{{
			LeafIndex: 1_500, SignatureKey: key, CredentialIdentity: identity,
		}}}
	}

	if _, err := ds.CheckHealedExternalCommitForTest(h.ds, context.Background(), got.GroupID, before,
		after(bytes.Repeat([]byte{0x5f}, 32)), applied); !hasRule(err, "external_joiner") {
		t.Fatalf("a replayed resync on a key the device never registered: got %v, want E_COMMIT_INVALID/external_joiner", err)
	}
	device, err := ds.CheckHealedExternalCommitForTest(h.ds, context.Background(), got.GroupID, before,
		after(joiner.SignatureKey), applied)
	if err != nil || device != joiner.DeviceID {
		t.Fatalf("the replayed resync on the registered key: %v, %v; want %s", device, err, joiner.DeviceID)
	}
}
