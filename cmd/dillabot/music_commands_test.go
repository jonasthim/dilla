//go:build linux

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/session"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type commandState struct{ values map[string]native.StateValue }

func (s *commandState) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	if area != 8 || len(key) > 128 {
		return native.StateValue{}, errors.New("invalid key")
	}
	return s.values[string(key)], nil
}
func (s *commandState) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	out := make([]uint64, len(changes))
	for i, c := range changes {
		v := s.values[string(c.Key)]
		if v.Revision != c.ExpectedRevision {
			return nil, errors.New("conflict")
		}
		v.Revision++
		v.Value = append([]byte(nil), c.Value...)
		s.values[string(c.Key)] = v
		out[i] = v.Revision
	}
	return out, nil
}

type commandCalls struct {
	community, channel, user id.ID
	joined                   bool
}

func (s commandCalls) Channels(context.Context, id.ID) ([]client.Channel, error) {
	return []client.Channel{{ID: s.channel, CommunityID: s.community, Kind: 1}}, nil
}
func (s commandCalls) ChannelCall(context.Context, id.ID) (client.ChannelCallState, error) {
	call := id.New()
	state := client.ChannelCallState{CallID: &call, GroupID: &call}
	if s.joined {
		state.Participants = []client.CallParticipant{{UserID: s.user}}
	}
	return state, nil
}
func commandFixture(t *testing.T, text string) (*musicChatCommands, native.GroupEvent, *[]protocol.Operation, *[]string) {
	t.Helper()
	community, voice, user := id.New(), id.New(), id.New()
	body := text
	event := native.GroupEvent{DeliveryID: 1, Group: id.New(), Community: community, Channel: id.New(), Message: id.New(), SenderUser: user, SenderDevice: id.New(), ReceivedAt: uint64(time.Now().Unix()), Body: &body}
	operations := []protocol.Operation{}
	replies := []string{}
	revision := uint64(0)
	handlers := map[protocol.Operation]service.InteractionHandlerSpec{}
	for _, op := range []protocol.Operation{10, 12, 13, 14, 15, 16} {
		current := op
		handlers[op] = service.InteractionHandlerSpec{Handle: func(_ context.Context, a service.InteractionActor, r protocol.Request) (service.InteractionResult, error) {
			if a.User != user || r.ChannelID == nil || *r.ChannelID != voice || r.CommunityID != community {
				t.Fatal("command lost authenticated actor or voice context")
			}
			operations = append(operations, current)
			if current == 10 {
				data, _ := cborx.Marshal([]any{uint64(1), revision, nil, []any{}, uint64(0), uint64(1), uint64(75), uint64(0), uint64(0), uint64(1)})
				return service.InteractionResult{Revision: &revision, Data: data}, nil
			}
			if r.Revision == nil || *r.Revision != revision || r.Expires == nil {
				t.Fatal("missing CAS or expiry")
			}
			revision++
			v := revision
			return service.InteractionResult{Revision: &v}, nil
		}}
	}
	h := &musicChatCommands{generation: func(context.Context) (uint64, error) { return 1, nil }, community: community, state: &commandState{values: map[string]native.StateValue{}}, calls: commandCalls{community, voice, user, true}, handlers: handlers, send: func(_ context.Context, _ native.GroupEvent, _ musicCommandRecord, text string) (protocol.SendOutcome, error) {
		replies = append(replies, text)
		return protocol.ReceiptAccepted, nil
	}}
	return h, event, &operations, &replies
}
func TestMusicChatPlayUsesCurrentVoiceAndDoesNotRepeatOnRedelivery(t *testing.T) {
	h, event, ops, replies := commandFixture(t, "/play northern lights")
	if err := h.HandleGroupEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if err := h.HandleGroupEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if len(*ops) != 3 || (*ops)[0] != 10 || (*ops)[1] != 12 || (*ops)[2] != 14 {
		t.Fatalf("operations=%v", *ops)
	}
	if len(*replies) != 1 || !strings.Contains((*replies)[0], "Playing") {
		t.Fatalf("replies=%v", *replies)
	}
}
func TestMusicChatRejectsMissingVoiceAndBotOrEditedMessages(t *testing.T) {
	h, event, ops, replies := commandFixture(t, "/skip")
	c := h.calls.(commandCalls)
	c.joined = false
	h.calls = c
	if err := h.HandleGroupEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if len(*ops) != 0 || len(*replies) != 1 || !strings.Contains((*replies)[0], "Join a voice channel") {
		t.Fatalf("ops=%v replies=%v", *ops, *replies)
	}
	for _, kind := range []uint64{1, 2} {
		e := event
		e.Message = id.New()
		e.SenderKind = kind
		h.HandleGroupEvent(t.Context(), e)
	}
	e := event
	e.Message = id.New()
	e.EnvelopeType = 1
	h.HandleGroupEvent(t.Context(), e)
	if len(*replies) != 1 {
		t.Fatal("bot or edit executed a command")
	}
}
func TestMusicChatRetriesReplyWithoutRepeatingMutation(t *testing.T) {
	h, event, ops, replies := commandFixture(t, "/skip")
	sender := h.send
	h.send = func(context.Context, native.GroupEvent, musicCommandRecord, string) (protocol.SendOutcome, error) {
		return protocol.ReceiptUnknownAfterRestore, errors.New("temporary upload failure")
	}
	if err := h.HandleGroupEvent(t.Context(), event); err == nil {
		t.Fatal("send failure not retained")
	}
	before := len(*ops)
	h.send = sender
	if err := h.HandleGroupEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if len(*ops) != before || len(*replies) != 1 {
		t.Fatal("reply retry reran music mutation")
	}
}
func TestMusicChatPermissionFailureIsVisible(t *testing.T) {
	h, event, _, replies := commandFixture(t, "/stop")
	h.handlers[16] = service.InteractionHandlerSpec{Handle: func(context.Context, service.InteractionActor, protocol.Request) (service.InteractionResult, error) {
		return service.InteractionResult{Status: 2}, nil
	}}
	if err := h.HandleGroupEvent(t.Context(), event); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*replies)[0], "DJ") {
		t.Fatalf("reply=%v", *replies)
	}
}

