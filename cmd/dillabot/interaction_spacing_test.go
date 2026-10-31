//go:build linux

package main

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/id"
)

func TestInteractionSpacingIsPerInstallation(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	first, second, group := id.New(), id.New(), id.New()
	calls := make(map[id.ID]int)
	for _, installation := range []id.ID{first, second} {
		r.SetInteractionPoller(installation, func(context.Context, id.ID) error { calls[installation]++; return nil })
	}
	now := time.Now()
	r.notifyInteraction(first, group)
	r.PollInteractions(t.Context(), now)
	r.notifyInteraction(first, group)
	r.notifyInteraction(second, group)
	r.PollInteractions(t.Context(), now)
	if calls[first] != 1 || calls[second] != 1 {
		t.Fatalf("calls = %v; first community must stay spaced while second runs immediately", calls)
	}
	r.PollInteractions(t.Context(), now.Add(interactionSpacing))
	if calls[first] != 2 {
		t.Fatal("first community did not run after its own spacing")
	}
}

func TestCommandWorkerSpacingIsPerInstallation(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	first, second, group := id.New(), id.New(), id.New()
	pool := &commandWorkers{ctx: t.Context(), active: make(map[id.ID]context.CancelFunc), background: make(map[id.ID]bool), retry: make(map[interactionWork]time.Time)}
	for _, installation := range []id.ID{first, second} {
		r.SetInteractionPoller(installation, func(context.Context, id.ID) error { return nil })
	}
	now := time.Now()
	r.notifyInteraction(first, group)
	jobs, _, _ := r.commandBatch(pool, now)
	if len(jobs) != 1 {
		t.Fatal("first turn was not admitted")
	}
	jobs[0].cancel()
	delete(pool.active, first)
	r.notifyInteraction(first, group)
	r.notifyInteraction(second, group)
	jobs, delay, pending := r.commandBatch(pool, now)
	for _, job := range jobs {
		defer job.cancel()
	}
	if len(jobs) != 1 || jobs[0].work.installation != second || !pending || delay != interactionSpacing {
		t.Fatalf("jobs=%d, pending=%v, delay=%s; independent community must run while first remains spaced", len(jobs), pending, delay)
	}
}

func TestInteractionSpacingSurvivesRestartButNotRemoval(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, true, slog.New(slog.NewTextHandler(io.Discard, nil)))
	kept, removed, group := id.New(), id.New(), id.New()
	calls := make(map[id.ID]int)
	register := func(installation id.ID) {
		r.SetInteractionPoller(installation, func(context.Context, id.ID) error { calls[installation]++; return nil })
	}
	for _, installation := range []id.ID{kept, removed} {
		register(installation)
		r.notifyInteraction(installation, group)
	}
	now := time.Now()
	r.PollInteractions(t.Context(), now)
	r.RetainOnly([]id.ID{kept})
	r.Drop(kept)
	for _, installation := range []id.ID{kept, removed} {
		register(installation)
		r.notifyInteraction(installation, group)
	}
	r.PollInteractions(t.Context(), now)
	if calls[kept] != 1 || calls[removed] != 2 {
		t.Fatalf("calls=%v; restart must retain spacing while removed installation starts fresh", calls)
	}
	r.PollInteractions(t.Context(), now.Add(interactionSpacing))
	if calls[kept] != 2 {
		t.Fatal("retained installation did not become eligible after spacing")
	}
}
