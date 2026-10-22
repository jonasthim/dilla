//go:build linux

package main

import (
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
)

func runtimeInteractionHandlers(overview service.OverviewInteractions, announcements service.AnnouncementInteractions) map[protocol.Operation]service.InteractionHandlerSpec {
	handlers := overview.Handlers()
	for operation, handler := range announcements.ReadOnlyHandlers() {
		handlers[operation] = handler
	}
	return handlers
}
