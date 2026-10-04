package api_test

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
)

type fakeCallMetrics struct {
	mu      sync.Mutex
	reports int
	relayed int
	rtts    []uint32
	failed  uint64
}

func (m *fakeCallMetrics) StatsReport(relay bool, rttMs uint32, decryptFailures uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reports++
	if relay {
		m.relayed++
	}
	m.rtts = append(m.rtts, rttMs)
	m.failed += decryptFailures
}

// statsEnv is an open call with the owner's device a leaf and the stats route mounted.
func statsEnv(t *testing.T) (*env, string, string, id.ID, *api.CallStats, *fakeCallMetrics) {
	t.Helper()
	e, ch, tok, group, _, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	callID := decodeCall(t, body).CallID
	m := &fakeCallMetrics{}
	stats := api.NewCallStats(e.Repo, calls, m, e.Clk)
	stats.Register(e.Mux)
	return e, tok, "/v1/calls/" + callID.String() + "/stats", group, stats, m
}

func report(candidate uint64, relayProto any, rtt, lost, failed, encrypted uint64) []any {
	return []any{candidate, relayProto, rtt, lost, failed, encrypted}
}

// DEV-59 / F10: one report per device per 5 s, into the metrics and the in-memory window.
func TestAStatsReportIsAcceptedOncePerFiveSeconds(t *testing.T) {
	e, tok, path, _, stats, m := statsEnv(t)
	if status, body := e.Do(http.MethodPost, path, tok, report(3, uint64(2), 80, 12, 4, 1500)); status != http.StatusNoContent {
		t.Fatalf("a stats report = %d %s", status, e.ErrCode(body))
	}
	status, body := e.Do(http.MethodPost, path, tok, report(3, uint64(2), 90, 0, 0, 1500))
	if status != http.StatusTooManyRequests || e.ErrCode(body) != "E_RATE_LIMITED" {
		t.Fatalf("a second report at once = %d %s, want 429 E_RATE_LIMITED", status, e.ErrCode(body))
	}
	var refusal []any
	mustUnmarshalBody(t, body, &refusal)
	if len(refusal) < 3 || refusal[2] != uint64(5000) {
		t.Fatalf("the refusal = %v, want retry_after_ms 5000", refusal)
	}
	e.Clk.Advance(5 * time.Second)
	if status, _ := e.Do(http.MethodPost, path, tok, report(3, uint64(2), 80, 0, 4, 1500)); status != http.StatusNoContent {
		t.Fatalf("a report 5 s later = %d", status)
	}
	m.mu.Lock()
	if m.reports != 2 || m.relayed != 2 || m.failed != 8 {
		t.Errorf("metrics saw %d reports, %d relayed, %d failures; want 2, 2, 8", m.reports, m.relayed, m.failed)
	}
	m.mu.Unlock()
	s := stats.Summary(15 * time.Minute)
	if s.LiveCalls != 1 || s.Reports != 2 || s.RelayReports != 2 || s.DecryptFailures != 8 || s.P50RTTms != 80 {
		t.Fatalf("summary = %+v", s)
	}
	e.Clk.Advance(16 * time.Minute)
	if s := stats.Summary(15 * time.Minute); s.Reports != 0 || s.LiveCalls != 0 {
		t.Fatalf("a summary after the window = %+v, want nothing", s)
	}
}

// The report is range-checked, kept to a current leaf of a live call, and 404 for anything else.
func TestAStatsReportIsCheckedAndGated(t *testing.T) {
	e, tok, path, _, _, _ := statsEnv(t)
	for name, body := range map[string][]any{
		"candidate_type 4":             report(4, nil, 10, 0, 0, 0),
		"relay_protocol without relay": report(0, uint64(1), 10, 0, 0, 0),
		"relay_protocol 3":             report(3, uint64(3), 10, 0, 0, 0),
		"rtt_ms 60001":                 report(1, nil, 60_001, 0, 0, 0),
		"fraction_lost_permille 1001":  report(1, nil, 10, 1001, 0, 0),
		"five elements":                {uint64(1), nil, uint64(10), uint64(0), uint64(0)},
	} {
		if status, resp := e.Do(http.MethodPost, path, tok, body); status != http.StatusBadRequest || e.ErrCode(resp) != "E_INVALID_REQUEST" {
			t.Errorf("%s = %d %s, want 400 E_INVALID_REQUEST", name, status, e.ErrCode(resp))
		}
	}
	user := userOf(t, e, tok)
	other := seedDevices(t, e, user, 1)[0]
	e.sess["other"] = auth.Session{UserID: user, DeviceID: other, Scope: auth.ScopeEnrolled}
	if status, resp := e.Do(http.MethodPost, path, "other", report(0, nil, 10, 0, 0, 0)); status != http.StatusForbidden || e.ErrCode(resp) != "E_LEAF_NOT_CURRENT" {
		t.Errorf("a report from a device that is no leaf = %d %s, want 403 E_LEAF_NOT_CURRENT", status, e.ErrCode(resp))
	}
	if status, _ := e.Do(http.MethodPost, "/v1/calls/"+id.New().String()+"/stats", tok, report(0, nil, 10, 0, 0, 0)); status != http.StatusNotFound {
		t.Errorf("a report for an unknown call = %d, want 404", status)
	}
	// Task 10's rule for every call path: a revoked or quarantined device takes part in no call,
	// even while its leaf is still in the call group's epoch.
	if err := e.Repo.RevokeDevice(t.Context(), deviceOf(t, e, tok), e.Clk.Now().Unix()); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	if status, resp := e.Do(http.MethodPost, path, tok, report(0, nil, 10, 0, 0, 0)); status != http.StatusForbidden || e.ErrCode(resp) != "E_FORBIDDEN" {
		t.Errorf("a report from a revoked device = %d %s, want 403 E_FORBIDDEN", status, e.ErrCode(resp))
	}
}

// Summary's percentiles are over the devices' latest round-trip times.
func TestTheSummaryPercentilesAreOverTheDevices(t *testing.T) {
	e, tok, path, group, stats, _ := statsEnv(t)
	user := userOf(t, e, tok)
	devs := seedDevices(t, e, user, 2)
	if status, _ := e.Do(http.MethodPost, path, tok, report(0, nil, 10, 0, 0, 0)); status != http.StatusNoContent {
		t.Fatalf("owner report = %d", status)
	}
	for i, rtt := range []uint64{50, 200} {
		name := []string{"a", "b"}[i]
		e.sess[name] = auth.Session{UserID: user, DeviceID: devs[i], Scope: auth.ScopeEnrolled}
		seedLeaf(t, e, group, devs[i], 3, nil)
		if status, _ := e.Do(http.MethodPost, path, name, report(1, nil, rtt, 0, 0, 0)); status != http.StatusNoContent {
			t.Fatalf("device %s report = %d", name, status)
		}
	}
	if s := stats.Summary(15 * time.Minute); s.Reports != 3 || s.P50RTTms != 50 || s.P95RTTms != 200 || s.RelayReports != 0 {
		t.Fatalf("summary = %+v, want 3 reports, p50 50, p95 200, none relayed", s)
	}
}
