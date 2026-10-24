//go:build linux

package main

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type groupEventHighWaterSource interface {
	Binding() native.Binding
	ReadGroupEvents(context.Context, uint64, uint64) (native.GroupEventPage, error)
}

type autoModerationEventStateEntry struct {
	community             id.ID
	revision              uint64
	replayThrough         uint64
	replayReceivedThrough uint64
	runtime               *service.AutoModerationRuntime
}

// autoModerationEventState preserves rolling evaluator state during a process
// lifetime and snapshots a conservative replay barrier at process start or
// after a config revision changes. The helper's acknowledged cursor remains
// the durable delivery cursor across restarts.
type autoModerationEventState struct {
	mu      sync.Mutex
	entries map[id.ID]autoModerationEventStateEntry
}

func newAutoModerationEventState() *autoModerationEventState {
	return &autoModerationEventState{entries: make(map[id.ID]autoModerationEventStateEntry)}
}

func logOnlyModerationConfig() moderation.Config {
	return moderation.Config{Actions: map[moderation.Rule]moderation.Action{
		moderation.RuleRate: moderation.ActionLog, moderation.RuleDuplicate: moderation.ActionLog, moderation.RuleMentions: moderation.ActionLog,
	}}
}

func configureAutoModeration(ctx context.Context, state *autoModerationEventState, n *native.Client, session *client.Session,
	installation, community id.ID, logger *slog.Logger) (*service.AutoModerationRuntime, uint64, uint64, *service.ModerationCaseSink, error) {
	if n == nil || session == nil {
		return nil, 0, 0, nil, errors.New("missing automatic moderation client or session")
	}
	cfg, revision, err := moderation.NewStore(n).Load(ctx)
	if err != nil {
		if logger != nil {
			logger.Warn("bot automatic moderation settings unavailable; keeping log-only defaults", "installation_id", installation.String(), "error", err.Error())
		}
		cfg = logOnlyModerationConfig()
		revision = 0
	}
	var authority service.ModerationActorAuthority
	if cfg.Enabled {
		resolved, authorityErr := service.NewCommunityActorAuthority(session, community, nil)
		if authorityErr != nil {
			return nil, 0, 0, nil, authorityErr
		}
		authority = resolved
	}
	var backend service.ModerationEnforcementBackend
	if cfg.Enabled && moderationBackendRequired(cfg) {
		backend, err = service.NewModerationRemovalBackend(n, session)
		if err != nil {
			if logger != nil {
				logger.Warn("bot moderation enforcement unavailable; keeping rules log-only", "installation_id", installation.String())
			}
			setModerationActionsLogOnly(&cfg)
			backend = nil
		}
	}
	sink, err := service.NewModerationCaseSink(n, backend, nil)
	if err != nil {
		return nil, 0, 0, nil, err
	}
	runtime, replayThrough, replayReceivedThrough, err := state.Configure(ctx, n, installation, community, revision, cfg, authority, sink)
	return runtime, replayThrough, replayReceivedThrough, sink, err
}

func moderationBackendRequired(cfg moderation.Config) bool {
	for _, action := range cfg.Actions {
		if action == moderation.ActionRemove || action == moderation.ActionWarn || action == moderation.ActionTimeout {
			return true
		}
	}
	return false
}

func setModerationActionsLogOnly(cfg *moderation.Config) {
	if cfg == nil {
		return
	}
	for rule, action := range cfg.Actions {
		if action == moderation.ActionRemove || action == moderation.ActionWarn || action == moderation.ActionTimeout {
			cfg.Actions[rule] = moderation.ActionLog
		}
	}
}

func (s *autoModerationEventState) Configure(ctx context.Context, source groupEventHighWaterSource, installation, community id.ID, revision uint64,
	cfg moderation.Config, authority service.ModerationActorAuthority, sink service.ModerationActionSink) (*service.AutoModerationRuntime, uint64, uint64, error) {
	if s == nil || ctx == nil || source == nil || installation.IsZero() || community.IsZero() {
		return nil, 0, 0, errors.New("missing automatic moderation event state dependency")
	}
	binding := source.Binding()
	if binding.Installation != installation || binding.Community != community || binding.Installation.IsZero() || binding.Community.IsZero() {
		return nil, 0, 0, errors.New("automatic moderation event source binding mismatch")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.entries[installation]; ok && entry.community == community && entry.revision == revision {
		entry.runtime.UpdateActionDependencies(authority, sink)
		s.entries[installation] = entry
		return entry.runtime, entry.replayThrough, entry.replayReceivedThrough, nil
	}
	// Capture before sampling the journal. Source-sync pages may arrive later,
	// so their authoritative server receipt times are the second replay fence.
	replayReceivedThrough := uint64(time.Now().UnixMilli())
	page, err := source.ReadGroupEvents(ctx, 0, 1)
	if err != nil {
		return nil, 0, 0, err
	}
	if page.Next > page.HighWater || page.HighWater > math.MaxInt64 {
		return nil, 0, 0, errors.New("invalid automatic moderation event high-water mark")
	}
	runtime := service.NewAutoModerationRuntime(cfg, authority, sink, nil)
	entry := autoModerationEventStateEntry{community: community, revision: revision, replayThrough: page.HighWater,
		replayReceivedThrough: replayReceivedThrough, runtime: runtime}
	s.entries[installation] = entry
	return runtime, entry.replayThrough, entry.replayReceivedThrough, nil
}

func (s *autoModerationEventState) RetainOnly(installations []id.ID) {
	if s == nil {
		return
	}
	active := make(map[id.ID]struct{}, len(installations))
	for _, installation := range installations {
		active[installation] = struct{}{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for installation := range s.entries {
		if _, ok := active[installation]; !ok {
			delete(s.entries, installation)
		}
	}
}

func (s *autoModerationEventState) Disable(installation id.ID) {
	if s == nil || installation.IsZero() {
		return
	}
	s.mu.Lock()
	delete(s.entries, installation)
	s.mu.Unlock()
}
