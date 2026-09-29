package ds_test

// join_test.go is the external JOIN: a device that is not yet a member joins a text or call group
// by external commit (protocol/01 § Joining: "An online device joins by external commit using the
// GroupInfo and ratchet tree served by the DS. The DS refuses external commits while a DS proposal
// is outstanding, except when no member device is online"). POST /v1/groups/{id}/resync is the one
// external-commit route; a device that holds a leaf is resyncing (R25, freeze-exempt), and one that
// holds none is joining, which the freeze governs and the channel ACL gates.
//
// The joiner's accepted commit, and invariant 5's nobody-online exception it drives, need real
// external-commit material; they run end to end in internal/testkit's scenarios
// external_commit_during_freeze_online and external_commit_during_freeze_offline.

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

// fakeACL is ds.DenyUnlessMember plus an explicit set of users a test declares eligible. It is the
// seam Plan 2 task 3's permission resolver fills, not a double of the delivery service.
type fakeACL struct {
	deny     ds.DenyUnlessMember
	mu       sync.Mutex
	eligible map[id.ID]bool
}

func (a *fakeACL) Eligible(ctx context.Context, groupID, userID id.ID) (bool, error) {
	a.mu.Lock()
	ok := a.eligible[userID]
	a.mu.Unlock()
	if ok {
		return true, nil
	}
	return a.deny.Eligible(ctx, groupID, userID)
}

func (a *fakeACL) allow(userID id.ID) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.eligible[userID] = true
}

// A device the channel ACL admits reads what an external join needs: the GroupInfo and the tree
// the instance serves (invariant 2). Without them no eligible device can ever join a text group.
func TestAnEligibleNonMemberReadsTheGroupInfoAndTheTree(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	joiner := h.device(t)
	session := h.sessionOf(t, joiner)
	h.acl.allow(session.UserID)

	info, err := h.ds.Info(context.Background(), reg.GroupID, session)
	if err != nil {
		t.Fatalf("Info for an eligible joiner: %v", err)
	}
	if len(info.GroupInfo) == 0 || len(info.TreeHash) == 0 {
		t.Fatal("the joiner was served no GroupInfo or no tree hash")
	}
	tree, err := h.ds.Tree(context.Background(), reg.GroupID, session)
	if err != nil {
		t.Fatalf("Tree for an eligible joiner: %v", err)
	}
	if len(tree.RatchetTree) == 0 {
		t.Fatal("the joiner was served no tree")
	}
}

// A device the ACL does not admit learns nothing: every read and the join itself are E_NOT_FOUND,
// never E_FORBIDDEN, so group existence stays unprobeable.
func TestAnIneligibleNonMemberCanNeitherReadNorJoin(t *testing.T) {
	h := newDSHarness(t)
	reg, _ := h.mustRegister(t)
	stranger := h.sessionOf(t, h.device(t))

	var dsErr *ds.Error
	if _, err := h.ds.Info(context.Background(), reg.GroupID, stranger); !errors.As(err, &dsErr) ||
		dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("Info: got %v, want E_NOT_FOUND", err)
	}
	if _, err := h.ds.Tree(context.Background(), reg.GroupID, stranger); !errors.As(err, &dsErr) ||
		dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("Tree: got %v, want E_NOT_FOUND", err)
	}
	_, err := h.ds.Resync(context.Background(), stranger, reg.GroupID, ds.ResyncRequest{
		ExternalCommit: []byte{0x00}, GroupInfo: []byte{0x01},
	})
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("Resync by an ineligible stranger: got %v, want E_NOT_FOUND", err)
	}
}

// Invariant 5: while an instance proposal is outstanding and a member device is online, an
// external JOIN is refused 425 with the outstanding proposals — it is not the freeze-exempt resync
// R25 carves out, because the joiner holds no leaf to resync. The refusal comes before the commit
// is parsed, so the bytes here need not be a commit at all.
func TestAnExternalJoinIsHeldByTheFreezeWhileAMemberIsOnline(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.online(g.members[0])
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	joiner := h.sessionOf(t, h.device(t))
	h.acl.allow(joiner.UserID)

	_, err := h.ds.Resync(context.Background(), joiner, g.id, ds.ResyncRequest{
		ExternalCommit: []byte{0x00, 0x01, 0x02}, GroupInfo: []byte{0x03},
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_REQUIRED" {
		t.Fatalf("an external join during a freeze: got %v, want E_COMMIT_REQUIRED", err)
	}
	if dsErr.Status != 425 {
		t.Errorf("status = %d, want 425", dsErr.Status)
	}
	if len(dsErr.Proposals) == 0 {
		t.Error("the refusal must carry the outstanding proposals")
	}
}

// …and with nobody online the freeze does not hold the join: it reaches the parse (and, with real
// material, is accepted and the omitted proposals re-issued — the scenario's half).
func TestWithNobodyOnlineAnExternalJoinIsNotHeldByTheFreeze(t *testing.T) {
	h := newDSHarness(t)
	g := h.groupWithMembers(t, 2)
	h.offline(g.members[0], g.members[1])
	if err := h.ds.ProposeRemove(context.Background(), g.id, g.leafOf(1), id.New()); err != nil {
		t.Fatalf("ProposeRemove: %v", err)
	}
	joiner := h.sessionOf(t, h.device(t))
	h.acl.allow(joiner.UserID)

	_, err := h.ds.Resync(context.Background(), joiner, g.id, ds.ResyncRequest{
		ExternalCommit: []byte{0x00, 0x01, 0x02}, GroupInfo: []byte{0x03},
	})
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want the parse's E_COMMIT_INVALID: nobody is online, so no freeze holds", err)
	}
}
