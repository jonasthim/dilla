//go:build linux

package main

import (
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

func TestRuntimeInteractionHandlersRegisterAnnouncementListOnly(t *testing.T) {
	community := id.New()
	handlers := runtimeInteractionHandlers(
		service.OverviewInteractions{CommunityID: community},
		service.AnnouncementInteractions{CommunityID: community},
	)
	if len(handlers) != 2 {
		t.Fatalf("runtime handlers has %d operations, want overview.get and announcements.list", len(handlers))
	}
	if handlers[protocol.OpOverviewGet].Handle == nil || handlers[protocol.OpAnnouncementsList].Handle == nil {
		t.Fatalf("runtime handlers missing read operations: %v", handlers)
	}
	if _, ok := handlers[protocol.OpAnnouncementsPut]; ok {
		t.Fatal("runtime handlers registered announcements.put")
	}
	if _, ok := handlers[protocol.OpAnnouncementsDelete]; ok {
		t.Fatal("runtime handlers registered announcements.delete")
	}
}
