package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type musicAnnounceAuthorityFake struct {
	bits    uint64
	present bool
	admin   bool
	// channel holds each channel's effective bits for the actor (overrides applied); absent: not visible.
	channel map[id.ID]uint64
	asked   []id.ID
}

func (f *musicAnnounceAuthorityFake) BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error) {
	return client.ActorAuthority{EffectiveBits: f.bits, Administrator: f.admin}, f.present, nil
}

func (f *musicAnnounceAuthorityFake) BotActorChannelAuthority(_ context.Context, _, _, channel id.ID) (uint64, bool, error) {
	f.asked = append(f.asked, channel)
	bits, ok := f.channel[channel]
	return bits, ok, nil
}

type musicAnnounceFixture struct {
	community, actor, voice, text, group, request id.ID
	item                                          string
	now                                           time.Time
	live                                          *music.State
	limiter                                       *MusicAnnounceLimiter
	store                                         *musicInteractionStoreFake
	authority                                     *musicInteractionAuthorityFake
	sender                                        *rolePanelSendFake
	member                                        *musicAnnounceAuthorityFake
}

func newMusicAnnounceFixture(requester id.ID, paused bool) *musicAnnounceFixture {
	f := &musicAnnounceFixture{community: id.New(), actor: requester, voice: id.New(), text: id.New(), group: id.New(), request: id.New(),
		item: id.New().String(), now: time.Unix(100, 0), limiter: &MusicAnnounceLimiter{}}
	state := music.InitialState()
	track := music.Track{ID: f.item, Provider: music.ProviderYouTube, CanonicalID: "abcdefghijk", Title: "Sea shanties", RequesterID: requester.String(), DurationMS: 214000}
	// The track started 5 s before the request (security review L6: within 30 s).
	state.Current, state.Paused, state.Revision, state.PositionAtMS = &track, paused, 3, 95_000
	f.store = &musicInteractionStoreFake{snapshot: persistence.Snapshot{State: state, Revision: 3}}
	f.authority = &musicInteractionAuthorityFake{call: MusicCallBinding{CallID: id.New(), ChannelID: f.voice, Active: true}, user: true, dj: true}
	operation, attempt := musicAnnounceIDs(f.community, f.voice, track.ID)
	f.sender = &rolePanelSendFake{receipt: protocol.SendReceipt{OperationID: operation, AttemptID: attempt, CommunityID: f.community, GroupID: f.group,
		ExpectedGeneration: 7, Outcome: protocol.ReceiptAccepted, SendResponse: &protocol.OriginalSendResponse{Sequence: 9}}}
	// Community bits allow everything; the text channel's own bits decide.
	f.member = &musicAnnounceAuthorityFake{bits: 1<<0 | 1<<1 | 1<<6, present: true, channel: map[id.ID]uint64{f.text: musicAnnounceChannelSend}}
	return f
}

