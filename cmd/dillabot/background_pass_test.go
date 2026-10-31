//go:build linux

package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

func backgroundAPI(t *testing.T) *client.Client {
	t.Helper()
	instance := id.New()
	document, err := cborx.Marshal([]any{[]any{uint64(3)}, []any{uint64(1)}, []any{uint64(1)}, instance, uint64(1), "probe", uint64(0), []any{uint64(0)}, uint64(1), id.New(), make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	api, err := client.New(client.Config{BaseURL: "https://example.invalid", InstanceID: instance,
		RateLimits: client.RateLimits{ReadPerSecond: 1e6, ReadBurst: 1000000},
		HTTPClient: &http.Client{Transport: spotifyCatalogRoundTripper(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/cbor"}}, Body: io.NopCloser(bytes.NewReader(document)), Request: r}, nil
		})}})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func backgroundProbe(t *testing.T) func(context.Context) error {
	t.Helper()
	api := backgroundAPI(t)
	return func(ctx context.Context) error { _, err := api.Discover(ctx); return err }
}

func TestEveryInstallationReconcilesWithinTwoPasses(t *testing.T) {
	now := time.Now()
	progress := backgroundProgress{lastComplete: now}
	installations := []client.Installation{{ID: id.New()}, {ID: id.New()}, {ID: id.New()}, {ID: id.New()}}
	completed := make(map[id.ID]bool)
	probe := backgroundProbe(t)
	for range 2 {
		pass := progress.start(now)
		if pass.retry && pass.order(installations)[0].ID != progress.resume {
			t.Fatal("interrupted installation was not resumed first")
		}
		for _, installation := range pass.order(installations) {
			stage := "membership"
			ctx := pass.context(t.Context(), installation.ID, &stage, func() bool { return installation.ID != installations[0].ID })
			// Admit an actual HTTP request using the production scheduling context.
			err := probe(ctx)
			if errors.Is(err, client.ErrBackgroundYield) {
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			completed[installation.ID] = true
		}
		var err error
		if pass.yielded {
			err = client.ErrBackgroundYield
		}
		progress.finish(pass, now, err)
	}
	if len(completed) != len(installations) {
		t.Fatalf("only %d of %d installations completed in two passes", len(completed), len(installations))
	}
}

func TestBackgroundProgressFloorUsesLastCompletePass(t *testing.T) {
	start := time.Now()
	progress := backgroundProgress{lastComplete: start}
	stage := "identity"
	probe := backgroundProbe(t)
	for _, elapsed := range []time.Duration{time.Second, 30 * time.Second, 61 * time.Second} {
		pass := progress.start(start.Add(elapsed))
		ctx := pass.context(t.Context(), id.New(), &stage, func() bool { return true })
		err := probe(ctx)
		if elapsed < 60*time.Second {
			if !errors.Is(err, client.ErrBackgroundYield) {
				t.Fatalf("normal pass did not yield: %v", err)
			}
			progress.finish(pass, start.Add(elapsed), err)
		} else {
			if err != nil {
				t.Fatalf("progress-floor pass still yielded: %v", err)
			}
			progress.finish(pass, start.Add(elapsed), nil)
		}
	}
	if progress.lastComplete != start.Add(61*time.Second) {
		t.Fatal("yielded pass reset the progress floor")
	}
}

func TestMaintenanceRunsWithCommandsEveryFiveSeconds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		now := time.Now()
		progress := backgroundProgress{lastComplete: now}
		installation := id.New()
		var announcements, utilities []time.Time
		var pending bool
		// These are the same two tasks bound to scheduler.RunDue and utilities.maintain
		// in reconcile. Each performs real admission; a leaked yield fails the pass.
		probe := backgroundProbe(t)
		task := func(times *[]time.Time) func(context.Context) error {
			return func(ctx context.Context) error {
				if err := probe(ctx); err != nil {
					return err
				}
				*times = append(*times, time.Now())
				return nil
			}
		}
		r := newBotGatewayRuntime(t.Context(), nil, false, nil)
		r.maintenance = map[id.ID]backgroundMaintenance{installation: {run: func(ctx context.Context) error {
			return runBackgroundMaintenance(ctx, task(&announcements), task(&utilities))
		}}}
		for elapsed := time.Duration(0); elapsed <= 125*time.Second; elapsed += 5 * time.Second {
			pending = true // a new command on every iteration, including the initial burst
			pass := progress.start(time.Now())
			stage := "membership"
			ctx := pass.context(t.Context(), installation, &stage, func() bool { return pending })
			done := make(map[id.ID]bool)
			if err := r.maintain(ctx, done); err != nil {
				t.Fatalf("maintenance yielded: %v", err)
			}
			// A newly rebound helper in this pass must not run the task twice.
			if err := r.maintainOne(ctx, installation, done); err != nil {
				t.Fatal(err)
			}
			passErr := probe(ctx)
			progress.finish(pass, time.Now(), passErr)
			pending = false
			time.Sleep(5 * time.Second)
		}
		for _, times := range [][]time.Time{announcements, utilities} {
			if len(times) != 26 {
				t.Fatalf("maintenance did not run each pass: %d runs", len(times))
			}
			last := now
			for _, at := range times {
				if at.Sub(last) > 60*time.Second {
					t.Fatalf("maintenance gap %s", at.Sub(last))
				}
				last = at
			}
		}
	})
}

