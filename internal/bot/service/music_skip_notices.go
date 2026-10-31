package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	botstrings "github.com/jonasthim/dilla/internal/bot/strings"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type musicNoticeDestination struct {
	text  id.ID
	actor InteractionActor
}

// MusicSkipNotices retains only destinations authorized by the existing announce request.
// No destination is guessed for automatic playback or restored queues.
type MusicSkipNotices struct {
	mu           sync.Mutex
	destinations map[id.ID]musicNoticeDestination
	send         func(context.Context, id.ID, musicNoticeDestination, music.Track, error) error
	logger       *slog.Logger
}

func (n *MusicSkipNotices) Configure(h MusicAnnouncements, logger *slog.Logger) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.logger = logger
	n.send = func(ctx context.Context, voice id.ID, destination musicNoticeDestination, track music.Track, failure error) error {
		if h.Music == nil || h.Music.Authority == nil || h.Channels == nil || h.Destination == nil || h.Sender == nil || h.Discovery == nil || h.Session == nil {
			return errors.New("music notice unavailable")
		}
		call, err := h.Music.Authority.CurrentCall(ctx, voice)
		if err != nil {
			return err
		}
		allowed, err := h.Music.Authority.CanDJ(ctx, destination.actor, call)
		if err != nil {
			return err
		}
		if !allowed {
			return errors.New("music notice authority unavailable")
		}
		bits, visible, err := h.Channels.BotActorChannelAuthority(ctx, h.CommunityID, destination.actor.User, destination.text)
		if err != nil {
			return err
		}
		if !visible || bits&musicAnnounceChannelSend != musicAnnounceChannelSend {
			return errors.New("music notice destination unavailable")
		}
		group, err := h.Destination.ResolveTextGroup(ctx, h.CommunityID, destination.text)
		if err != nil {
			return err
		}
		discovery, _, err := h.Discovery.DiscoverObserved(ctx)
		if err != nil {
			return err
		}
		if discovery.Generation == 0 {
			return client.ErrProtocol
		}
		reason := "provider unavailable"
		if music.FailureClass(failure) == "pcm_start" {
			reason = "audio unavailable"
		}
		body, err := cborx.Marshal([]any{uint64(0), nil, NeutralizeBotMarkers(botstrings.MusicSkipped(track.Title, reason)), []any{}, nil})
		if err != nil {
			return err
		}
		created := time.Now().UTC().Unix()
		if created < 0 {
			return errors.New("music notice clock unavailable")
		}
		operation, attempt := id.New(), id.New()
		receipt, err := h.Sender.Send(ctx, h.Session, SendInput{OperationID: operation, AttemptID: attempt, GroupID: group, RequestBody: body, OriginalNow: uint64(created), ExpectedGeneration: discovery.Generation})
		if err != nil {
			return err
		}
		if receipt.OperationID != operation || receipt.AttemptID != attempt || receipt.GroupID != group || receipt.CommunityID != h.CommunityID || receipt.Outcome != protocol.ReceiptAccepted {
			return errors.New("music skip notice not accepted")
		}
		return nil
	}
}

func (n *MusicSkipNotices) Register(voice, text id.ID, actor InteractionActor) {
	if n == nil {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.destinations == nil {
		n.destinations = make(map[id.ID]musicNoticeDestination)
	}
	n.destinations[voice] = musicNoticeDestination{text: text, actor: actor}
}

func (n *MusicSkipNotices) Notify(ctx context.Context, voice id.ID, track music.Track, failure error) {
	n.mu.Lock()
	destination, known := n.destinations[voice]
	send, logger := n.send, n.logger
	n.mu.Unlock()
	if logger == nil {
		logger = slog.Default()
	}
	logger.InfoContext(ctx, "bot music track skipped", "channel_id", voice.String(), "class", music.FailureClass(failure), "notice_destination_known", known)
	if !known || send == nil {
		return
	}
	sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := send(sendCtx, voice, destination, track, failure); err != nil {
		logger.WarnContext(ctx, "bot music skip notice failed", "channel_id", voice.String(), "class", music.FailureClass(err))
	}
}
