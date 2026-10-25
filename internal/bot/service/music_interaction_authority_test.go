package service

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type musicAuthoritySessionFake struct {
	actor              client.ActorAuthority
	present            bool
	call               client.ChannelCallState
	permissions        uint64
	permissionSequence []uint64
}

func (s *musicAuthoritySessionFake) BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error) {
	return s.actor, s.present, nil
}
func (s *musicAuthoritySessionFake) ChannelCall(context.Context, id.ID) (client.ChannelCallState, error) {
	return s.call, nil
}
func (s *musicAuthoritySessionFake) ChannelPermissions(context.Context, id.ID) (uint64, error) {
	if len(s.permissionSequence) > 0 {
		bits := s.permissionSequence[0]
		s.permissionSequence = s.permissionSequence[1:]
		return bits, nil
	}
	return s.permissions, nil
}

type musicAuthorityStoreFake struct {
	installation store.BotInstallationRow
	policy       []store.DJRolePolicyRow
}

func (s *musicAuthorityStoreFake) GetActiveBotInstallationByCommunity(context.Context, id.ID) (store.BotInstallationRow, error) {
	return s.installation, nil
}
func (s *musicAuthorityStoreFake) ListDJRolePolicy(context.Context, id.ID) ([]store.DJRolePolicyRow, error) {
	return s.policy, nil
}

func TestMusicAuthorityRequiresCurrentChannelMemberAndApprovedRole(t *testing.T) {
	community, installationID, channel, actorID, callID, djRole := id.New(), id.New(), id.New(), id.New(), id.New(), id.New()
	actor := InteractionActor{User: actorID}
	installation := store.BotInstallationRow{ID: installationID, CommunityID: community, State: store.BotInstallationReady, Capabilities: musicBotCapability}
	session := &musicAuthoritySessionFake{
		actor: client.ActorAuthority{RoleIDs: []id.ID{djRole}}, present: true,
		call:        client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New()), Participants: []client.CallParticipant{{UserID: actorID}}},
		permissions: musicPermissionConnect | musicPermissionSpeak,
	}
	storeFake := &musicAuthorityStoreFake{installation: installation, policy: []store.DJRolePolicyRow{{InstallationID: installationID, RoleID: djRole}}}
	authority := &CommunityMusicInteractionAuthority{Session: session, Store: storeFake, InstallationID: installationID, CommunityID: community}
	binding := MusicCallBinding{CallID: callID, ChannelID: channel, Active: true}
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || !ok {
		t.Fatalf("valid DJ = %v, %v", ok, err)
	}

	session.call.Participants = nil
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || ok {
		t.Fatalf("actor outside target call = %v, %v, want denied", ok, err)
	}
	session.call.Participants = []client.CallParticipant{{UserID: actorID}}
	session.actor.RoleIDs = nil
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || ok {
		t.Fatalf("revoked DJ role = %v, %v, want denied", ok, err)
	}
	session.actor.RoleIDs = []id.ID{djRole}
	storeFake.installation.ID = id.New()
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || ok {
		t.Fatalf("replaced installation = %v, %v, want denied", ok, err)
	}
}

