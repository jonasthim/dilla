package service

import (
	"context"
	"errors"
	"sort"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const commandCapabilitiesDataLimit = 2400

const (
	commandCapMusic         uint8 = 1 << 0
	commandCapWelcome       uint8 = 1 << 1
	commandCapRoles         uint8 = 1 << 2
	commandCapAnnouncements uint8 = 1 << 3
	commandCapWarnings      uint8 = 1 << 4
	commandCapRemoval       uint8 = 1 << 5
	commandCapKick          uint8 = 1 << 6
	commandCapBan           uint8 = 1 << 7
)

const (
	commandPermManageMessages  uint64 = 1 << 2
	commandPermManageRoles     uint64 = 1 << 15
	commandPermManageCommunity uint64 = 1 << 16
	commandPermViewAuditLog    uint64 = 1 << 17
)

// CommandCapabilitiesInteractions reports only operations present in the
// runtime's handler registry and currently available to this member. Utility
// operations have no new installation capability bit; their handlers still
// recheck current permissions when each request runs.
type CommandCapabilitiesInteractions struct {
	Authority      overviewActorAuthority
	CommunityID    id.ID
	InstallationID id.ID
	BotUserID      id.ID
	Capabilities   uint8
	Supported      []protocol.Operation
}

func (h CommandCapabilitiesInteractions) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpCapabilities: {RecomputeOnReplay: true, Handle: h.get},
	}
}

func (h CommandCapabilitiesInteractions) get(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Authority == nil || h.CommunityID.IsZero() || h.InstallationID.IsZero() || h.BotUserID.IsZero() ||
		request.CommunityID != h.CommunityID || actor.User.IsZero() || actor.Kind != 0 || request.Operation != protocol.OpCapabilities || len(request.Args) != 0 {
		return InteractionResult{}, errors.New("missing command capability context")
	}
	current, present, err := h.Authority.BotActorAuthority(ctx, h.CommunityID, actor.User)
	if err != nil {
		return InteractionResult{}, err
	}
	if !present {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	available := make(map[protocol.Operation]bool, len(h.Supported))
	for _, operation := range h.Supported {
		if commandOperationAllowed(operation, h.Capabilities, current) {
			available[operation] = true
		}
	}
	operations := make([]uint64, 0, len(available))
	for operation := range available {
		operations = append(operations, uint64(operation))
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i] < operations[j] })
	data, err := cborx.Marshal([]any{uint64(1), h.InstallationID, h.BotUserID, uint64(1), operations})
	if err != nil {
		return InteractionResult{}, err
	}
	if len(data) > commandCapabilitiesDataLimit {
		return InteractionResult{}, errors.New("command capabilities result exceeds size limit")
	}
	return InteractionResult{Status: 0, Data: data}, nil
}

func commandOperationAllowed(operation protocol.Operation, capabilities uint8, actor client.ActorAuthority) bool {
	const manager = commandPermManageCommunity
	if actor.Owner || actor.Administrator {
		actor.EffectiveBits |= manager | commandPermManageRoles | commandPermViewAuditLog | commandPermManageMessages
	}
	switch operation {
	case protocol.OpCapabilities:
		return true
	case protocol.OpOverviewGet:
		// Preserve op0's pre-existing owner/admin/manage-community restriction.
		return actor.Owner || actor.Administrator || actor.EffectiveBits&manager != 0
	case protocol.OpSettingsGet, protocol.OpSettingsPut, protocol.OpWelcomePreview:
		return capabilities&commandCapWelcome != 0 && (actor.Owner || actor.Administrator || actor.EffectiveBits&manager != 0)
	case protocol.OpMusicState, protocol.OpMusicSearch, protocol.OpMusicEnqueue,
		protocol.OpMusicPause, protocol.OpMusicResume, protocol.OpMusicSkip, protocol.OpMusicStop,
		protocol.OpMusicSeek, protocol.OpMusicVolume, protocol.OpMusicShuffle, protocol.OpMusicRepeat,
		protocol.OpMusicRemove, protocol.OpMusicMove, protocol.OpMusicClear, protocol.OpMusicAnnounce:
		return capabilities&commandCapMusic != 0
	case protocol.OpMusicProvidersStatus:
		return capabilities&commandCapMusic != 0 && (actor.Owner || actor.Administrator || actor.EffectiveBits&manager != 0)
	case protocol.OpRolePanelPublish:
		return capabilities&commandCapRoles != 0 && actor.EffectiveBits&commandPermManageRoles != 0
	case protocol.OpRolesList:
		return capabilities&commandCapRoles != 0
	case protocol.OpAnnouncementsList, protocol.OpAnnouncementsPut, protocol.OpAnnouncementsDelete:
		return capabilities&commandCapAnnouncements != 0 && (actor.Owner || actor.Administrator || actor.EffectiveBits&manager != 0)
	case protocol.OpModerationCases, protocol.OpModerationEvidence, protocol.OpModerationEvidenceList:
		return capabilities&(commandCapWarnings|commandCapRemoval|commandCapKick|commandCapBan) != 0 &&
			(actor.EffectiveBits&(commandPermViewAuditLog|commandPermManageMessages) != 0)
	case protocol.OpAutoModerationGet, protocol.OpAutoModerationPut:
		return capabilities&commandCapWarnings != 0 && (actor.Owner || actor.Administrator || actor.EffectiveBits&manager != 0)
	case protocol.OpPollClose:
		// Creator status and channel-scoped manage_messages need poll and target
		// context; the registered close handler checks both against current state.
		return true
	case protocol.OpPollCreate, protocol.OpPollGet, protocol.OpPollList, protocol.OpPollVote, protocol.OpPollVoters,
		protocol.OpReminderCreate, protocol.OpReminderList, protocol.OpReminderCancel, protocol.OpReminderDismiss, protocol.OpReminderDue:
		return true
	default:
		return false
	}
}
