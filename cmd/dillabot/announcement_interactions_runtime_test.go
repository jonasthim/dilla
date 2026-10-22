//go:build linux

package main

import (
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

func TestRuntimeInteractionHandlersRegisterReadOperationsOnly(t *testing.T) {
	community := id.New()
	handlers := runtimeInteractionHandlers(
		service.OverviewInteractions{CommunityID: community},
		service.AnnouncementInteractions{CommunityID: community},
		service.ModerationInteractions{CommunityID: community},
	)
	if len(handlers) != 3 {
		t.Fatalf("runtime handlers has %d operations, want overview.get, announcements.list, and moderation.cases", len(handlers))
	}
	if handlers[protocol.OpOverviewGet].Handle == nil || handlers[protocol.OpAnnouncementsList].Handle == nil || handlers[protocol.OpModerationCases].Handle == nil {
		t.Fatalf("runtime handlers missing read operations: %v", handlers)
	}
	if _, ok := handlers[protocol.OpAnnouncementsPut]; ok {
		t.Fatal("runtime handlers registered announcements.put")
	}
	if _, ok := handlers[protocol.OpAnnouncementsDelete]; ok {
		t.Fatal("runtime handlers registered announcements.delete")
	}
	if _, ok := handlers[protocol.OpModerationEvidence]; ok {
		t.Fatal("runtime handlers registered moderation.evidence")
	}
}
