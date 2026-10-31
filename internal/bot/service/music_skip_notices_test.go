package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type musicNoticeSender struct{ bodies []string }

func (s *musicNoticeSender) Send(_ context.Context, _ *client.Session, input SendInput) (protocol.SendReceipt, error) {
	var body []any
	if err := cborx.Unmarshal(input.RequestBody, &body); err != nil {
		return protocol.SendReceipt{}, err
	}
	s.bodies = append(s.bodies, body[2].(string))
	return protocol.SendReceipt{OperationID: input.OperationID, AttemptID: input.AttemptID, GroupID: input.GroupID, Outcome: protocol.ReceiptAccepted}, nil
}

func TestMusicAnnounceRegistersPausedDestinationBeforeStart(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, true)
	notices := &MusicSkipNotices{}
	h := MusicAnnouncements{Music: &MusicInteractions{Store: f.store, Authority: f.authority}, Authority: f.member, Channels: f.member, Destination: &rolePanelDestinationFake{group: f.group}, Sender: f.sender, Discovery: &rolePanelDiscoveryFake{generation: 7}, Session: &client.Session{}, CommunityID: f.community, Notices: notices}
	zero, expires := uint64(0), uint64(130)
	request := protocol.Request{RequestID: f.request, CommunityID: f.community, ChannelID: &f.voice, Operation: protocol.OpMusicAnnounce, Revision: &zero, Expires: &expires, Args: []any{f.text}}
	result, err := h.announce(context.Background(), InteractionActor{User: actor}, request)
	if err != nil || result.Status != 0 || f.sender.calls != 0 {
		t.Fatalf("registration=%+v err=%v sends=%d", result, err, f.sender.calls)
	}
	route, ok := notices.destinations[f.voice]
	if !ok || route.text != f.text || route.actor.User != actor {
		t.Fatalf("route=%+v known=%v", route, ok)
	}
}

func TestMusicSkipNoticesSendThreeLinesAndRecheckChannelAuthority(t *testing.T) {
	actor := id.New()
	f := newMusicAnnounceFixture(actor, true)
	notices := &MusicSkipNotices{}
	var logs bytes.Buffer

	sender := &musicNoticeSender{}
	h := MusicAnnouncements{Music: &MusicInteractions{Authority: f.authority}, Channels: f.member, Destination: &rolePanelDestinationFake{group: f.group}, Sender: sender, Discovery: &rolePanelDiscoveryFake{generation: 7}, Session: &client.Session{}, CommunityID: f.community}
	// A successful fake receipt must carry the scoped community too.
	scoped := musicScopedNoticeSender{inner: sender, community: f.community}
	h.Sender = scoped
	notices.Configure(h, slog.New(slog.NewJSONHandler(&logs, nil)))
	failure := &music.StartError{Stage: "provider_check", Cause: errors.New("private provider details")}
	notices.Notify(context.Background(), f.voice, music.Track{Title: "No destination"}, failure)
	if len(sender.bodies) != 0 || !strings.Contains(logs.String(), `"notice_destination_known":false`) {
		t.Fatal("missing destination sent content or wasn't logged")
	}
	notices.Register(f.voice, f.text, InteractionActor{User: actor})
	for _, title := range []string{"one", "two https://private.example/video", "three"} {
		notices.Notify(context.Background(), f.voice, music.Track{Title: title, CanonicalID: "private-id"}, failure)
	}
	if len(sender.bodies) != 3 {
		t.Fatalf("lines=%v logs=%s", sender.bodies, logs.String())
	}
	for _, body := range sender.bodies {
		if !strings.HasPrefix(body, "Couldn't play ") || !strings.HasSuffix(body, "(provider unavailable). Skipping.") || strings.Contains(body, "https://") || strings.Contains(body, "private-id") {
			t.Fatalf("notice=%q", body)
		}
	}
	delete(f.member.channel, f.text)
	notices.Notify(context.Background(), f.voice, music.Track{Title: "revoked"}, failure)
	if len(sender.bodies) != 3 {
		t.Fatal("revoked text permission posted a notice")
	}
	if strings.Contains(logs.String(), "private provider details") || strings.Contains(logs.String(), "private.example") {
		t.Fatal("notice log leaked content")
	}
}

type musicScopedNoticeSender struct {
	inner     *musicNoticeSender
	community id.ID
}

func (s musicScopedNoticeSender) Send(ctx context.Context, session *client.Session, input SendInput) (protocol.SendReceipt, error) {
	receipt, err := s.inner.Send(ctx, session, input)
	receipt.CommunityID = s.community
	return receipt, err
}
