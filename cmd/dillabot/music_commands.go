//go:build linux

package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/youtube"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type musicCommandState interface {
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}
type musicCommandCalls interface {
	Channels(context.Context, id.ID) ([]client.Channel, error)
	ChannelCall(context.Context, id.ID) (client.ChannelCallState, error)
}
type musicCommandRecord struct {
	_                    struct{} `cbor:",toarray"`
	Version              uint64
	Phase                uint64
	Fingerprint          [32]byte
	Text                 string
	OriginalNow          uint64
	OperationID          id.ID
	AttemptID            id.ID
	ExpectedGeneration   uint64
	PredecessorAttemptID *id.ID
}

// Commands consume only authenticated native text events. The durable record is
// committed before any effect, so an interrupted command is never executed twice.
// A pending record after interruption produces an explicit uncertain-outcome reply.
type musicChatCommands struct {
	community  id.ID
	state      musicCommandState
	calls      musicCommandCalls
	handlers   map[protocol.Operation]service.InteractionHandlerSpec
	send       func(context.Context, native.GroupEvent, musicCommandRecord, string) (protocol.SendOutcome, error)
	generation func(context.Context) (uint64, error)
}

const musicCommandHelp = "Music commands: /play <YouTube search or YouTube/Spotify URL>, /pause, /resume, /skip, /queue, /stop. Join a voice channel first. Playback controls require a configured DJ role."

