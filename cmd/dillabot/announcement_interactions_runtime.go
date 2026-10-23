//go:build linux

package main

import (
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
)

func runtimeInteractionHandlers(overview service.OverviewInteractions, announcements service.AnnouncementInteractions, moderation service.ModerationInteractions, music *service.MusicInteractions, nativeClient service.WelcomeSettingsNative) map[protocol.Operation]service.InteractionHandlerSpec {
	handlers := overview.Handlers()
	for operation, handler := range announcements.Handlers() {
		handlers[operation] = handler
	}
	for operation, handler := range (service.WelcomeInteractions{Authority: announcements.Authority, CommunityID: announcements.CommunityID, Native: nativeClient}).Handlers() {
		handlers[operation] = handler
	}
	if cases, ok := moderation.Handlers()[protocol.OpModerationCases]; ok {
		handlers[protocol.OpModerationCases] = cases
	}
	// OpModerationEvidence stays unavailable: its client-authored ID/reason/
	// excerpt tuple carries no authoritative accepted-action receipt.
	if music != nil && music.Store != nil && music.Authority != nil {
		for operation, handler := range music.Handlers() {
			handlers[operation] = handler
		}
	}
	return handlers
}
