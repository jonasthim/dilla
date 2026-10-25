package service

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
)

// ModerationAction is the bounded information handed to an action or audit
// sink. The decrypted message body is never retained here.
type ModerationAction struct {
	Community, Group, Channel, Actor, Message string
	SourceRevision                            uint64
	Decision                                  moderation.Decision
	Excerpt                                   string
	ReceivedAt                                time.Time
	runtimeGenerated                          bool
}

// ModerationActionSink is the application boundary for logging, warnings, or
// future enforcement primitives. The runtime itself does not remove members
// or apply timeouts.
type ModerationActionSink interface {
	ApplyModerationAction(context.Context, ModerationAction) error
}

// ModerationActorAuthority resolves privileged roles from trusted community
// membership state, never from the message event itself.
type ModerationActorAuthority interface {
	ModerationActorRoles(context.Context, native.GroupEvent) (owner, admin bool, err error)
}

// AutoModerationRuntime evaluates authenticated, decrypted native group
// events. Callers must pass events obtained from native.ReadGroupEvents.
type AutoModerationRuntime struct {
	mu        sync.RWMutex
	configMu  sync.RWMutex
	engine    *moderation.Engine
	authority ModerationActorAuthority
	sink      ModerationActionSink
	now       func() time.Time
	enabled   bool
}

// AutoModerationStageError exposes only a stable processing stage in its
// message while retaining a cause for errors.Is/errors.As callers.
type AutoModerationStageError struct {
	Stage  string
	Code   string
	Status int
	cause  error
}

func (e AutoModerationStageError) Error() string {
	return "automatic moderation " + e.Stage + " failed"
}

func (e AutoModerationStageError) Unwrap() error { return e.cause }

func NewAutoModerationRuntime(cfg moderation.Config, authority ModerationActorAuthority, sink ModerationActionSink, now func() time.Time) *AutoModerationRuntime {
	if now == nil {
		now = time.Now
	}
	return &AutoModerationRuntime{engine: moderation.New(cfg), authority: authority, sink: sink, now: now, enabled: cfg.Enabled}
}

// UpdateActionDependencies refreshes authenticated service handles while
// preserving the process-local rolling counters for the same configuration.
func (r *AutoModerationRuntime) UpdateActionDependencies(authority ModerationActorAuthority, sink ModerationActionSink) {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.authority = authority
	r.sink = sink
	r.mu.Unlock()
}

// PersistConfig fences event processing while the encrypted CAS and evaluator
// replacement complete. If persistence fails, the active evaluator is kept.
// When this method returns successfully, no event can still finish with the
// previous configuration.
func (r *AutoModerationRuntime) PersistConfig(cfg moderation.Config, persist func() error) error {
	if r == nil || persist == nil {
		return errors.New("missing automatic moderation config update dependency")
	}
	r.configMu.Lock()
	defer r.configMu.Unlock()
	if r.engine == nil {
		return errors.New("missing automatic moderation runtime")
	}
	if err := persist(); err != nil {
		return err
	}
	r.engine = moderation.New(cfg)
	r.enabled = cfg.Enabled
	return nil
}

// Handle evaluates one decrypted message. replay must be derived from the
// durable event cursor/recovery path, never from message contents.
func (r *AutoModerationRuntime) Handle(ctx context.Context, event native.GroupEvent, replay bool, mentionIDs []string) (moderation.Decision, error) {
	if r == nil {
		return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, errors.New("missing moderation runtime")
	}
	if event.DeliveryID == 0 || event.Community.IsZero() || event.Group.IsZero() || event.Channel.IsZero() || event.Message.IsZero() ||
		event.SourceSequence == 0 || event.SenderUser.IsZero() || event.SenderDevice.IsZero() ||
		event.SenderKind > 1 || event.SenderTier > 1 || event.EnvelopeType > 1 || event.Body == nil || event.ReceivedAt == 0 || event.ReceivedAt > math.MaxInt64 {
		return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, nil
	}
	r.configMu.RLock()
	defer r.configMu.RUnlock()
	engine, enabled := r.engine, r.enabled
	if engine == nil {
		return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, errors.New("missing moderation runtime")
	}
	r.mu.RLock()
	authority, sink := r.authority, r.sink
	r.mu.RUnlock()
	var owner, admin bool
	if enabled {
		if authority == nil {
			return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, AutoModerationStageError{Stage: "actor_authorization"}
		}
		if sink == nil {
			return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, AutoModerationStageError{Stage: "case_sink"}
		}
		var err error
		owner, admin, err = authority.ModerationActorRoles(ctx, event)
		if err != nil {
			return moderation.Decision{Action: moderation.ActionLog, Ignored: true}, AutoModerationStageError{Stage: "actor_authorization"}
		}
	}
	// Native group events carry Unix seconds, while this runtime uses Go time
	// values and the replay fence is stored in milliseconds.
	receivedAt := time.Unix(int64(event.ReceivedAt), 0)
	now := r.now()
	input := moderation.Input{
		CommunityID: event.Community.String(), SourceID: event.Message.String(), Revision: event.SourceSequence,
		UserID: event.SenderUser.String(), Bot: event.SenderKind == 1, Owner: owner, Admin: admin, Edit: event.EnvelopeType == 1, ReceivedAt: receivedAt,
		Body: *event.Body, MentionIDs: append([]string(nil), mentionIDs...), Replay: replay,
	}
	evaluationTime := now
	// The evaluator deliberately rejects stale live messages. Historical replay
	// still rebuilds its rolling state, while Input.Replay suppresses punishment.
	if replay && (receivedAt.After(now) || now.Sub(receivedAt) > moderation.DuplicateWindow) {
		evaluationTime = receivedAt
	}
	decision := engine.Evaluate(input, evaluationTime)
	if replay || decision.Ignored || decision.DuplicateDelivery || len(decision.Rules) == 0 || sink == nil {
		return decision, nil
	}
	action := ModerationAction{Community: event.Community.String(), Channel: event.Channel.String(),
		Group: event.Group.String(), Actor: event.SenderUser.String(), Message: event.Message.String(), SourceRevision: event.SourceSequence, Decision: decision,
		Excerpt: moderation.Excerpt(*event.Body), ReceivedAt: receivedAt, runtimeGenerated: true}
	if err := sink.ApplyModerationAction(ctx, action); err != nil {
		if errors.Is(err, ErrModerationActionRefused) {
			// A definitive authorization refusal proves no action was accepted.
			// Consume the event as log-only so this shared journal cursor can move;
			// unknown and transient errors remain retryable below.
			decision.EnforcementRefused = true
			decision.Action = moderation.ActionLog
			return decision, nil
		}
		var stageErr AutoModerationStageError
		if errors.As(err, &stageErr) {
			return decision, stageErr
		}
		return decision, AutoModerationStageError{Stage: "case_sink"}
	}
	return decision, nil
}