func (f *musicAnnounceFixture) run(t *testing.T, actor id.ID) InteractionResult {
	t.Helper()
	musicHandler := &MusicInteractions{Store: f.store, Authority: f.authority, CommunityID: f.community}
	if f.live != nil {
		live := *f.live
		musicHandler.CurrentState = func(context.Context, id.ID, id.ID, id.ID) (music.State, uint64, error) {
			return live, live.Revision, nil
		}
	}
	h := MusicAnnouncements{Music: musicHandler, Authority: f.member, Channels: f.member, Limiter: f.limiter,
		Destination: &rolePanelDestinationFake{group: f.group}, Sender: f.sender, Discovery: &rolePanelDiscoveryFake{generation: 7},
		Session: &client.Session{}, CommunityID: f.community, Now: func() time.Time { return f.now }}
	zero, expires := uint64(0), uint64(130)
	result, err := h.Handlers()[protocol.OpMusicAnnounce].Handle(context.Background(), InteractionActor{User: actor}, protocol.Request{
		RequestID: f.request, CommunityID: f.community, ChannelID: &f.voice, Operation: protocol.OpMusicAnnounce, Revision: &zero, Expires: &expires, Args: []any{f.text}})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestMusicAnnouncePostsTheMarkerInTheTextChannelForTheRequester(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, false)
	result := f.run(t, actor)
	if result.Status != 0 || f.sender.calls != 1 {
		t.Fatalf("announce result=%+v sends=%d", result, f.sender.calls)
	}
	if f.sender.input.GroupID != f.group {
		t.Fatalf("sent to group %s, want the text channel's %s", f.sender.input.GroupID, f.group)
	}
	var body []any
	if err := cborx.Unmarshal(f.sender.input.RequestBody, &body); err != nil || len(body) != 5 {
		t.Fatalf("body=%v err=%v", body, err)
	}
	text, _ := body[2].(string)
	if !strings.HasSuffix(text, "\n[dilla-music:v1:"+f.voice.String()+":"+actor.String()+":"+f.item+"]") {
		t.Fatalf("body text %q lacks the player marker", text)
	}
	var identity []any
	if err := cborx.Unmarshal(result.Data, &identity); err != nil || len(identity) != 2 || identity[1] != uint64(9) {
		t.Fatalf("identity=%v err=%v", identity, err)
	}
}

func TestMusicAnnounceOncePerTrack(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, false)
	f.run(t, actor)
	first := f.sender.input
	f.request = id.New()
	f.run(t, actor)
	if f.sender.input.OperationID != first.OperationID || f.sender.input.AttemptID != first.AttemptID {
		t.Fatal("a second announcement of the same track must resume the first send, not post again")
	}
}

func TestMusicAnnounceRefusals(t *testing.T) {
	requester := id.New()
	cases := map[string]func(*musicAnnounceFixture) id.ID{
		"not the requester": func(*musicAnnounceFixture) id.ID { return id.New() },
		"not a DJ":          func(f *musicAnnounceFixture) id.ID { f.authority.dj = false; return requester },
		// A role override denies sending in this channel although the community bits allow it.
		"channel override denies send": func(f *musicAnnounceFixture) id.ID { f.member.channel[f.text] = 1<<0 | 1<<6; return requester },
		// A private channel the requester cannot see: a spoofed destination id gets no message.
		"spoofed private channel": func(f *musicAnnounceFixture) id.ID { f.text = id.New(); return requester },
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			f := newMusicAnnounceFixture(requester, false)
			actor := setup(f)
			if result := f.run(t, actor); result.Status != interactionStatusForbidden || f.sender.calls != 0 {
				t.Fatalf("result=%+v sends=%d, want forbidden and no send", result, f.sender.calls)
			}
		})
	}
	t.Run("nothing playing", func(t *testing.T) {
		f := newMusicAnnounceFixture(requester, true)
		if result := f.run(t, requester); result.Status != interactionStatusUnavailable || f.sender.calls != 0 {
			t.Fatalf("result=%+v sends=%d, want unavailable and no send", result, f.sender.calls)
		}
	})
}

func TestMusicAnnounceRequestShape(t *testing.T) {
	zero, expires, one := uint64(0), uint64(130), uint64(1)
	voice, text := id.New(), id.New()
	ok := protocol.Request{RequestID: id.New(), CommunityID: id.New(), ChannelID: &voice, Operation: protocol.OpMusicAnnounce, Revision: &zero, Expires: &expires, Args: []any{text}}
	encoded, err := protocol.EncodeRequest(ok)
	if err != nil {
		t.Fatalf("encode op 25: %v", err)
	}
	if _, err := protocol.DecodeRequest(encoded); err != nil {
		t.Fatalf("decode op 25: %v", err)
	}
	bad := ok
	bad.Revision = &one
	if _, err := protocol.EncodeRequest(bad); err == nil {
		t.Fatal("op 25 must require revision 0")
	}
}