func TestYieldedPassLogsOnceWithStage(t *testing.T) {
	var logs bytes.Buffer
	pass := &backgroundPass{yielded: true, installation: id.New(), stage: "membership_source_sync"}
	reportBackgroundPass(slog.New(slog.NewJSONHandler(&logs, nil)), pass, client.ErrBackgroundYield)
	text := logs.String()
	if strings.Count(text, "\n") != 1 || !strings.Contains(text, "bot background pass yielded to a command") || !strings.Contains(text, `"stage":"membership_source_sync"`) || strings.Contains(text, "healthy") || strings.Contains(text, "rate limited") {
		t.Fatalf("incorrect yield log: %s", text)
	}
}

func TestBackgroundYieldReadyRacesWithPollerUpdates(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, false, nil)
	installation, group := id.New(), id.New()
	r.notifyInteraction(installation, group)
	var readers sync.WaitGroup
	readers.Add(1)
	go func() {
		defer readers.Done()
		for range 2000 {
			r.backgroundYieldReady(time.Now(), id.ID{})
		}
	}()
	for range 1000 {
		r.SetInteractionPoller(installation, func(context.Context, id.ID) error { return nil })
		r.RetainOnly(nil)
		r.notifyInteraction(installation, group)
	}
	readers.Wait()
	r.RetainOnly(nil)
}

func TestInterruptedAdmissionKeepsYieldingUntilNextPass(t *testing.T) {
	now := time.Now()
	progress := backgroundProgress{lastComplete: now}
	installation := id.New()
	stage := "membership"
	probe := backgroundProbe(t)
	pass := progress.start(now)
	ctx := pass.context(t.Context(), installation, &stage, func() bool { return true })
	for range 2 {
		if err := probe(ctx); !errors.Is(err, client.ErrBackgroundYield) {
			t.Fatalf("caught yield resumed background work: %v", err)
		}
	}
	progress.finish(pass, now, client.ErrBackgroundYield)
	next := progress.start(now)
	if err := probe(next.context(t.Context(), installation, &stage, func() bool { return true })); err != nil {
		t.Fatalf("resumed installation yielded: %v", err)
	}
}

