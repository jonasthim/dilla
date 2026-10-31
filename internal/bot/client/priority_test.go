package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"
)

func TestInteractiveRequestIsNotQueuedBehindSweep(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99), HTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			status, body := http.StatusOK, "\x80"
			if strings.HasSuffix(r.URL.Path, "/cursor") {
				status, body = http.StatusNoContent, ""
			}
			return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/cbor"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		})}})
		if err != nil {
			t.Fatal(err)
		}
		c.discovered.Store(true)
		var sweep sync.WaitGroup
		sweep.Add(120)
		sweepStart := time.Now()
		// Queue a sweep's reads concurrently to expose reservations ahead of a fresh command.
		for range 120 {
			go func() {
				defer sweep.Done()
				if err := c.waitRate(t.Context(), "bot", "GET", "groups/x/info"); err != nil {
					t.Error(err)
				}
			}()
		}
		synctest.Wait()
		defer sweep.Wait()
		start := time.Now()
		ctx, cancel := context.WithCancel(WithInteractive(t.Context()))
		defer cancel()
		session, err := c.SessionForDevice("bot", testID(1))
		if err != nil {
			t.Fatal(err)
		}
		for _, step := range [][2]string{{"GET", "groups/x/messages"}, {"POST", "groups/x/message"}, {"POST", "groups/x/cursor"}} {
			if _, _, err := session.do(ctx, step[0], strings.ReplaceAll(step[1], "/x/", "/"+testID(2).String()+"/"), nil, nil, MaxSmallBody, step[0] == "POST"); err != nil {
				t.Fatalf("%v: %v", step, err)
			}
		}
		if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
			t.Errorf("interactive command waited %s behind sweep", elapsed)
		}
		sweep.Wait()
		if elapsed := time.Since(sweepStart); elapsed < 10125*time.Millisecond {
			t.Fatalf("shared read rate exceeded: %s", elapsed)
		}
	})
}

func TestPriorityTrafficRespectsSharedClassRate(t *testing.T) {
	for _, interactive := range []bool{false, true} {
		t.Run(map[bool]string{false: "background", true: "interactive"}[interactive], func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99)})
				if err != nil {
					t.Fatal(err)
				}
				ctx := t.Context()
				if interactive {
					ctx = WithInteractive(ctx)
				}
				start := time.Now()
				for range 120 {
					if err := c.waitRate(ctx, "bot", "GET", "groups/x/info"); err != nil {
						t.Fatal(err)
					}
				}
				if elapsed := time.Since(start); elapsed < 10*time.Second {
					t.Fatalf("120 reads exceeded class bucket: %s", elapsed)
				}
			})
		})
	}
}

func TestBackgroundSweepYieldsToPendingInteraction(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99)})
		if err != nil {
			t.Fatal(err)
		}
		pending := false
		ctx := WithBackgroundYield(t.Context(), func() bool { return pending })
		start := time.Now()
		completed := 0
		for range 120 {
			if completed == 40 {
				pending = true
			}
			if err := c.waitRate(ctx, "bot", "GET", "groups/x/info"); err != nil {
				if !IsDeferred(err) {
					t.Fatal(err)
				}
				break
			}
			completed++
		}
		if completed != 40 || time.Since(start) != 0 {
			t.Fatalf("sweep did not yield between reads: completed=%d elapsed=%s", completed, time.Since(start))
		}
		if err := c.waitRate(WithInteractive(ctx), "bot", "GET", "groups/x/messages"); err != nil {
			t.Fatal(err)
		}
		if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
			t.Fatalf("fresh command took %s", elapsed)
		}
		pending = false
		for completed < 120 {
			if err := c.waitRate(ctx, "bot", "GET", "groups/x/info"); err != nil {
				t.Fatal(err)
			}
			completed++
		}
		if elapsed := time.Since(start); elapsed < 10125*time.Millisecond {
			t.Fatalf("resumed sweep bypassed class limit: %s", elapsed)
		}
	})
}

