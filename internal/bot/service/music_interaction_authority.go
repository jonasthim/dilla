package service

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

const (
	musicBotCapability     uint8  = 1 << 0 // bot_installations capability bit 0
	musicPermissionConnect uint64 = 1 << 7
	musicPermissionSpeak   uint64 = 1 << 8
)

type musicAuthoritySession interface {
	BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error)
	ChannelCall(context.Context, id.ID) (client.ChannelCallState, error)
	ChannelPermissions(context.Context, id.ID) (uint64, error)
}

type musicAuthorityStore interface {
	GetActiveBotInstallationByCommunity(context.Context, id.ID) (store.BotInstallationRow, error)
	ListDJRolePolicy(context.Context, id.ID) ([]store.DJRolePolicyRow, error)
}

// CommunityMusicInteractionAuthority resolves permissions, role grants, installation state,
// and the live call roster afresh for each authorization check.
type CommunityMusicInteractionAuthority struct {
	Session        musicAuthoritySession
	Store          musicAuthorityStore
	InstallationID id.ID
	CommunityID    id.ID
}

func (a *CommunityMusicInteractionAuthority) CurrentCall(ctx context.Context, channel id.ID) (MusicCallBinding, error) {
	if err := a.valid(); err != nil || channel.IsZero() {
		return MusicCallBinding{}, errors.New("invalid music authority binding")
	}
	installation, err := a.currentInstallation(ctx)
	if err != nil {
		return MusicCallBinding{}, err
	}
	if installation.ID.IsZero() {
		return MusicCallBinding{}, nil
	}
	state, err := a.Session.ChannelCall(ctx, channel)
	if err != nil {
		return MusicCallBinding{}, err
	}
	if state.CallID == nil || state.GroupID == nil {
		return MusicCallBinding{ChannelID: channel}, nil
	}
	return MusicCallBinding{CallID: *state.CallID, ChannelID: channel, Active: true}, nil
}

func (a *CommunityMusicInteractionAuthority) CanUse(ctx context.Context, actor InteractionActor, call MusicCallBinding) (bool, error) {
	if err := a.validCall(call); err != nil || actor.User.IsZero() {
		return false, nil
	}
	installation, err := a.currentInstallation(ctx)
	if err != nil || installation.ID.IsZero() {
		return false, err
	}
	bits, err := a.Session.ChannelPermissions(ctx, call.ChannelID)
	if err != nil || bits&(musicPermissionConnect|musicPermissionSpeak) != musicPermissionConnect|musicPermissionSpeak {
		return false, err
	}
	_, present, err := a.Session.BotActorAuthority(ctx, a.CommunityID, actor.User)
	if err != nil || !present {
		return false, err
	}
	// Managers can issue an emergency stop while away from the call. All other
	// state changes are separately gated by CanDJ and call membership.
	return true, nil
}

func (a *CommunityMusicInteractionAuthority) CanDJ(ctx context.Context, actor InteractionActor, call MusicCallBinding) (bool, error) {
	if err := a.validCall(call); err != nil || actor.User.IsZero() {
		return false, nil
	}
	installation, err := a.currentInstallation(ctx)
	if err != nil || installation.ID.IsZero() {
		return false, err
	}
	resolved, present, err := a.Session.BotActorAuthority(ctx, a.CommunityID, actor.User)
	if err != nil || !present {
		return false, err
	}
	roles, err := a.Store.ListDJRolePolicy(ctx, installation.ID)
	if err != nil {
		return false, err
	}
	roleSet := make(map[id.ID]struct{}, len(resolved.RoleIDs))
	for _, role := range resolved.RoleIDs {
		roleSet[role] = struct{}{}
	}
	member, err := a.actorInCall(ctx, actor.User, call)
	if err != nil || !member {
		return false, err
	}
	for _, approved := range roles {
		if _, held := roleSet[approved.RoleID]; held {
			return a.botCanSpeak(ctx, call.ChannelID)
		}
	}
	return false, nil
}

func (a *CommunityMusicInteractionAuthority) CanEmergencyStop(ctx context.Context, actor InteractionActor, call MusicCallBinding) (bool, error) {
	if err := a.validCall(call); err != nil || actor.User.IsZero() {
		return false, nil
	}
	installation, err := a.currentInstallation(ctx)
	if err != nil || installation.ID.IsZero() {
		return false, err
	}
	resolved, present, err := a.Session.BotActorAuthority(ctx, a.CommunityID, actor.User)
	return present && (resolved.Owner || resolved.Administrator), err
}

func (a *CommunityMusicInteractionAuthority) actorInCall(ctx context.Context, user id.ID, binding MusicCallBinding) (bool, error) {
	state, err := a.Session.ChannelCall(ctx, binding.ChannelID)
	if err != nil {
		return false, err
	}
	if state.CallID == nil || *state.CallID != binding.CallID {
		return false, nil
	}
	for _, participant := range state.Participants {
		if participant.UserID == user {
			return true, nil
		}
	}
	return false, nil
}

func (a *CommunityMusicInteractionAuthority) currentInstallation(ctx context.Context) (store.BotInstallationRow, error) {
	installation, err := a.Store.GetActiveBotInstallationByCommunity(ctx, a.CommunityID)
	if errors.Is(err, store.ErrNotFound) {
		return store.BotInstallationRow{}, nil
	}
	if err != nil {
		return store.BotInstallationRow{}, err
	}
	if installation.ID != a.InstallationID || installation.State != store.BotInstallationReady || installation.RemovedAt != nil || installation.Capabilities&musicBotCapability == 0 {
		return store.BotInstallationRow{}, nil
	}
	return installation, nil
}

func (a *CommunityMusicInteractionAuthority) botCanSpeak(ctx context.Context, channel id.ID) (bool, error) {
	bits, err := a.Session.ChannelPermissions(ctx, channel)
	if err != nil {
		return false, err
	}
	return bits&(musicPermissionConnect|musicPermissionSpeak) == musicPermissionConnect|musicPermissionSpeak, nil
}

func (a *CommunityMusicInteractionAuthority) valid() error {
	if a == nil || a.Session == nil || a.Store == nil || a.CommunityID.IsZero() || a.InstallationID.IsZero() {
		return errors.New("missing music interaction authority dependency")
	}
	return nil
}

func (a *CommunityMusicInteractionAuthority) validCall(call MusicCallBinding) error {
	if err := a.valid(); err != nil || !validMusicCall(call, call.ChannelID) {
		return errors.New("invalid music call binding")
	}
	return nil
}

var _ MusicInteractionAuthority = (*CommunityMusicInteractionAuthority)(nil)