func TestDiscoveryYieldStillRunsRetainedMaintenance(t *testing.T) {
	api := backgroundAPI(t)
	if _, err := api.Discover(t.Context()); err != nil {
		t.Fatal(err)
	}
	runtime, err := api.Runtime("runtime-credential")
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := newBotGatewayRuntime(t.Context(), api, false, logger)
	installation := id.New()
	r.SetInteractionPoller(installation, func(context.Context, id.ID) error { return nil })
	r.notifyInteraction(installation, id.New())
	runs := 0
	task := func(ctx context.Context) error {
		if _, err := api.Discover(ctx); err != nil {
			return err
		}
		runs++
		return nil
	}
	r.maintenance = map[id.ID]backgroundMaintenance{installation: {run: func(ctx context.Context) error { return runBackgroundMaintenance(ctx, task, task) }}}
	progress := backgroundProgress{lastComplete: time.Now()}
	pass := progress.start(time.Now())
	err = reconcile(t.Context(), config{StateDir: t.TempDir()}, api, runtime, nil, nil, nil, nil, r, nil, logger, pass)
	if !errors.Is(err, client.ErrBackgroundYield) || runs != 2 {
		t.Fatalf("discovery yield skipped RunDue/maintain: runs=%d err=%v", runs, err)
	}
}

func TestDiscoveryOnlyYieldPreservesInterruptedInstallation(t *testing.T) {
	now := time.Now()
	progress := backgroundProgress{lastComplete: now}
	installation := id.New()
	stage := "membership"
	probe := backgroundProbe(t)
	pass := progress.start(now)
	if err := probe(pass.context(t.Context(), installation, &stage, func() bool { return true })); !errors.Is(err, client.ErrBackgroundYield) {
		t.Fatal(err)
	}
	progress.finish(pass, now, client.ErrBackgroundYield)
	discovery := progress.start(now)
	if err := probe(discovery.context(t.Context(), id.ID{}, &stage, func() bool { return true })); !errors.Is(err, client.ErrBackgroundYield) {
		t.Fatal(err)
	}
	progress.finish(discovery, now, client.ErrBackgroundYield)
	resumed := progress.start(now)
	if err := probe(resumed.context(t.Context(), installation, &stage, func() bool { return true })); err != nil {
		t.Fatalf("discovery discarded protected work: %v", err)
	}
}

func TestFirstTimeSetupMayYieldToAnotherInstallation(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, false, nil)
	existing := id.New()
	r.SetInteractionPoller(existing, func(context.Context, id.ID) error { return nil })
	r.notifyInteraction(existing, id.New())
	progress := backgroundProgress{lastComplete: time.Now()}
	pass := progress.start(time.Now())
	setup := id.New()
	stage := "identity"
	ctx := pass.context(t.Context(), setup, &stage, func() bool { return r.backgroundYieldReady(time.Now(), id.ID{}) })
	if err := backgroundProbe(t)(ctx); !errors.Is(err, client.ErrBackgroundYield) {
		t.Fatalf("another ready installation did not interrupt first setup: %v", err)
	}
}

func TestStaleMaintenanceDoesNotSkipRecoveredRuntime(t *testing.T) {
	r := newBotGatewayRuntime(t.Context(), nil, false, nil)
	installation := id.New()
	probe := backgroundProbe(t)
	live := false
	runs := 0
	task := func(ctx context.Context) error {
		if err := probe(ctx); err != nil {
			return err
		}
		runs++
		return nil
	}
	r.maintenance = map[id.ID]backgroundMaintenance{installation: {current: func() bool { return live }, run: func(ctx context.Context) error { return runBackgroundMaintenance(ctx, task, task) }}}
	done := make(map[id.ID]bool)
	if err := r.maintainOne(t.Context(), installation, done); err != nil {
		t.Fatal(err)
	}
	live = true
	r.maintenance[installation] = backgroundMaintenance{run: func(ctx context.Context) error { return runBackgroundMaintenance(ctx, task, task) }}
	if err := r.maintainOne(t.Context(), installation, done); err != nil {
		t.Fatal(err)
	}
	if runs != 2 {
		t.Fatalf("recovered helper skipped RunDue/maintain: %d runs", runs)
	}
}
