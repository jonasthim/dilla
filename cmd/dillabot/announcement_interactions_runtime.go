//go:build linux

package main

import (
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
)

func runtimeInteractionHandlers(overview service.OverviewInteractions, announcements service.AnnouncementInteractions, moderation service.ModerationInteractions, music *service.MusicInteractions) map[protocol.Operation]service.InteractionHandlerSpec {
	handlers := overview.Handlers()
	for operation, handler := range announcements.Handlers() {
		handlers[operation] = handler
	}
	if cases, ok := moderation.Handlers()[protocol.OpModerationCases]; ok {
		handlers[protocol.OpModerationCases] = cases
	}
	if music != nil && music.Store != nil && music.Authority != nil {
		for operation, handler := range music.Handlers() {
			handlers[operation] = handler
		}
	}
	return handlers
}
