package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type membershipFakeNative struct {
	binding                native.Binding
	groups                 []native.GroupInfo
	interactionGroups      []native.InteractionGroupDescriptor
	interactionInspected   native.InteractionGroupInspectResult
	inspected              native.GroupInfo
	welcomes               []native.GroupWelcome
	expected               []native.GroupExpected
	outcomes               []native.GroupWelcomeOutcome
	state                  native.StateValue
	applyCalls             int
	applyErr               error
	interactionCursorCalls int
	interactionApplyCalls  int
	interactionAckCalls    int
	genericApplyCalls      int
	genericCursorCalls     int
	genericAckCalls        int
	interactionCursor      *native.GroupCursor
	changeGroupOnInspect   bool
}

func (n *membershipFakeNative) Binding() native.Binding { return n.binding }
func (n *membershipFakeNative) Groups(context.Context) ([]native.GroupInfo, error) {
	return n.groups, nil
}
func (n *membershipFakeNative) InteractionGroups(context.Context) ([]native.InteractionGroupDescriptor, error) {
	return n.interactionGroups, nil
}
func (n *membershipFakeNative) InspectInteractionGroup(context.Context, native.InteractionGroupExpected, []byte) (native.InteractionGroupInspectResult, error) {
	return n.interactionInspected, nil
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
	n.genericApplyCalls++
	return native.GroupApplyResult{}, nil
}
func (n *membershipFakeNative) GroupCursor(context.Context, id.ID) (*native.GroupCursor, error) {
	n.genericCursorCalls++
	return nil, nil
}
func (n *membershipFakeNative) AcknowledgeGroupCursor(context.Context, id.ID, native.GroupCursor) error {
	n.genericAckCalls++
	return nil
}
func (n *membershipFakeNative) InteractionGroupCursor(_ context.Context, expected native.InteractionGroupExpected, snapshot []byte) (*native.GroupCursor, error) {
	n.interactionCursorCalls++
	if expected.Group.IsZero() || len(snapshot) == 0 {
		return nil, errors.New("missing kind3 proof")
	}
	return n.interactionCursor, nil
}
func (n *membershipFakeNative) ApplyInteractionGroup(_ context.Context, expected native.InteractionGroupExpected, snapshot, handshakes, messages []byte, through uint64) (native.GroupApplyResult, error) {
	n.interactionApplyCalls++
	if expected.Group.IsZero() || len(snapshot) == 0 || through == 0 {
		return native.GroupApplyResult{}, errors.New("missing kind3 proof")
	}
	n.interactionCursor = &native.GroupCursor{Sequence: through, Epoch: 1}
	n.interactionInspected.NextSequence = through + 1
	return native.GroupApplyResult{State: 2, NextSequence: through + 1}, nil
}
func (n *membershipFakeNative) AcknowledgeInteractionGroupCursor(_ context.Context, expected native.InteractionGroupExpected, snapshot []byte, _ native.GroupCursor) error {
	n.interactionAckCalls++
	if expected.Group.IsZero() || len(snapshot) == 0 {
		return errors.New("missing kind3 proof")
	}
	n.interactionCursor = nil
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
	communities           []client.Community
	community             client.Community
	communityCalls        int
	communitiesCalls      int
	channels              []client.Channel
	welcomes              []client.Welcome
	acked                 []uint64
	ackErr                error
	channelsCalls         int
	groupInfo             client.GroupInfo
	groupPageErr          error
	groupPageCalls        int
	removeOnSecond        bool
	changeGroupOnSecond   bool
	interactionBinding    native.InteractionGroupBinding
	interactionBotDevice  id.ID
	interactionGroup      id.ID
	interactionInfo       client.GroupInfo
	interactionPages      map[sourcePageKey]client.Page
	interactionPageCalls  []sourcePageKey
	interactionAdmissions int
	interactionSnapshots  int
}