func TestMusicAuthorityManagersDoNotNeedAnApprovedDJRole(t *testing.T) {
	for _, tc := range []struct {
		name         string
		actor        client.ActorAuthority
		present      bool
		inCall       bool
		staleCall    bool
		botCanSpeak  bool
		musicEnabled bool
		want         bool
	}{
		{name: "owner", actor: client.ActorAuthority{Owner: true}, present: true, inCall: true, botCanSpeak: true, musicEnabled: true, want: true},
		{name: "administrator", actor: client.ActorAuthority{Administrator: true}, present: true, inCall: true, botCanSpeak: true, musicEnabled: true, want: true},
		{name: "ordinary member", present: true, inCall: true, botCanSpeak: true, musicEnabled: true},
		{name: "owner outside call", actor: client.ActorAuthority{Owner: true}, present: true, botCanSpeak: true, musicEnabled: true},
		{name: "administrator outside call", actor: client.ActorAuthority{Administrator: true}, present: true, botCanSpeak: true, musicEnabled: true},
		{name: "owner stale call", actor: client.ActorAuthority{Owner: true}, present: true, inCall: true, staleCall: true, botCanSpeak: true, musicEnabled: true},
		{name: "owner without bot speak permission", actor: client.ActorAuthority{Owner: true}, present: true, inCall: true, musicEnabled: true},
		{name: "administrator without music capability", actor: client.ActorAuthority{Administrator: true}, present: true, inCall: true, botCanSpeak: true},
		{name: "former owner no longer a member", actor: client.ActorAuthority{Owner: true}, inCall: true, botCanSpeak: true, musicEnabled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			community, installationID, channel, actorID, callID := id.New(), id.New(), id.New(), id.New(), id.New()
			session := &musicAuthoritySessionFake{
				actor: tc.actor, present: tc.present,
				call: client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New())},
			}
			if tc.inCall {
				session.call.Participants = []client.CallParticipant{{UserID: actorID}}
			}
			if tc.staleCall {
				session.call.CallID = ptrID(id.New())
			}
			if tc.botCanSpeak {
				session.permissions = musicPermissionConnect | musicPermissionSpeak
			}
			installation := store.BotInstallationRow{ID: installationID, State: store.BotInstallationReady}
			if tc.musicEnabled {
				installation.Capabilities = musicBotCapability
			}
			authority := &CommunityMusicInteractionAuthority{
				Session: session, Store: &musicAuthorityStoreFake{installation: installation},
				InstallationID: installationID, CommunityID: community,
			}
			binding := MusicCallBinding{CallID: callID, ChannelID: channel, Active: true}
			if got, err := authority.CanDJ(context.Background(), InteractionActor{User: actorID}, binding); err != nil || got != tc.want {
				t.Fatalf("CanDJ = %v, %v; want %v without an approved DJ role", got, err, tc.want)
			}
		})
	}
}

func TestMusicManagerEnqueueRechecksAuthorityAfterResolvingTrack(t *testing.T) {
	for _, tc := range []struct {
		name       string
		actor      client.ActorAuthority
		revoke     bool
		wantStatus uint64
	}{
		{name: "owner", actor: client.ActorAuthority{Owner: true}},
		{name: "administrator", actor: client.ActorAuthority{Administrator: true}},
		{name: "owner revoked during lookup", actor: client.ActorAuthority{Owner: true}, revoke: true, wantStatus: 2},
		{name: "administrator revoked during lookup", actor: client.ActorAuthority{Administrator: true}, revoke: true, wantStatus: 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			community, installationID, channel, actorID, callID := id.New(), id.New(), id.New(), id.New(), id.New()
			session := &musicAuthoritySessionFake{
				actor: tc.actor, present: true,
				permissions: musicPermissionConnect | musicPermissionSpeak,
				call:        client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New()), Participants: []client.CallParticipant{{UserID: actorID}}},
			}
			authority := &CommunityMusicInteractionAuthority{
				Session: session,
				Store: &musicAuthorityStoreFake{installation: store.BotInstallationRow{
					ID: installationID, State: store.BotInstallationReady, Capabilities: musicBotCapability,
				}},
				InstallationID: installationID, CommunityID: community,
			}
			queue := &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: music.InitialState()}}
			resolver := &musicInteractionResolverFake{tracks: []music.Track{{
				Provider: music.ProviderYouTube, CanonicalID: "LvH_ft4XR1Q", Title: "Requested track",
			}}}
			if tc.revoke {
				resolver.onResolve = func() { session.actor = client.ActorAuthority{} }
			}
			h := MusicInteractions{Store: queue, Authority: authority, Resolver: resolver, InstallationID: installationID, CommunityID: community}
			request := protocol.Request{CommunityID: community, ChannelID: &channel, Revision: uint64Ptr(0), Args: []any{"https://www.youtube.com/watch?v=LvH_ft4XR1Q"}}
			result, err := h.handle(context.Background(), InteractionActor{User: actorID}, request, protocol.OpMusicEnqueue)
			if err != nil || result.Status != tc.wantStatus {
				t.Fatalf("enqueue = %+v, %v; want status %d", result, err, tc.wantStatus)
			}
			if len(resolver.inputs) != 1 {
				t.Fatalf("resolved tracks %d times, want one authorized lookup", len(resolver.inputs))
			}
			if tc.revoke {
				if queue.saves != 0 {
					t.Fatalf("queue saved %d times after manager authority was revoked", queue.saves)
				}
			} else if queue.saves != 1 || len(queue.snapshot.State.Queue) != 1 || queue.snapshot.State.Queue[0].Title != "Requested track" {
				t.Fatalf("queue saves=%d state=%+v; want requested track committed", queue.saves, queue.snapshot.State)
			}
		})
	}
}

