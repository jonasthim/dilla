package service

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

type musicAuthoritySessionFake struct {
	actor       client.ActorAuthority
	present     bool
	call        client.ChannelCallState
	permissions uint64
}

func (s *musicAuthoritySessionFake) BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error) {
	return s.actor, s.present, nil
}
func (s *musicAuthoritySessionFake) ChannelCall(context.Context, id.ID) (client.ChannelCallState, error) {
	return s.call, nil
}
func (s *musicAuthoritySessionFake) ChannelPermissions(context.Context, id.ID) (uint64, error) {
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
	installation := store.BotInstallationRow{ID: installationID, CommunityID: community, State: store.BotInstallationReady}
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

func TestMusicAuthorityRequiresBotChannelPermissionsAndPreservesEmergencyStop(t *testing.T) {
	community, installationID, channel, actorID, callID := id.New(), id.New(), id.New(), id.New(), id.New()
	authority := &CommunityMusicInteractionAuthority{
		Session: &musicAuthoritySessionFake{
			actor: client.ActorAuthority{Owner: true}, present: true,
			call: client.ChannelCallState{CallID: &callID, GroupID: ptrID(id.New())},
		},
		Store:          &musicAuthorityStoreFake{installation: store.BotInstallationRow{ID: installationID, State: store.BotInstallationReady}},
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

func ptrID(value id.ID) *id.ID { return &value }
