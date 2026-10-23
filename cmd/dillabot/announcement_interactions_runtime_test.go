//go:build linux

package main

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/persistence"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

func TestRuntimeInteractionHandlersRegisterAnnouncementMutationsWithInHandlerRevisionChecks(t *testing.T) {
	community := id.New()
	handlers := runtimeInteractionHandlers(
		service.OverviewInteractions{CommunityID: community},
		service.AnnouncementInteractions{CommunityID: community},
		service.ModerationInteractions{CommunityID: community},
		nil,
	)
	if len(handlers) != 6 {
		t.Fatalf("runtime handlers has %d operations, want overview, announcements, welcome preview, and moderation cases", len(handlers))
	}
	if handlers[protocol.OpOverviewGet].Handle == nil || handlers[protocol.OpAnnouncementsList].Handle == nil || handlers[protocol.OpWelcomePreview].Handle == nil || handlers[protocol.OpModerationCases].Handle == nil {
		t.Fatalf("runtime handlers missing read operations: %v", handlers)
	}
	if put, ok := handlers[protocol.OpAnnouncementsPut]; !ok || put.Handle == nil || !put.RevisionInHandler || put.CurrentRevision != nil {
		t.Fatalf("runtime announcements.put handler=%+v; want in-handler atomic revision check", put)
	}
	if remove, ok := handlers[protocol.OpAnnouncementsDelete]; !ok || remove.Handle == nil || !remove.RevisionInHandler || remove.CurrentRevision != nil {
		t.Fatalf("runtime announcements.delete handler=%+v; want in-handler atomic revision check", remove)
	}
	if _, ok := handlers[protocol.OpModerationEvidence]; ok {
		t.Fatal("runtime handlers registered moderation.evidence")
	}
}

type runtimeMusicStoreFake struct{}

func (runtimeMusicStoreFake) Load(context.Context, id.ID) (persistence.Snapshot, error) {
	return persistence.Snapshot{}, nil
}
func (runtimeMusicStoreFake) Save(context.Context, id.ID, uint64, music.State) (persistence.Snapshot, error) {
	return persistence.Snapshot{}, nil
}

type runtimeMusicAuthorityFake struct{}

func (runtimeMusicAuthorityFake) CurrentCall(context.Context, id.ID) (service.MusicCallBinding, error) {
	return service.MusicCallBinding{}, nil
}
func (runtimeMusicAuthorityFake) CanUse(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return false, nil
}
func (runtimeMusicAuthorityFake) CanDJ(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return false, nil
}
func (runtimeMusicAuthorityFake) CanEmergencyStop(context.Context, service.InteractionActor, service.MusicCallBinding) (bool, error) {
	return false, nil
}

func TestRuntimeInteractionHandlersRegisterMusicOnlyWithCompleteAuthorityAndStore(t *testing.T) {
	community := id.New()
	base := func(music *service.MusicInteractions) map[protocol.Operation]service.InteractionHandlerSpec {
		return runtimeInteractionHandlers(service.OverviewInteractions{CommunityID: community}, service.AnnouncementInteractions{CommunityID: community}, service.ModerationInteractions{CommunityID: community}, music)
	}
	if handlers := base(&service.MusicInteractions{Authority: runtimeMusicAuthorityFake{}}); len(handlers) != 6 {
		t.Fatalf("music handlers registered without encrypted queue store: got %d operations", len(handlers))
	}
	music := &service.MusicInteractions{Store: runtimeMusicStoreFake{}, Authority: runtimeMusicAuthorityFake{}, CommunityID: community, InstallationID: id.New()}
	handlers := base(music)
	if len(handlers) != 20 {
		t.Fatalf("runtime handlers has %d operations, want 6 existing plus 14 music operations", len(handlers))
	}
	for _, op := range []protocol.Operation{protocol.OpMusicState, protocol.OpMusicSearch, protocol.OpMusicEnqueue, protocol.OpMusicPause, protocol.OpMusicResume, protocol.OpMusicSkip, protocol.OpMusicStop, protocol.OpMusicSeek, protocol.OpMusicVolume, protocol.OpMusicShuffle, protocol.OpMusicRepeat, protocol.OpMusicRemove, protocol.OpMusicMove, protocol.OpMusicClear} {
		spec, ok := handlers[op]
		if !ok || spec.Handle == nil {
			t.Fatalf("runtime music operation %d was not registered", op)
		}
		if op != protocol.OpMusicState && op != protocol.OpMusicSearch && !spec.RevisionInHandler {
			t.Fatalf("music mutation %d lacks in-handler revision check", op)
		}
	}
}