func (h *musicChatCommands) HandleGroupEvent(ctx context.Context, e native.GroupEvent) error {
	if e.Body == nil || e.EnvelopeType != 0 || e.SenderKind != 0 || e.SenderUser.IsZero() || e.SenderDevice.IsZero() || e.Message.IsZero() || e.Community != h.community || e.Thread != nil {
		return nil
	}
	text := strings.TrimSpace(*e.Body)
	words := strings.Fields(text)
	if len(words) == 0 {
		return nil
	}
	command := words[0]
	switch command {
	case "/play", "/pause", "/resume", "/skip", "/queue", "/stop", "/music":
	default:
		return nil
	}
	if h.state == nil || h.calls == nil || h.send == nil || h.generation == nil {
		return errors.New("music command runtime unavailable")
	}
	key := []byte("dilla.bot.music-command.v1/" + e.Group.String() + "/" + e.Message.String())
	stored, err := h.state.StateGet(ctx, 8, key)
	if err != nil {
		return err
	}
	fingerprintBytes, err := cborx.Marshal([]any{e.Group, e.Message, e.SenderUser, e.SenderDevice, *e.Body})
	if err != nil {
		return err
	}
	fingerprint := sha256.Sum256(fingerprintBytes)
	record := musicCommandRecord{Version: 1, Phase: 1, Fingerprint: fingerprint, OriginalNow: e.ReceivedAt, OperationID: id.New(), AttemptID: id.New()}
	revision := stored.Revision
	persist := func() error {
		data, err := cborx.Marshal(record)
		if err != nil {
			return err
		}
		rows, err := h.state.StateTransaction(ctx, id.New(), []native.StateChange{{Area: 8, Key: key, ExpectedRevision: revision, Value: data}})
		if err != nil {
			return err
		}
		if len(rows) != 1 || rows[0] != revision+1 {
			return errors.New("music command receipt revision mismatch")
		}
		revision = rows[0]
		return nil
	}
	if revision > 0 {
		if stored.Tombstone || cborx.Unmarshal(stored.Value, &record) != nil || record.Version != 1 || record.Phase < 1 || record.Phase > 4 || record.Fingerprint != fingerprint || record.OperationID.IsZero() || record.AttemptID.IsZero() {
			return errors.New("invalid music command receipt")
		}
		if record.Phase >= 3 {
			return nil
		}
		if record.Phase == 1 {
			record.Text = "The previous music command was interrupted and its outcome is uncertain. Use /queue to check before trying again."
			record.Phase = 2
			if err := persist(); err != nil {
				return err
			}
		}
	} else {
		now := unixSecondsOrZero(time.Now())
		// Historic catch-up must never replay old playback commands after a restart.
		if e.ReceivedAt == 0 || e.ReceivedAt > now || now-e.ReceivedAt > 120 {
			return nil
		}
		if err := persist(); err != nil {
			return err
		}
		record.Text = boundMusicReply(h.execute(ctx, e, command, strings.TrimSpace(strings.TrimPrefix(text, command))))
		record.Phase = 2
		if err := persist(); err != nil {
			return err
		}
	}

	if record.ExpectedGeneration == 0 {
		generation, err := h.generation(ctx)
		if err != nil {
			return err
		}
		if generation == 0 {
			return errors.New("music reply generation unavailable")
		}
		record.ExpectedGeneration = generation
		if err := persist(); err != nil {
			return err
		}
	}
	outcome, err := h.send(ctx, e, record, record.Text)
	if err != nil {
		return err
	}
	switch outcome {
	case protocol.ReceiptAccepted:
		record.Phase = 3
	case protocol.ReceiptClosedNotAccepted:
		predecessor := record.AttemptID
		record.PredecessorAttemptID = &predecessor
		record.AttemptID = id.New()
		record.ExpectedGeneration = 0
		if err := persist(); err != nil {
			return err
		}
		return errors.New("music reply attempt closed; waiting for source reconciliation")
	case protocol.ReceiptUnknownAfterRestore:
		// The informational reply may already have arrived. Keep the uncertainty
		// durable without replaying either the command or an unprovable send.
		record.Phase = 4
		slog.Warn("music command reply delivery unknown after restore", "installation_group", e.Group.String(), "message_id", e.Message.String())
	default:
		return errors.New("invalid music reply send outcome")
	}
	return persist()

}
func (h *musicChatCommands) execute(ctx context.Context, e native.GroupEvent, command, arg string) string {
	if command == "/music" {
		return musicCommandHelp
	}
	if command == "/play" && arg == "" || command != "/play" && arg != "" {
		return musicCommandHelp
	}
	channels, err := h.calls.Channels(ctx, h.community)
	if err != nil {
		return "Could not check your voice channel. Try again."
	}
	var voice id.ID
	for _, ch := range channels {
		if ch.CommunityID != h.community || ch.Kind != 1 {
			continue
		}
		call, err := h.calls.ChannelCall(ctx, ch.ID)
		if err != nil {
			return "Could not check your voice channel. Try again."
		}
		if call.CallID == nil || call.GroupID == nil {
			continue
		}
		for _, p := range call.Participants {
			if p.UserID == e.SenderUser {
				if !voice.IsZero() && voice != ch.ID {
					return "You are in more than one voice channel. Leave the other call and try again."
				}
				voice = ch.ID
				break
			}
		}
	}
	if voice.IsZero() {
		return "Join a voice channel before using music commands."
	}
	actor := service.InteractionActor{User: e.SenderUser, Device: e.SenderDevice, Kind: e.SenderKind, Tier: e.SenderTier, Group: e.Group, Channel: e.Channel}
	request := protocol.Request{RequestID: e.Message, CommunityID: h.community, ChannelID: &voice, Args: []any{}}
	invoke := func(op protocol.Operation, args []any) (service.InteractionResult, error) {
		handler, ok := h.handlers[op]
		if !ok {
			return service.InteractionResult{Status: 5}, nil
		}
		request.Operation = op
		request.Args = args
		return handler.Handle(ctx, actor, request)
	}
	snapshot, err := invoke(protocol.OpMusicState, []any{})
	if err != nil || snapshot.Status != 0 {
		return musicCommandFailure(snapshot.Status)
	}
	if command == "/queue" {
		return musicQueueReply(snapshot.Data)
	}
	// Every mutation still passes through the existing current-call and DJ checks.
	request.Revision = snapshot.Revision
	expires := unixSecondsOrZero(time.Now().Add(30 * time.Second))
	request.Expires = &expires
	var op protocol.Operation
	switch command {
	case "/play":
		op = protocol.OpMusicEnqueue
	case "/pause":
		op = protocol.OpMusicPause
	case "/resume":
		op = protocol.OpMusicResume
	case "/skip":
		op = protocol.OpMusicSkip
	case "/stop":
		op = protocol.OpMusicStop
	}
	args := []any{}
	if command == "/play" {
		args = []any{arg}
	}
	result, err := invoke(op, args)
	if err != nil || result.Status != 0 {
		return musicCommandFailure(result.Status)
	}
	if command == "/play" {
		// Adding to an already playing queue must not restart the current track.
		var state []any
		paused := true
		if cborx.Unmarshal(snapshot.Data, &state) == nil && len(state) == 10 {
			paused = state[5] == uint64(1)
		}
		if paused {
			request.Revision = result.Revision
			expires = unixSecondsOrZero(time.Now().Add(30 * time.Second))
			result, err = invoke(protocol.OpMusicResume, []any{})
			if err != nil || result.Status != 0 {
				return "Added to the queue, but playback could not start. " + musicCommandFailure(result.Status)
			}
		}
		if paused {
			return "Playing music in your voice channel. Use /queue to see the current track and upcoming songs."
		}
		return "Added to the music queue. Use /queue to see upcoming songs."
	}
	switch command {
	case "/pause":
		return "Music paused."
	case "/resume":
		return "Music resumed."
	case "/skip":
		return "Skipped the current track."
	case "/stop":
		return "Music stopped."
	}
	return musicCommandHelp
}
func musicCommandFailure(status uint64) string {
	switch status {
	case 2:
		return "You need a configured DJ role and must be in the voice channel to control music."
	case 3:
		return "The music command expired. Try again."
	case 4:
		return "The queue or voice call changed. Try the command again."
	case 6:
		return "The music provider is busy. Try again shortly."
	default:
		return "Music could not complete this command. Check that the bot can connect and speak in your voice channel and that the provider is configured."
	}
}
func musicQueueReply(data []byte) string {
	var state []any
	if cborx.Unmarshal(data, &state) != nil || len(state) != 10 {
		return "Could not read the music queue. Try again."
	}
	title := func(v any) string {
		row, ok := v.([]any)
		if !ok || len(row) != 8 {
			return ""
		}
		s, _ := row[3].(string)
		s = strings.ReplaceAll(strings.ReplaceAll(s, "\n", " "), "\r", " ")
		s = strings.ReplaceAll(s, "<@", "‹@")
		r := []rune(s)
		if len(r) > 160 {
			s = string(r[:160])
		}
		return s
	}
	var lines []string
	if current := title(state[2]); current != "" {
		label := "Now playing: "
		if state[5] == uint64(1) {
			label = "Paused: "
		}
		lines = append(lines, label+current)
	}
	queue, _ := state[3].([]any)
	for i, item := range queue {
		if i == 10 {
			lines = append(lines, fmt.Sprintf("… and %d more.", len(queue)-10))
			break
		}
		lines = append(lines, fmt.Sprintf("%d. %s", i+1, title(item)))
	}
	if len(lines) == 0 {
		return "The music queue is empty. Use /play <song or URL> to add music."
	}
	return strings.Join(lines, "\n")
}

