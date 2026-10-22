package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type membershipFakeNative struct {
	binding              native.Binding
	groups               []native.GroupInfo
	inspected            native.GroupInfo
	welcomes             []native.GroupWelcome
	expected             []native.GroupExpected
	outcomes             []native.GroupWelcomeOutcome
	state                native.StateValue
	acks                 []id.ID
	applyCalls           int
	applyErr             error
	changeGroupOnInspect bool
}

func (n *membershipFakeNative) Binding() native.Binding { return n.binding }
func (n *membershipFakeNative) Groups(context.Context) ([]native.GroupInfo, error) {
	return n.groups, nil
}
func (n *membershipFakeNative) InspectGroup(_ context.Context, group id.ID) (native.GroupInfo, error) {
	if n.inspected.ID != group {
		return native.GroupInfo{}, errors.New("unknown group")
	}
	got := n.inspected
	if n.changeGroupOnInspect {
		got.Target = membershipID(77)
	}
	return got, nil
}
func (n *membershipFakeNative) ApplyGroup(context.Context, id.ID, []byte, []byte, uint64) (native.GroupApplyResult, error) {
	return native.GroupApplyResult{}, nil
}
func (n *membershipFakeNative) GroupCursor(context.Context, id.ID) (*native.GroupCursor, error) {
	return nil, nil
}
func (n *membershipFakeNative) AcknowledgeGroupCursor(context.Context, id.ID, native.GroupCursor) error {
	return nil
}
func (n *membershipFakeNative) ApplyWelcomes(_ context.Context, ws []native.GroupWelcome, expected []native.GroupExpected) ([]native.GroupWelcomeOutcome, error) {
	n.applyCalls++
	n.welcomes = append(n.welcomes, ws...)
	n.expected = append([]native.GroupExpected(nil), expected...)
	return n.outcomes, n.applyErr
}
func (n *membershipFakeNative) StateGet(context.Context, uint64, []byte) (native.StateValue, error) {
	return n.state, nil
}
func (n *membershipFakeNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	n.state = native.StateValue{Revision: n.state.Revision + 1, Value: changes[0].Value}
	return []uint64{n.state.Revision}, nil
}

type membershipFakeSession struct {
	communities         []client.Community
	channels            []client.Channel
	welcomes            []client.Welcome
	acked               []uint64
	ackErr              error
	channelsCalls       int
	removeOnSecond      bool
	changeGroupOnSecond bool
}

func (s *membershipFakeSession) Communities(context.Context) ([]client.Community, error) {
	return s.communities, nil
}
func (s *membershipFakeSession) Channels(context.Context, id.ID) ([]client.Channel, error) {
	s.channelsCalls++
	if s.removeOnSecond && s.channelsCalls > 1 {
		return nil, nil
	}
	if s.changeGroupOnSecond && s.channelsCalls > 1 {
		copy := append([]client.Channel(nil), s.channels...)
		other := membershipID(88)
		copy[0].TextGroupID = &other
		return copy, nil
	}
	return s.channels, nil
}
func (s *membershipFakeSession) Welcomes(_ context.Context, after, limit uint64) ([]client.Welcome, error) {
	out := []client.Welcome{}
	for _, w := range s.welcomes {
		if w.ID > after && uint64(len(out)) < limit {
			out = append(out, w)
		}
	}
	return out, nil
}
func (s *membershipFakeSession) AcknowledgeWelcome(_ context.Context, w uint64) error {
	s.acked = append(s.acked, w)
	return s.ackErr
}
func (s *membershipFakeSession) GroupInfo(context.Context, id.ID) (client.GroupInfo, error) {
	return client.GroupInfo{NextSequence: 1}, nil
}
func (s *membershipFakeSession) GroupPage(context.Context, id.ID, string, uint64, uint64) (client.Page, error) {
	return client.Page{Next: 1}, nil
}
func (s *membershipFakeSession) AdvanceCursor(context.Context, id.ID, uint64, uint64) error {
	return nil
}

