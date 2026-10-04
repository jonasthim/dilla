package api

import (
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// CallMetrics is the stats route's metric surface; *obs.Metrics is one.
type CallMetrics interface {
	StatsReport(relay bool, rttMs uint32, decryptFailures uint64)
}

// StatsSummary is what the diagnostics' calls leg reports over a window: the calls and reports seen,
// how many reports had a relay selected, the decrypt failures reported, and the median and 95th
// percentile of the devices' latest round-trip times.
type StatsSummary struct {
	LiveCalls, Reports, RelayReports int
	DecryptFailures                  uint64
	P50RTTms, P95RTTms               uint32
}

// statsReportInterval is the least time between two accepted reports of one device.
const statsReportInterval = 5 * time.Second

// statsKeep bounds what the route holds when nothing asks for a summary: a device whose last report
// is older is dropped by the next report's sweep, at most once per statsSweepEvery. The diagnostics
// read a 15-minute window, well inside it.
const (
	statsKeep       = time.Hour
	statsSweepEvery = time.Minute
)

// The report's ranges (protocol/09 § Voice, Call stats).
const (
	candidateRelay   = 3
	maxCandidateType = 3
	maxRelayProtocol = 2
	maxRTTms         = 60_000
	maxLostPermille  = 1000
)

// statsReport is `[candidate_type, relay_protocol|null, rtt_ms, fraction_lost_permille,
// decrypt_failures, frames_encrypted]`; the last two count since the device's previous report.
type statsReport struct {
	_                    struct{} `cbor:",toarray"`
	CandidateType        uint64
	RelayProtocol        *uint64
	RTTms                uint32
	FractionLostPermille uint64
	DecryptFailures      uint64
	FramesEncrypted      uint64
}

func (q statsReport) validate() error {
	switch {
	case q.CandidateType > maxCandidateType:
		return server.Errorf(server.CodeInvalidRequest, "candidate_type is 0 host, 1 srflx, 2 prflx or 3 relay")
	case q.RelayProtocol != nil && q.CandidateType != candidateRelay:
		return server.Errorf(server.CodeInvalidRequest, "relay_protocol is null unless candidate_type is 3 (relay)")
	case q.RelayProtocol != nil && *q.RelayProtocol > maxRelayProtocol:
		return server.Errorf(server.CodeInvalidRequest, "relay_protocol is 0 udp, 1 tcp or 2 tls")
	case q.RTTms > maxRTTms:
		return server.Errorf(server.CodeInvalidRequest, "rtt_ms is at most 60000")
	case q.FractionLostPermille > maxLostPermille:
		return server.Errorf(server.CodeInvalidRequest, "fraction_lost_permille is at most 1000")
	}
	return nil
}

// deviceStats is one device's reports in one call.
type deviceStats struct {
	at              time.Time
	reports         int
	relayReports    int
	decryptFailures uint64
	rtt             uint32
}

// CallStats is POST /v1/calls/{call_id}/stats (DEV-59, ruling F10): what a device in a call reports
// about its connection, kept in memory only — per call, per device — for the admin diagnostics, and
// counted into label-free series. Nothing is persisted and nothing names a device outside this
// process. The route pushes nothing to the SFU and frees no sharing slot, so it never takes the
// call's lock.
type CallStats struct {
	repo  store.Repository
	calls *Calls
	m     CallMetrics
	clk   clock.Clock

	mu     sync.Mutex
	byCall map[id.ID]map[id.ID]*deviceStats
	last   map[id.ID]time.Time // device → its last accepted report
	swept  time.Time
}

// NewCallStats builds the stats route over the call routes' gates.
func NewCallStats(repo store.Repository, calls *Calls, m CallMetrics, clk clock.Clock) *CallStats {
	return &CallStats{repo: repo, calls: calls, m: m, clk: clk,
		byCall: map[id.ID]map[id.ID]*deviceStats{}, last: map[id.ID]time.Time{}}
}

func (s *CallStats) Register(mux *server.Mux) {
	mux.HandleFunc("POST /v1/calls/{call_id}/stats", s.report)
}

// report is POST /v1/calls/{call_id}/stats: 204, from a current leaf of a live call's group whose
// device may take part in calls, at most one per device per 5 s.
func (s *CallStats) report(w http.ResponseWriter, r *http.Request) {
	sess, row, _, _, err := s.calls.callOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req statsReport
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := req.validate(); err != nil {
		server.WriteError(w, err)
		return
	}
	if row.Ended != nil {
		server.WriteError(w, server.Errorf(server.CodeNotFound, "the call has ended"))
		return
	}
	if err := s.calls.requireLeafOfCall(r.Context(), row, sess.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	if err := s.calls.refuseBarred(r.Context(), s.repo, sess.DeviceID); err != nil {
		server.WriteError(w, err)
		return
	}
	now := s.clk.Now()
	relay := req.CandidateType == candidateRelay
	s.mu.Lock()
	if last, ok := s.last[sess.DeviceID]; ok && now.Sub(last) < statsReportInterval {
		wait := statsReportInterval - now.Sub(last)
		s.mu.Unlock()
		server.WriteError(w, server.RateLimitedAfter(wait))
		return
	}
	if now.Sub(s.swept) >= statsSweepEvery {
		s.dropOlderLocked(now.Add(-statsKeep))
		s.swept = now
	}
	s.last[sess.DeviceID] = now
	devs := s.byCall[row.CallID]
	if devs == nil {
		devs = map[id.ID]*deviceStats{}
		s.byCall[row.CallID] = devs
	}
	d := devs[sess.DeviceID]
	if d == nil {
		d = &deviceStats{}
		devs[sess.DeviceID] = d
	}
	d.at, d.rtt = now, req.RTTms
	d.reports++
	if relay {
		d.relayReports++
	}
	d.decryptFailures += req.DecryptFailures
	s.mu.Unlock()
	if s.m != nil {
		s.m.StatsReport(relay, req.RTTms, req.DecryptFailures)
	}
	w.WriteHeader(http.StatusNoContent)
}

// dropOlderLocked forgets every device whose last report is before cutoff, and every call left with
// none. s.mu is held.
func (s *CallStats) dropOlderLocked(cutoff time.Time) {
	for call, devs := range s.byCall {
		for dev, d := range devs {
			if d.at.Before(cutoff) {
				delete(devs, dev)
			}
		}
		if len(devs) == 0 {
			delete(s.byCall, call)
		}
	}
	for dev, at := range s.last {
		if at.Before(cutoff) {
			delete(s.last, dev)
		}
	}
}

// Summary is the window's view, dropping every device whose last report is older than window.
func (s *CallStats) Summary(window time.Duration) StatsSummary {
	cutoff := s.clk.Now().Add(-window)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dropOlderLocked(cutoff)
	var out StatsSummary
	var rtts []uint32
	for _, devs := range s.byCall {
		for _, d := range devs {
			out.Reports += d.reports
			out.RelayReports += d.relayReports
			out.DecryptFailures += d.decryptFailures
			rtts = append(rtts, d.rtt)
		}
		out.LiveCalls++
	}
	slices.Sort(rtts)
	out.P50RTTms, out.P95RTTms = percentile(rtts, 50), percentile(rtts, 95)
	return out
}

// percentile is the nearest-rank p-th percentile of sorted.
func percentile(sorted []uint32, p int) uint32 {
	if len(sorted) == 0 {
		return 0
	}
	i := (len(sorted)*p+99)/100 - 1
	return sorted[min(max(i, 0), len(sorted)-1)]
}