type commandMusicAuthority struct{ voice, call id.ID }

func (a commandMusicAuthority) CurrentCall(context.Context, id.ID) (service.MusicCallBinding, error) {
	return service.MusicCallBinding{ChannelID: a.voice, CallID: a.call, Active: true}, nil
}
func (commandMusicAuthority) CanUse(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return true, nil
}
func (commandMusicAuthority) CanDJ(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return true, nil
}
func (commandMusicAuthority) CanEmergencyStop(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return false, nil
}

type commandTrackResolver struct{}

func (commandTrackResolver) Resolve(context.Context, string) ([]music.Track, error) {
	return []music.Track{{Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Command track", DurationMS: 120000}}, nil
}
func TestMusicChatPlayStartsRealQueueSupervisorAndPausePersists(t *testing.T) {
	h, e, _, replies := commandFixture(t, "/play command track")
	voice := h.calls.(commandCalls).channel
	installation := id.New()
	n := &runtimeStateNative{binding: native.Binding{Instance: id.New(), Community: h.community, Installation: installation}, rows: map[string]native.StateValue{}}
	registry := newMusicQueueRegistry()
	defer registry.Close()
	publishers := &liveRuntimePublisherStarter{starts: map[id.ID]int{}}
	starterFor := func(channel id.ID) (session.QueueStarter, error) {
		return session.QueueStarter{OptionsFor: func(_ context.Context, track music.Track) (session.Options, error) {
			group := id.New()
			return session.Options{Community: h.community, Channel: channel, Provider: track.Provider, Track: track.CanonicalID, Call: client.Call{CallID: channel, GroupID: group, LiveKitURL: "wss://example.invalid", Token: "test"}, Group: group, PCM: liveRuntimePCM{}, Encoder: liveRuntimeEncoderStarter{}, Publisher: publishers, Epochs: runtimeEpochs{}}, nil
		}}, nil
	}
	if _, err := registry.ReconcileWithStarterFactory(t.Context(), installation, h.community, botMusicCapability, []client.Channel{{ID: voice, CommunityID: h.community, Kind: 1}}, n, starterFor); err != nil {
		t.Fatal(err)
	}
	store, ok := registry.QueueStore(installation, h.community)
	if !ok {
		t.Fatal("missing queue store")
	}
	interactions := service.MusicInteractions{Store: store, Authority: commandMusicAuthority{voice, id.New()}, Resolver: commandTrackResolver{}, InstallationID: installation, CommunityID: h.community, CurrentState: registry.CurrentState, OnPersistedSnapshot: musicSnapshotCommitCallback(registry, nil)}
	h.handlers = interactions.Handlers()
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	state, revision, err := registry.CurrentState(t.Context(), installation, h.community, voice)
	if err != nil || state.Paused || state.Current == nil || state.Current.Title != "Command track" || revision != 2 {
		t.Fatalf("play did not start real supervisor: paused=%v revision=%d err=%v replies=%v", state.Paused, revision, err, *replies)
	}
	publishers.mu.Lock()
	starts := publishers.starts[voice]
	publishers.mu.Unlock()
	if starts != 1 {
		t.Fatalf("publisher starts=%d", starts)
	}
	body := "/pause"
	e.Body = &body
	e.Message = id.New()
	e.DeliveryID++
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	state, revision, err = registry.CurrentState(t.Context(), installation, h.community, voice)
	if err != nil || !state.Paused || revision != 3 {
		t.Fatalf("pause not persisted in supervisor: revision=%d err=%v", revision, err)
	}
}

func TestMusicChatBoundsUnicodeQueueReplies(t *testing.T) {
	h, e, _, replies := commandFixture(t, "/queue")
	track := []any{"track", "youtube", "abcdefghijk", strings.Repeat("🎵", 160), "", "", uint64(0), ""}
	queue := make([]any, 10)
	for i := range queue {
		queue[i] = track
	}
	h.handlers[10] = service.InteractionHandlerSpec{Handle: func(context.Context, service.InteractionActor, protocol.Request) (service.InteractionResult, error) {
		data, _ := cborx.Marshal([]any{uint64(1), uint64(0), track, queue, uint64(0), uint64(0), uint64(75), uint64(0), uint64(0), uint64(1)})
		return service.InteractionResult{Data: data}, nil
	}}
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	body, _ := cborx.Marshal([]any{uint64(0), e.Message, (*replies)[0], []any{}, nil})
	if len(body) > 4000 {
		t.Fatalf("queue reply body has %d bytes; native limit is 4000", len(body))
	}
}

func TestMusicChatRotatesOnlyDefinitivelyClosedReplyAttempts(t *testing.T) {
	h, e, ops, _ := commandFixture(t, "/skip")
	var attempts []musicCommandRecord
	h.send = func(_ context.Context, _ native.GroupEvent, r musicCommandRecord, _ string) (protocol.SendOutcome, error) {
		attempts = append(attempts, r)
		if len(attempts) == 1 {
			return protocol.ReceiptClosedNotAccepted, nil
		}
		return protocol.ReceiptAccepted, nil
	}
	h.generation = func(context.Context) (uint64, error) { return uint64(len(attempts) + 1), nil }
	if err := h.HandleGroupEvent(t.Context(), e); err == nil {
		t.Fatal("closed attempt must wait for source reconciliation")
	}
	operations := len(*ops)
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	if len(*ops) != operations || len(attempts) != 2 {
		t.Fatal("closed reply reran music mutation")
	}
	a, b := attempts[0], attempts[1]
	if a.OperationID != b.OperationID || a.AttemptID == b.AttemptID || b.PredecessorAttemptID == nil || *b.PredecessorAttemptID != a.AttemptID || a.ExpectedGeneration != 1 || b.ExpectedGeneration != 2 {
		t.Fatal("replacement reply lost immutable attempt lineage")
	}
}

func TestMusicChatKeepsGenerationFrozenAfterUncertainUpload(t *testing.T) {
	h, e, _, _ := commandFixture(t, "/skip")
	var attempts []musicCommandRecord
	h.generation = func(context.Context) (uint64, error) { return uint64(len(attempts) + 1), nil }
	h.send = func(_ context.Context, _ native.GroupEvent, r musicCommandRecord, _ string) (protocol.SendOutcome, error) {
		attempts = append(attempts, r)
		if len(attempts) == 1 {
			return protocol.ReceiptUnknownAfterRestore, errors.New("network timeout")
		}
		return protocol.ReceiptAccepted, nil
	}
	if err := h.HandleGroupEvent(t.Context(), e); err == nil {
		t.Fatal("uncertain upload was acknowledged")
	}
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	if attempts[0].AttemptID != attempts[1].AttemptID || attempts[0].ExpectedGeneration != attempts[1].ExpectedGeneration {
		t.Fatal("uncertain send changed its prepared inputs")
	}
}
func TestMusicChatDoesNotRepeatUnknownReplyAfterRestore(t *testing.T) {
	h, e, ops, _ := commandFixture(t, "/skip")
	sends := 0
	h.send = func(context.Context, native.GroupEvent, musicCommandRecord, string) (protocol.SendOutcome, error) {
		sends++
		return protocol.ReceiptUnknownAfterRestore, nil
	}
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	before := len(*ops)
	if err := h.HandleGroupEvent(t.Context(), e); err != nil {
		t.Fatal(err)
	}
	if sends != 1 || len(*ops) != before {
		t.Fatal("unknown post-restore outcome was replayed")
	}
}