func (s *membershipFakeSession) Communities(context.Context) ([]client.Community, error) {
	s.communitiesCalls++
	return s.communities, nil
}
func (s *membershipFakeSession) Community(_ context.Context, community id.ID) (client.Community, error) {
	s.communityCalls++
	return s.community, nil
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
	if s.groupInfo.NextSequence != 0 {
		return s.groupInfo, nil
	}
	return client.GroupInfo{NextSequence: 1}, nil
}
func (s *membershipFakeSession) BotInteractionGroupInfo(context.Context, id.ID, id.ID) (client.GroupInfo, error) {
	if s.interactionInfo.NextSequence != 0 {
		return s.interactionInfo, nil
	}
	return client.GroupInfo{NextSequence: 1}, nil
}
func (s *membershipFakeSession) GroupPage(context.Context, id.ID, string, uint64, uint64) (client.Page, error) {
	s.groupPageCalls++
	if s.groupPageErr != nil {
		return client.Page{}, s.groupPageErr
	}
	return client.Page{Next: 1}, nil
}
func (s *membershipFakeSession) BotInteractionGroupPage(_ context.Context, _, _ id.ID, kind string, from, _ uint64) (client.Page, error) {
	key := sourcePageKey{kind: kind, from: from}
	s.interactionPageCalls = append(s.interactionPageCalls, key)
	return s.interactionPages[key], nil
}
func (s *membershipFakeSession) AdvanceCursor(context.Context, id.ID, uint64, uint64) error {
	return nil
}
func (s *membershipFakeSession) AdvanceBotInteractionGroupCursor(context.Context, id.ID, id.ID, uint64, uint64) error {
	return nil
}
func (s *membershipFakeSession) IssueBotInteractionAdmission(_ context.Context, _, _, _, _, _ id.ID) ([]byte, error) {
	s.interactionAdmissions++
	return []byte{1}, nil
}
func (s *membershipFakeSession) BotInteractionContextSnapshot(_ context.Context, _, request, group, user, device id.ID) ([]byte, error) {
	s.interactionSnapshots++
	b := s.interactionBinding
	expected := []any{b.Instance, b.Installation, b.Community, b.BotUser, s.interactionBotDevice, user, device, group}
	return makeSignedSnapshotFixtureFor(request, expected, 100)
}

func membershipID(n byte) id.ID { var v id.ID; v[15] = n; return v }
func membershipFixture(t *testing.T) (*MembershipReconciler, *membershipFakeNative, *membershipFakeSession, id.ID, id.ID, id.ID) {
	t.Helper()
	community, install, channel, group := membershipID(1), membershipID(2), membershipID(3), membershipID(4)
	n := &membershipFakeNative{binding: native.Binding{Instance: membershipID(9), Community: community, Installation: install}}
	s := &membershipFakeSession{communities: []client.Community{{ID: community, Name: "own", OwnerID: membershipID(8)}}, community: client.Community{ID: community, Name: "own", OwnerID: membershipID(8)}, channels: []client.Channel{{ID: channel, CommunityID: community, Kind: 0, TextGroupID: &group}}}
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
	s.community.ID = membershipID(99)
	if _, err := r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("wrong community accepted")
	}
	if len(s.acked) != 0 || n.applyCalls != 0 {
		t.Fatal("wrong community mutated or acknowledged")
	}
	s.community = client.Community{ID: community, Name: "own", OwnerID: membershipID(8)}
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

func TestMembershipTreatsNonmemberCallGroupSourceAsPending(t *testing.T) {
	for _, tc := range []struct {
		name    string
		kind    uint64
		code    string
		wantErr bool
	}{
		{name: "call group", kind: 1, code: "E_NOT_FOUND"},
		{name: "unexpected call error", kind: 1, code: "E_OTHER", wantErr: true},
		{name: "text group", kind: 0, code: "E_NOT_FOUND", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, n, s, community, channel, group := membershipFixture(t)
			channelKind := tc.kind
			s.channels = []client.Channel{{ID: channel, CommunityID: community, Kind: channelKind}}
			if tc.kind == 0 {
				s.channels[0].TextGroupID = &group
			}
			info := native.GroupInfo{ID: group, Kind: tc.kind, Community: &community, Target: channel, State: 2, NextSequence: 1}
			n.groups, n.inspected = []native.GroupInfo{info}, info
			s.groupInfo = client.GroupInfo{NextSequence: 2}
			s.groupPageErr = &client.APIError{Status: 404, Code: tc.code}
			_, err := r.reconcileOnce(context.Background(), s)
			if (err != nil) != tc.wantErr {
				t.Fatalf("reconcile error = %v, wantErr %v", err, tc.wantErr)
			}
			if s.groupPageCalls != 1 {
				t.Fatalf("group page calls = %d, want 1", s.groupPageCalls)
			}
		})
	}
}