func membershipID(n byte) id.ID { var v id.ID; v[15] = n; return v }
func membershipFixture(t *testing.T) (*MembershipReconciler, *membershipFakeNative, *membershipFakeSession, id.ID, id.ID, id.ID) {
	t.Helper()
	community, install, channel, group := membershipID(1), membershipID(2), membershipID(3), membershipID(4)
	n := &membershipFakeNative{binding: native.Binding{Instance: membershipID(9), Community: community, Installation: install}}
	s := &membershipFakeSession{communities: []client.Community{{ID: community, Name: "own", OwnerID: membershipID(8)}}, channels: []client.Channel{{ID: channel, CommunityID: community, Kind: 0, TextGroupID: &group}}}
	r, err := newMembershipReconciler(n, sourceSyncOptions{}, membershipOptions{WelcomePageLimit: 8})
	if err != nil {
		t.Fatal(err)
	}
	return r, n, s, community, channel, group
}
func TestMembershipDuplicateWelcomeIsAppliedIdempotentlyAndAcked(t *testing.T) {
	r, n, s, community, channel, group := membershipFixture(t)
	s.welcomes = []client.Welcome{{ID: 1, GroupID: group, Epoch: 2, CommitSequence: 4, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}, {ID: 2, GroupID: group, Epoch: 2, CommitSequence: 4, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 1, Group: group, Outcome: 0}, {ID: 2, Group: group, Outcome: 1}}
	result, err := r.reconcileOnce(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if result.Applied != 2 || len(s.acked) != 2 || n.applyCalls != 1 || len(n.expected) != 1 {
		t.Fatalf("result=%+v ack=%v apply=%d", result, s.acked, n.applyCalls)
	}
	r, err = newMembershipReconciler(n, sourceSyncOptions{}, membershipOptions{WelcomePageLimit: 8})
	if err != nil {
		t.Fatal(err)
	}
	s.welcomes = []client.Welcome{{ID: 3, GroupID: group, Epoch: 2, CommitSequence: 4, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 3, Group: group, Outcome: 1}}
	if _, err = r.reconcileOnce(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if len(s.acked) != 3 || s.acked[2] != 3 || s.channels[0].ID != channel || community != n.binding.Community {
		t.Fatal("idempotent duplicate was not acknowledged")
	}
}
func TestMembershipRejectsWrongCommunityAndRemovedChannelWithoutAck(t *testing.T) {
	r, n, s, community, _, group := membershipFixture(t)
	s.welcomes = []client.Welcome{{ID: 7, GroupID: group, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	s.communities[0].ID = membershipID(99)
	if _, err := r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("wrong community accepted")
	}
	if len(s.acked) != 0 || n.applyCalls != 0 {
		t.Fatal("wrong community mutated or acknowledged")
	}
	s.communities = []client.Community{{ID: community, Name: "own", OwnerID: membershipID(8)}}
	s.channels = nil
	if _, err := r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("inaccessible channel accepted")
	}
	if len(s.acked) != 0 || n.applyCalls != 0 {
		t.Fatal("inaccessible channel mutated or acknowledged")
	}
}
func TestMembershipAckFailureRetriesDurableWelcomeAndCursor(t *testing.T) {
	r, n, s, _, _, group := membershipFixture(t)
	s.welcomes = []client.Welcome{{ID: 1, GroupID: group, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 1, Group: group, Outcome: 0}}
	s.ackErr = errors.New("ack lost")
	if _, err := r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("ack failure hidden")
	}
	if n.state.Revision != 0 {
		t.Fatal("cursor advanced before acknowledgement")
	}
	var err error
	r, err = newMembershipReconciler(n, sourceSyncOptions{}, membershipOptions{WelcomePageLimit: 8})
	if err != nil {
		t.Fatal(err)
	}
	s.ackErr = nil
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 1, Group: group, Outcome: 1}}
	if _, err := r.reconcileOnce(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if n.applyCalls != 2 || len(s.acked) != 2 || n.state.Revision != 1 {
		t.Fatalf("apply=%d ack=%d revision=%d", n.applyCalls, len(s.acked), n.state.Revision)
	}
}

func TestMembershipSyncsOnlyGroupsWhoseNativeBindingMatchesAuthorizedChannel(t *testing.T) {
	r, n, s, community, channel, group := membershipFixture(t)
	groupInfo := native.GroupInfo{ID: group, Kind: 0, Community: &community, Target: channel, State: 2, NextSequence: 1}
	n.groups = []native.GroupInfo{groupInfo}
	n.inspected = groupInfo
	result, err := r.reconcileOnce(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if result.GroupsSynced != 1 || result.SourcePages != 0 {
		t.Fatalf("sync result=%+v", result)
	}
	n.inspected.Target = membershipID(77)
	if _, err = r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("native group rebound to another channel was accepted")
	}
}

func TestMembershipRechecksAccessBeforeAcknowledgingWelcome(t *testing.T) {
	r, n, s, _, _, group := membershipFixture(t)
	s.welcomes = []client.Welcome{{ID: 3, GroupID: group, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 3, Group: group, Outcome: 0}}
	s.removeOnSecond = true
	if _, err := r.reconcileOnce(context.Background(), s); !errors.Is(err, ErrMembershipUnproven) {
		t.Fatalf("error=%v", err)
	}
	if len(s.acked) != 0 || n.state.Revision != 0 {
		t.Fatal("revoked channel welcome was acknowledged or cursor advanced")
	}
}

func TestMembershipRechecksTextGroupAssociationBeforeAcknowledging(t *testing.T) {
	r, n, s, _, _, group := membershipFixture(t)
	s.welcomes = []client.Welcome{{ID: 4, GroupID: group, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 4, Group: group, Outcome: 0}}
	s.changeGroupOnSecond = true
	if _, err := r.reconcileOnce(context.Background(), s); !errors.Is(err, ErrMembershipUnproven) {
		t.Fatalf("error=%v", err)
	}
	if len(s.acked) != 0 || n.state.Revision != 0 {
		t.Fatal("welcome acknowledged after text group association changed")
	}
}

func TestMembershipRechecksVoiceGroupTargetBeforeAcknowledging(t *testing.T) {
	r, n, s, community, channel, group := membershipFixture(t)
	s.channels[0].Kind = 1
	s.channels[0].TextGroupID = nil
	n.groups = []native.GroupInfo{{ID: group, Kind: 1, Community: &community, Target: channel, State: 2}}
	n.inspected = n.groups[0]
	n.changeGroupOnInspect = true
	s.welcomes = []client.Welcome{{ID: 5, GroupID: group, Blob: []byte{1}, Tree: []byte{2}, TreeHash: make([]byte, 32)}}
	n.outcomes = []native.GroupWelcomeOutcome{{ID: 5, Group: group, Outcome: 1}}
	if _, err := r.reconcileOnce(context.Background(), s); !errors.Is(err, ErrMembershipUnproven) {
		t.Fatalf("error=%v", err)
	}
	if len(s.acked) != 0 || n.state.Revision != 0 {
		t.Fatal("welcome acknowledged after voice group target changed")
	}
}
