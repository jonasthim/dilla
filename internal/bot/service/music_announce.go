package service

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// View channel, send messages and read history (api.PermViewChannel|PermSendMessages|PermReadHistory), as a poll needs.
const musicAnnounceChannelSend = uint64(1<<0 | 1<<1 | 1<<6)

// musicAnnounceChannelAuthority resolves the actor's effective bits in one channel, overrides included.
type musicAnnounceChannelAuthority interface {
	BotActorChannelAuthority(context.Context, id.ID, id.ID, id.ID) (uint64, bool, error)
}

// MusicAnnouncements publishes the public "started music" message (Signal README §6.6, Jonas 2026-10-28): when a
// requester's /play started playback, Glenn posts in the text channel where /play ran, through the installed Bot's MLS
// group and durable send receipt like a role panel. The body ends in the player marker `[dilla-music:v1:<voice>:<user>]`,
// from which clients draw the live now-playing card. Everything else about music stays private.
//
// The destination: /play runs in the requester's client and reaches the Bot through the requester's private interaction
// group, so the Bot never sees the text channel itself; the request names it. That name is never trusted on its own: the
// Bot posts only where the requester's effective permissions for that very channel (role overrides included, resolved by
// the server) allow viewing, sending and reading history, Owner and Administrator excepted as elsewhere, and only in a
// text channel of this community (ResolveTextGroup). A channel the requester cannot post in gets a refusal, no message.
//
// Only the member who requested the current track may announce it, only while they may DJ in that voice call. One message per (voice channel, current track): the operation id is derived from both, so a
// retry or a second request returns the first message's receipt instead of posting again.
type MusicAnnouncements struct {
	Music       *MusicInteractions
	Authority   rolePanelAuthority
	Channels    musicAnnounceChannelAuthority
	Destination rolePanelDestination
	Sender      rolePanelSender
	Discovery   rolePanelDiscovery
	Session     *client.Session
	CommunityID id.ID
	Now         func() time.Time
}

func (h MusicAnnouncements) Handlers() map[protocol.Operation]InteractionHandlerSpec {
	return map[protocol.Operation]InteractionHandlerSpec{
		protocol.OpMusicAnnounce: {AllowMusicChannelContext: true, RevisionInHandler: true, Handle: h.announce},
	}
}

// MusicAnnouncementText is the message body: a plain fallback line, then the marker clients render the card from.
func MusicAnnouncementText(voice, requester id.ID) string {
	return fmt.Sprintf("Music started.\n[dilla-music:v1:%s:%s]", voice.String(), requester.String())
}

//nolint:nilerr // Invalid client input intentionally maps to an unavailable protocol result.
func (h MusicAnnouncements) announce(ctx context.Context, actor InteractionActor, request protocol.Request) (InteractionResult, error) {
	if h.Music == nil || h.Music.Store == nil || h.Music.Authority == nil || h.Authority == nil || h.Channels == nil || h.Destination == nil || h.Sender == nil || h.Discovery == nil ||
		h.Session == nil || h.CommunityID.IsZero() || actor.User.IsZero() || actor.Kind != 0 || request.Operation != protocol.OpMusicAnnounce ||
		request.CommunityID != h.CommunityID || request.RequestID.IsZero() || request.ChannelID == nil || request.ChannelID.IsZero() ||
		request.Revision == nil || *request.Revision != 0 || request.Expires == nil || len(request.Args) != 1 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	voice := *request.ChannelID
	text, ok := request.Args[0].(id.ID)
	if !ok || text.IsZero() || text == voice {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	call, err := h.Music.Authority.CurrentCall(ctx, voice)
	if err != nil {
		return InteractionResult{}, err
	}
	if !validMusicCall(call, voice) {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	dj, err := h.Music.Authority.CanDJ(ctx, actor, call)
	if err != nil {
		return InteractionResult{}, err
	}
	if !dj {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	authority, present, err := h.Authority.BotActorAuthority(ctx, h.CommunityID, actor.User)
	if err != nil {
		return InteractionResult{}, err
	}
	if !present {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	if !authority.Owner && !authority.Administrator {
		bits, visible, err := h.Channels.BotActorChannelAuthority(ctx, h.CommunityID, actor.User, text)
		if err != nil {
			return InteractionResult{}, err
		}
		if !visible || bits&musicAnnounceChannelSend != musicAnnounceChannelSend {
			return InteractionResult{Status: interactionStatusForbidden}, nil
		}
	}
	snapshot, err := h.Music.Store.Load(ctx, voice)
	if err != nil {
		return InteractionResult{}, err
	}
	state := snapshot.State
	if h.Music.CurrentState != nil {
		live, revision, err := h.Music.CurrentState(ctx, h.Music.InstallationID, h.CommunityID, voice)
		if err != nil {
			return InteractionResult{}, err
		}
		if revision == snapshot.Revision && live.Revision == snapshot.Revision {
			state = live
		}
	}
	if state.Current == nil || state.Paused {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	if state.Current.RequesterID != actor.User.String() {
		return InteractionResult{Status: interactionStatusForbidden}, nil
	}
	group, err := h.Destination.ResolveTextGroup(ctx, h.CommunityID, text)
	if err != nil || group.IsZero() {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	discovery, _, err := h.Discovery.DiscoverObserved(ctx)
	if err != nil {
		return InteractionResult{}, err
	}
	if discovery.Generation == 0 || discovery.InstanceID.IsZero() {
		return InteractionResult{}, client.ErrProtocol
	}
	now := time.Now
	if h.Now != nil {
		now = h.Now
	}
	created := now().UTC().Unix()
	if created < 0 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	body, err := cborx.Marshal([]any{uint64(0), nil, MusicAnnouncementText(voice, actor.User), []any{}, nil})
	if err != nil {
		return InteractionResult{}, err
	}
	operation, attempt := musicAnnounceIDs(h.CommunityID, voice, state.Current.ID)
	receipt, err := h.Sender.Send(ctx, h.Session, SendInput{OperationID: operation, AttemptID: attempt, GroupID: group,
		RequestBody: body, OriginalNow: uint64(created), ExpectedGeneration: discovery.Generation})
	if err != nil {
		return InteractionResult{}, err
	}
	if receipt.OperationID != operation || receipt.AttemptID != attempt || receipt.CommunityID != h.CommunityID || receipt.GroupID != group {
		return InteractionResult{}, client.ErrProtocol
	}
	if receipt.Outcome != protocol.ReceiptAccepted || receipt.SendResponse == nil || receipt.SendResponse.Sequence == 0 {
		return InteractionResult{Status: interactionStatusUnavailable}, nil
	}
	data, err := cborx.Marshal([]any{text, receipt.SendResponse.Sequence})
	if err != nil {
		return InteractionResult{}, err
	}
	return InteractionResult{Data: data}, nil
}

// musicAnnounceIDs derives one send operation per (community, voice channel, current queue item).
func musicAnnounceIDs(community, voice id.ID, item string) (operation, attempt id.ID) {
	seed := append(append(append([]byte("dilla music announce v1\x00"), community[:]...), voice[:]...), item...)
	digest := sha256.Sum256(seed)
	copy(operation[:], digest[:len(operation)])
	next := sha256.Sum256(append([]byte("dilla music announce attempt v1\x00"), operation[:]...))
	copy(attempt[:], next[:len(attempt)])
	return operation, attempt
}