func TestMembershipSyncsActiveInteractionGroupsByExactNativeTarget(t *testing.T) {
	r, n, s, community, _, _ := membershipFixture(t)
	now := time.Unix(100, 0)
	var err error
	r.source, err = newSourceSync(n, sourceSyncOptions{now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	group, participant := membershipID(21), membershipID(22)
	binding := native.InteractionGroupBinding{Instance: n.binding.Instance, Installation: n.binding.Installation, Community: community,
		BotUser: membershipID(23), ParticipantUser: participant, ParticipantDevice: membershipID(24), PolicyVersion: 3, E2EEVersion: 1}
	botDevice := membershipID(25)
	descriptor := native.InteractionGroupDescriptor{Group: group, Binding: binding, BotDevice: botDevice, Epoch: 1, State: 2}
	n.interactionGroups = []native.InteractionGroupDescriptor{descriptor}
	n.interactionInspected = native.InteractionGroupInspectResult{Binding: binding, BotDevice: botDevice, Epoch: 1, State: 2, NextSequence: 1}
	s.interactionBinding, s.interactionBotDevice, s.interactionGroup = binding, botDevice, group
	result, err := r.reconcileOnce(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if result.GroupsSynced != 1 || result.SourcePages != 0 || s.interactionAdmissions != 1 || s.interactionSnapshots != 1 || n.interactionCursorCalls != 1 {
		t.Fatalf("sync result=%+v", result)
	}
	if _, err = r.reconcileOnce(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if s.interactionAdmissions != 1 || s.interactionSnapshots != 1 {
		t.Fatal("unexpired current snapshot was unnecessarily reissued")
	}
	now = now.Add(16 * time.Second)
	if _, err = r.reconcileOnce(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if s.interactionAdmissions != 2 || s.interactionSnapshots != 2 {
		t.Fatal("expired current snapshot was reused")
	}
	r, err = newMembershipReconciler(n, sourceSyncOptions{now: func() time.Time { return now }}, membershipOptions{WelcomePageLimit: 8})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.reconcileOnce(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	if s.interactionAdmissions != 3 || s.interactionSnapshots != 3 {
		t.Fatal("new reconciler reused an in-memory snapshot from before restart")
	}
	n.interactionGroups[0].Binding.ParticipantUser = membershipID(23)
	if _, err = r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("interaction group rebound to another participant was accepted")
	}
}

func TestInteractionSourceSyncUsesProofBoundNativeCursorApplyAndAck(t *testing.T) {
	r, n, s, community, _, _ := membershipFixture(t)
	now := time.Unix(100, 0)
	var err error
	r.source, err = newSourceSync(n, sourceSyncOptions{PageLimit: 4, PageBudget: 1, now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	group, participant := membershipID(31), membershipID(32)
	binding := native.InteractionGroupBinding{Instance: n.binding.Instance, Installation: n.binding.Installation, Community: community,
		BotUser: membershipID(33), ParticipantUser: participant, ParticipantDevice: membershipID(34), PolicyVersion: 3, E2EEVersion: 1}
	botDevice := membershipID(35)
	n.interactionGroups = []native.InteractionGroupDescriptor{{Group: group, Binding: binding, BotDevice: botDevice, Epoch: 1, State: 2}}
	n.interactionInspected = native.InteractionGroupInspectResult{Binding: binding, BotDevice: botDevice, Epoch: 1, State: 2, NextSequence: 1}
	s.interactionBinding, s.interactionBotDevice, s.interactionGroup = binding, botDevice, group
	s.interactionInfo = client.GroupInfo{Epoch: 1, NextSequence: 3}
	s.interactionPages = map[sourcePageKey]client.Page{
		{kind: "handshakes", from: 1}: {Rows: [][]any{sourceHandshake(1)}, Next: 2},
		{kind: "messages", from: 1}:   {Rows: [][]any{sourceMessage(2)}, Next: 3},
	}
	expected := native.GroupExpected{Group: group, Community: community, Channel: participant, Kind: 3}
	result, err := r.source.sync(context.Background(), s, expected)
	if err != nil {
		t.Fatal(err)
	}
	if result.Pages != 1 || result.AppliedThrough != 2 || n.interactionApplyCalls != 1 || n.interactionCursorCalls != 2 || n.interactionAckCalls != 1 {
		t.Fatalf("result=%+v interaction calls: apply=%d cursor=%d ack=%d", result, n.interactionApplyCalls, n.interactionCursorCalls, n.interactionAckCalls)
	}
	if n.genericApplyCalls != 0 || n.genericCursorCalls != 0 || n.genericAckCalls != 0 {
		t.Fatalf("kind3 reached generic native ops: apply=%d cursor=%d ack=%d", n.genericApplyCalls, n.genericCursorCalls, n.genericAckCalls)
	}
	if s.interactionAdmissions != 1 || s.interactionSnapshots != 1 || len(s.interactionPageCalls) != 2 {
		t.Fatalf("proof/page counts: admissions=%d snapshots=%d pages=%v", s.interactionAdmissions, s.interactionSnapshots, s.interactionPageCalls)
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

func TestMembershipReconcilerUsesExactBoundCommunityRead(t *testing.T) {
	r, _, s, community, _, _ := membershipFixture(t)
	s.community = client.Community{ID: community, Name: "own", OwnerID: membershipID(8)}
	result, err := r.reconcileOnce(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if s.communityCalls != 1 || s.communitiesCalls != 0 {
		t.Fatalf("community reads: exact=%d global=%d", s.communityCalls, s.communitiesCalls)
	}
	_ = result
}

func TestMembershipReconcilerRejectsMismatchedBoundCommunityResponse(t *testing.T) {
	r, n, s, _, _, _ := membershipFixture(t)
	s.community = client.Community{ID: membershipID(99), Name: "other", OwnerID: membershipID(8)}
	if _, err := r.reconcileOnce(context.Background(), s); err == nil {
		t.Fatal("mismatched community response accepted")
	}
	if n.applyCalls != 0 {
		t.Fatal("mismatched community caused a mutation")
	}
}
