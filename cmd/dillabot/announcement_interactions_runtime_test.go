//go:build linux

package main

import (
	"testing"

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
	)
	if len(handlers) != 5 {
		t.Fatalf("runtime handlers has %d operations, want overview.get, announcements.list, announcements.put, announcements.delete, and moderation.cases", len(handlers))
	}
	if handlers[protocol.OpOverviewGet].Handle == nil || handlers[protocol.OpAnnouncementsList].Handle == nil || handlers[protocol.OpModerationCases].Handle == nil {
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
