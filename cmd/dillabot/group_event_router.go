//go:build linux

package main

import (
	"context"
	"errors"
	"regexp"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type automaticModerationEventHandler interface {
	Handle(context.Context, native.GroupEvent, bool, []string) (moderation.Decision, error)
}

type groupEventRouter struct {
	inspector      interactionEventInspection
	interactions   service.GroupEventHandler
	automoderation automaticModerationEventHandler
	replayThrough  uint64
}

var moderationMentionPattern = regexp.MustCompile(`<@([0-9a-f]{32})>`)

func newGroupEventRouter(inspector interactionEventInspection, interactions service.GroupEventHandler, automoderation automaticModerationEventHandler, replayThrough uint64) service.GroupEventHandler {
	return groupEventRouter{inspector: inspector, interactions: interactions, automoderation: automoderation, replayThrough: replayThrough}
}

func (h groupEventRouter) HandleGroupEvent(ctx context.Context, event native.GroupEvent) error {
	if ctx == nil || h.inspector == nil || event.DeliveryID == 0 || event.Group.IsZero() {
		return errors.New("missing or invalid bot group event dependency")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	group, err := h.inspector.InspectGroup(ctx, event.Group)
	if err != nil {
		return err
	}
	if group.ID != event.Group {
		return errors.New("native bot event group inspection mismatch")
	}
	switch group.Kind {
	case 0: // Native text group: only authenticated message and edit snapshots are eligible.
		if event.EnvelopeType != 0 && event.EnvelopeType != 1 {
			return nil
		}
		if h.automoderation == nil {
			return nil
		}
		mentions := moderationMentionIDs(event.Body)
		_, err := h.automoderation.Handle(ctx, event, event.DeliveryID <= h.replayThrough, mentions)
		return err
	case 3: // Managed kind-3 interaction behavior retains its existing durable sender path.
		if h.interactions == nil {
			return errors.New("missing native interaction event handler")
		}
		return h.interactions.HandleGroupEvent(ctx, event)
	default:
		// The helper journal only emits snapshots from text and interaction groups.
		// Unknown future kinds are consumed without interpreting their body.
		return nil
	}
}

func moderationMentionIDs(body *string) []string {
	if body == nil {
		return nil
	}
	matches := moderationMentionPattern.FindAllStringSubmatch(*body, -1)
	if len(matches) == 0 {
		return nil
	}
	mentions := make([]string, 0, len(matches))
	for _, match := range matches {
		if len(match) != 2 {
			continue
		}
		if _, err := id.Parse(match[1]); err == nil {
			mentions = append(mentions, match[1])
		}
	}
	return mentions
}
