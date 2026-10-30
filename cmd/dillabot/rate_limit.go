//go:build linux

package main

import (
	"log/slog"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
)

func logBotRateLimit(logger *slog.Logger, installation id.ID, refusal *client.APIError) {
	var retry uint64
	if refusal.RetryAfterMS != nil {
		retry = *refusal.RetryAfterMS
	}
	logger.Info("bot rate limited; resuming next tick", "installation_id", installation.String(), "retry_after_ms", retry)
}

// A joined maintenance error is deferred only when every cause is transient.
func reconciliationRateLimit(err error) *client.APIError { return client.RateLimitError(err) }

func cleanupUnreadyInstallation(installation id.ID, ready bool, passErr error, registry *musicQueueRegistry, moderation *autoModerationEventState) {
	if !ready && reconciliationRateLimit(passErr) == nil {
		_ = registry.Disable(installation)
		moderation.Disable(installation)
	}
}
