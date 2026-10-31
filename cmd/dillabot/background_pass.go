//go:build linux

package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
)

const backgroundProgressFloor = 60 * time.Second

type backgroundProgress struct {
	lastNonYielded time.Time
	interval       time.Duration
	resume         id.ID
	retry          bool
	protected      map[id.ID]bool
}

type backgroundPass struct {
	protected    map[id.ID]bool
	visited      map[id.ID]bool
	incomplete   bool
	interrupted  map[id.ID]bool
	forced       bool
	resume       id.ID
	retry        bool
	yielded      bool
	installation id.ID
	stage        string
}

func (p *backgroundProgress) start(now time.Time) *backgroundPass {
	return &backgroundPass{forced: now.Sub(p.lastNonYielded) >= p.interval+backgroundProgressFloor, resume: p.resume, retry: p.retry, protected: p.protected, interrupted: make(map[id.ID]bool), visited: make(map[id.ID]bool)}
}

func (p *backgroundProgress) finish(pass *backgroundPass, now time.Time, _ error) {
	next := make(map[id.ID]bool)
	for installation := range pass.interrupted {
		next[installation] = true
	}
	for installation := range p.protected {
		if !pass.visited[installation] {
			next[installation] = true
		}
	}
	p.protected = next
	p.retry = len(next) > 0
	if pass.yielded {
		p.resume = pass.installation
	}
	// Errors do not indicate starvation by commands; any non-yielded pass
	// resets the progress floor, even when its work failed or was deferred.
	if !pass.yielded {
		p.lastNonYielded = now
	}
}

// Interrupted installations are protected on their next turn. Rotate the first
// interrupted installation to the front, so every installation gets an
// uninterrupted turn within two passes even under sustained command traffic.
func (p *backgroundPass) order(installations []client.Installation) []client.Installation {
	present := make(map[id.ID]bool, len(installations))
	for _, installation := range installations {
		if installation.State < 4 {
			present[installation.ID] = true
		}
	}
	for installation := range p.protected {
		if !installation.IsZero() && !present[installation] {
			p.visited[installation] = true
		}
	}

	if p.retry {
		for i, installation := range installations {
			if installation.ID == p.resume {
				ordered := append([]client.Installation(nil), installations[i:]...)
				return append(ordered, installations[:i]...)
			}
		}
	}
	return installations
}

func (p *backgroundPass) context(ctx context.Context, installation id.ID, stage *string, ready func() bool) context.Context {
	p.visited[installation] = true
	ctx = client.WithoutBackgroundYield(ctx)
	return client.WithBackgroundYield(ctx, func() bool {
		if p.interrupted[installation] {
			return true
		}
		if p.forced || p.protected[installation] || !ready() {
			return false
		}
		p.interrupted[installation] = true
		if !p.yielded {
			p.yielded, p.installation, p.stage = true, installation, *stage
		}
		return true
	})
}

func reportBackgroundPass(logger *slog.Logger, pass *backgroundPass, err error) {
	if pass.yielded {
		logger.Info("bot background pass yielded to a command", "stage", pass.stage, "installation_id", pass.installation.String())
		if err != nil && !client.IsDeferred(err) {
			logger.Error("bot identity reconciliation degraded", "error", err.Error())
		}
	} else if err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("bot identity reconciliation degraded", "error", err.Error())
	} else if err == nil {
		logger.Info("bot identity reconciliation healthy")
	}
}

// Maintenance owns background work independently of sweep admission. Functions
// are stored, never their request contexts, and receive a non-yielding context.
func runBackgroundMaintenance(ctx context.Context, tasks ...func(context.Context) error) error {
	ctx = client.WithoutBackgroundYield(ctx)
	var result error
	for _, task := range tasks {
		if task != nil {
			result = errors.Join(result, task(ctx))
		}
	}
	return result
}

type backgroundMaintenance struct {
	current func() bool
	run     func(context.Context) error
}

// installationMaintenanceError keeps the installation visible in both logs
// and error trees while preserving the original retry/refusal classification.
type installationMaintenanceError struct {
	installation id.ID
	cause        error
}

func (e *installationMaintenanceError) Error() string {
	return "bot maintenance failed for installation " + e.installation.String() + ": " + e.cause.Error()
}
func (e *installationMaintenanceError) Unwrap() error { return e.cause }

func (r *botGatewayRuntime) maintainOne(ctx context.Context, installation id.ID, done map[id.ID]bool) error {
	r.mu.Lock()
	task, exists := r.maintenance[installation]
	r.mu.Unlock()
	if done[installation] || !exists {
		return nil
	}
	if task.current != nil && !task.current() {
		r.SetMaintenance(installation, backgroundMaintenance{})
		return nil
	}
	done[installation] = true
	if err := runBackgroundMaintenance(ctx, task.run); err != nil {
		return &installationMaintenanceError{installation: installation, cause: err}
	}
	return nil
}

func (r *botGatewayRuntime) maintain(ctx context.Context, done map[id.ID]bool) error {
	var result error
	r.mu.Lock()
	installations := make([]id.ID, 0, len(r.maintenance))
	for installation := range r.maintenance {
		installations = append(installations, installation)
	}
	r.mu.Unlock()
	for _, installation := range installations {
		result = errors.Join(result, r.maintainOne(ctx, installation, done))
	}
	return result
}

// SetMaintenance publishes immutable task closures without retaining a request context.
func (r *botGatewayRuntime) SetMaintenance(installation id.ID, task backgroundMaintenance) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if task.run == nil {
		delete(r.maintenance, installation)
		return
	}
	if r.maintenance == nil {
		r.maintenance = make(map[id.ID]backgroundMaintenance)
	}
	r.maintenance[installation] = task
}