func TestBackgroundWaitYieldsWhileBucketIsEmpty(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99)})
		if err != nil {
			t.Fatal(err)
		}
		pending := make(chan struct{})
		ctx := WithBackgroundYield(t.Context(), func() bool { return len(pending) != 0 })
		for range 10 {
			if err := c.waitRate(ctx, "bot", "POST", "groups/x/message"); err != nil {
				t.Fatal(err)
			}
		}
		pending = make(chan struct{}, 1)
		go func() { time.Sleep(50 * time.Millisecond); pending <- struct{}{} }()
		start := time.Now()
		if err := c.waitRate(ctx, "bot", "POST", "groups/x/message"); !IsDeferred(err) {
			t.Fatalf("background did not defer: %v", err)
		}
		if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
			t.Fatalf("background token wait delayed gateway: %s", elapsed)
		}
	})
}

func TestYieldWhileWaitingIsNeitherRateLimitNorDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		limiter := newPriorityLimiter(1, 1)
		if err := waitLimiter(t.Context(), limiter); err != nil {
			t.Fatal(err)
		}
		pending := make(chan struct{})
		ctx := WithBackgroundYield(t.Context(), func() bool {
			select {
			case <-pending:
				return true
			default:
				return false
			}
		})
		go func() { time.Sleep(50 * time.Millisecond); close(pending) }()
		err := waitLimiter(ctx, limiter)
		if !errors.Is(err, ErrBackgroundYield) || RateLimitError(err) != nil || errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("yield misclassified: %v", err)
		}
	})
}

func TestKeyPackageYieldDoesNotSpendTargetToken(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99)})
		if err != nil {
			t.Fatal(err)
		}
		for range 40 {
			if err := c.waitRate(t.Context(), "bot", "GET", "groups/x/info"); err != nil {
				t.Fatal(err)
			}
		}
		pending := make(chan struct{})
		ctx := WithBackgroundYield(t.Context(), func() bool {
			select {
			case <-pending:
				return true
			default:
				return false
			}
		})
		go func() { time.Sleep(50 * time.Millisecond); close(pending) }()
		if err := c.waitRate(ctx, "bot", "GET", "devices/x/keypackage"); err == nil {
			t.Fatal("request did not yield")
		}
		if tokens := c.buckets[tokenKey("bot")].keypackages["x"].Tokens(); tokens != 8 {
			t.Fatalf("read-bucket yield spent target token: %v", tokens)
		}
	})
}

func TestStoredContextClearsSchedulingAndPreservesLifetime(t *testing.T) {
	c, err := New(Config{BaseURL: "https://example.invalid", InstanceID: testID(99)})
	if err != nil {
		t.Fatal(err)
	}
	type lifetimeKey struct{}
	original, cancel := context.WithTimeout(context.WithValue(t.Context(), lifetimeKey{}, "owned"), time.Second)
	defer cancel()
	request := WithInteractive(WithBackgroundYield(original, func() bool { return true }))
	stored := WithoutBackgroundYield(request)
	if err := c.waitRate(stored, "bot", "GET", "groups/x/info"); err != nil {
		t.Fatalf("stored context inherited yield: %v", err)
	}
	if err := c.waitRate(WithBackgroundYield(stored, func() bool { return true }), "bot", "GET", "groups/x/info"); !errors.Is(err, ErrBackgroundYield) {
		t.Fatalf("stored context retained interactive priority: %v", err)
	}
	wantDeadline, _ := original.Deadline()
	deadline, _ := stored.Deadline()
	if deadline != wantDeadline || stored.Value(lifetimeKey{}) != "owned" {
		t.Fatal("normalization discarded lifetime metadata")
	}
	cancel()
	if !errors.Is(stored.Err(), context.Canceled) {
		t.Fatal("normalization discarded cancellation")
	}
}

func TestYieldDeferralDoesNotHidePermanentFailure(t *testing.T) {
	if !IsDeferred(ErrBackgroundYield) || RateLimitError(ErrBackgroundYield) != nil || IsDeferred(errors.Join(ErrBackgroundYield, errors.New("durable write failed"))) {
		t.Fatal("yield deferral classification lost its boundary")
	}
}