func TestMusicAnnounceChecksTheNamedChannelsOwnPermissions(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, false)
	if result := f.run(t, actor); result.Status != 0 || f.sender.calls != 1 {
		t.Fatalf("allowed in the channel: result=%+v sends=%d", result, f.sender.calls)
	}
	if len(f.member.asked) != 1 || f.member.asked[0] != f.text {
		t.Fatalf("channel authority asked for %v, want exactly the named text channel %s", f.member.asked, f.text)
	}
	// Security review L4: an administrator goes through the channel resolver too (no shortcut).
	admin := newMusicAnnounceFixture(actor, false)
	admin.member.admin = true
	admin.member.channel = map[id.ID]uint64{}
	if result := admin.run(t, actor); result.Status != interactionStatusForbidden || admin.sender.calls != 0 {
		t.Fatalf("an administrator who cannot see the channel: result=%+v sends=%d", result, admin.sender.calls)
	}
}

// Security review L5: a live state that is not the stored revision is a conflict, never announced.
func TestMusicAnnounceRefusesARevisionRace(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, false)
	live := f.store.snapshot.State
	live.Revision = 4
	f.live = &live
	if result := f.run(t, actor); result.Status != interactionStatusConflict || f.sender.calls != 0 {
		t.Fatalf("result=%+v sends=%d, want conflict and no send", result, f.sender.calls)
	}
}

// Security review L6: only a track that started within 30 s, and one new track per requester per minute.
func TestMusicAnnounceWindowAndRate(t *testing.T) {
	actor := id.New()
	late := newMusicAnnounceFixture(actor, false)
	late.store.snapshot.State.PositionAtMS = 60_000
	if result := late.run(t, actor); result.Status != interactionStatusUnavailable || late.sender.calls != 0 {
		t.Fatalf("a track 40 s in: result=%+v sends=%d", result, late.sender.calls)
	}
	f := newMusicAnnounceFixture(actor, false)
	if result := f.run(t, actor); result.Status != 0 {
		t.Fatalf("first announcement: %+v", result)
	}
	if result := f.run(t, actor); result.Status != 0 || f.sender.calls != 2 {
		t.Fatalf("a retry of the same track resumes its send: %+v sends=%d", result, f.sender.calls)
	}
	next := id.New().String()
	f.store.snapshot.State.Current.ID = next
	f.now = f.now.Add(10 * time.Second)
	f.store.snapshot.State.PositionAtMS = f.now.UnixMilli()
	if result := f.run(t, actor); result.Status != interactionStatusUnavailable || f.sender.calls != 2 {
		t.Fatalf("another track within a minute: %+v sends=%d", result, f.sender.calls)
	}
	f.now = f.now.Add(time.Minute)
	f.store.snapshot.State.PositionAtMS = f.now.UnixMilli()
	operation, attempt := musicAnnounceIDs(f.community, f.voice, next)
	f.sender.receipt.OperationID, f.sender.receipt.AttemptID = operation, attempt
	if result := f.run(t, actor); result.Status != 0 || f.sender.calls != 3 {
		t.Fatalf("another track after a minute: %+v sends=%d", result, f.sender.calls)
	}
}

func TestNeutralizeBotMarkersKeepsMembersFromForgingThePlayer(t *testing.T) {
	forged := "hi\n[dilla-music:v1:" + id.New().String() + ":" + id.New().String() + ":" + id.New().String() + "]"
	if got := NeutralizeBotMarkers(forged); strings.Contains(got, "[dilla-music:") {
		t.Fatalf("marker survived: %q", got)
	}
	text, err := rolePanelMessage([]rolePanelOption{{Emoji: "x", Name: "[dilla-music:v1:a:b:c]", Role: id.New()}})
	if err != nil || strings.Contains(text, "[dilla-music:") {
		t.Fatalf("role panel text %q err %v", text, err)
	}
}