// A search command queues its first result; explicit playlist URLs retain all entries.
type chatMusicResolver struct{ resolver service.MusicTrackResolver }

func (r chatMusicResolver) Resolve(ctx context.Context, input string) ([]music.Track, error) {
	tracks, err := r.resolver.Resolve(ctx, input)
	kind, _, parseErr := youtube.NormalizeInput(input)
	if err == nil && parseErr == nil && kind == "search" && len(tracks) > 1 {
		tracks = tracks[:1]
	}
	return tracks, err
}

func newMusicChatCommands(community id.ID, n *native.Client, session *client.Session, api *client.Client, coordinator *service.SendCoordinator, m *service.MusicInteractions) service.GroupEventHandler {
	if m == nil {
		return nil
	}
	handlers := *m
	if handlers.Resolver != nil {
		handlers.Resolver = chatMusicResolver{handlers.Resolver}
	}
	return &musicChatCommands{community: community, state: n, calls: session, handlers: handlers.Handlers(), generation: func(ctx context.Context) (uint64, error) {
		discovery, _, err := api.DiscoverObserved(ctx)
		return discovery.Generation, err
	}, send: func(ctx context.Context, e native.GroupEvent, r musicCommandRecord, text string) (protocol.SendOutcome, error) {
		body, err := cborx.Marshal([]any{uint64(0), e.Message, text, []any{}, nil})
		if err != nil {
			return protocol.ReceiptUnknownAfterRestore, err
		}
		receipt, err := coordinator.Send(ctx, session, service.SendInput{OperationID: r.OperationID, AttemptID: r.AttemptID, PredecessorAttemptID: r.PredecessorAttemptID, GroupID: e.Group, RequestBody: body, OriginalNow: r.OriginalNow, ExpectedGeneration: r.ExpectedGeneration})
		if errors.Is(err, service.ErrSendTerminal) && receipt.Outcome == protocol.ReceiptUnknownAfterRestore && receipt.OperationID == r.OperationID {
			return receipt.Outcome, nil
		}
		return receipt.Outcome, err
	}}
}
func boundMusicReply(text string) string {
	const limit = 2800
	if len(text) <= limit {
		return text
	}
	text = text[:limit-4]
	for !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text + "\n…"
}
