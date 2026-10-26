package client

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Proof refreshes can exceed the shared session write burst when an installation
// has many private groups. Only retry an explicit, definitive rate-limit refusal:
// the middleware has not executed the handler. Preserve the exact request binding
// and never retry an ambiguous outcome or an authorization refusal.
func (s *Session) interactionProofRequest(ctx context.Context, path string, request []byte, maxBytes int64, mutation bool) ([]byte, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, s.c.timeout)
	defer cancel()
	for attempt := 0; ; attempt++ {
		raw, _, err := s.c.do(ctx, s.token, http.MethodPost, path, nil, request, maxBytes, mutation)
		var refusal *APIError
		if attempt >= 3 || !errors.As(err, &refusal) || refusal.Status != http.StatusTooManyRequests ||
			refusal.Code != "E_RATE_LIMITED" || refusal.Outcome != OutcomeDefinitive || refusal.RetryAfterMS == nil || *refusal.RetryAfterMS > 5000 {
			return raw, err
		}
		wait := time.Duration(*refusal.RetryAfterMS) * time.Millisecond
		if wait < 100*time.Millisecond {
			wait = 100 * time.Millisecond
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