func TestMusicAuthorityRequiresBotChannelPermissionsAndPreservesEmergencyStop(t *testing.T) {
	community, installationID, channel, actorID, callID := id.New(), id.New(), id.New(), id.New(), id.New()
	authority := &CommunityMusicInteractionAuthority{
		Session: &musicAuthoritySessionFake{
			actor: client.ActorAuthority{Owner: true}, present: true,
			call: client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New())},
		},
		Store:          &musicAuthorityStoreFake{installation: store.BotInstallationRow{ID: installationID, State: store.BotInstallationReady, Capabilities: musicBotCapability}},
		InstallationID: installationID, CommunityID: community,
	}
	binding := MusicCallBinding{CallID: callID, ChannelID: channel, Active: true}
	if ok, err := authority.CanUse(context.Background(), InteractionActor{User: actorID}, binding); err != nil || ok {
		t.Fatalf("missing bot voice permission = %v, %v, want denied", ok, err)
	}
	fake := authority.Session.(*musicAuthoritySessionFake)
	fake.permissions = musicPermissionConnect | musicPermissionSpeak
	if ok, err := authority.CanUse(context.Background(), InteractionActor{User: actorID}, binding); err != nil || !ok {
		t.Fatalf("owner away from call with bot permission = %v, %v, want allowed to reach emergency-stop check", ok, err)
	}
	if ok, err := authority.CanEmergencyStop(context.Background(), InteractionActor{User: actorID}, binding); err != nil || !ok {
		t.Fatalf("owner emergency stop = %v, %v, want allowed", ok, err)
	}
	admin := fake
	admin.actor.Owner = false
	admin.actor.Administrator = true
	if ok, err := authority.CanEmergencyStop(context.Background(), InteractionActor{User: actorID}, binding); err != nil || !ok {
		t.Fatalf("administrator emergency stop = %v, %v, want allowed", ok, err)
	}
}

func TestMusicAuthorityRejectsMissingCapabilityAndPermissionLostAtFinalDJCheck(t *testing.T) {
	community, installationID, channel, actorID, callID, djRole := id.New(), id.New(), id.New(), id.New(), id.New(), id.New()
	session := &musicAuthoritySessionFake{
		actor: client.ActorAuthority{RoleIDs: []id.ID{djRole}}, present: true,
		call:        client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New()), Participants: []client.CallParticipant{{UserID: actorID}}},
		permissions: musicPermissionConnect | musicPermissionSpeak,
	}
	storeFake := &musicAuthorityStoreFake{
		installation: store.BotInstallationRow{ID: installationID, State: store.BotInstallationReady, Capabilities: musicBotCapability},
		policy:       []store.DJRolePolicyRow{{InstallationID: installationID, RoleID: djRole}},
	}
	authority := &CommunityMusicInteractionAuthority{Session: session, Store: storeFake, InstallationID: installationID, CommunityID: community}
	actor := InteractionActor{User: actorID}
	binding := MusicCallBinding{CallID: callID, ChannelID: channel, Active: true}
	if ok, err := authority.CanUse(context.Background(), actor, binding); err != nil || !ok {
		t.Fatalf("initial music authority = %v, %v", ok, err)
	}
	storeFake.installation.Capabilities = 0
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || ok {
		t.Fatalf("missing music capability = %v, %v, want denied", ok, err)
	}
	storeFake.installation.Capabilities = musicBotCapability
	session.permissionSequence = []uint64{musicPermissionConnect | musicPermissionSpeak, 0}
	if ok, err := authority.CanUse(context.Background(), actor, binding); err != nil || !ok {
		t.Fatalf("initial permission check = %v, %v", ok, err)
	}
	if ok, err := authority.CanDJ(context.Background(), actor, binding); err != nil || ok {
		t.Fatalf("permission lost before final DJ check = %v, %v, want denied", ok, err)
	}
}

func ptrID(value id.ID) *id.ID { return &value }
