package obs

import (
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Metrics is dillad's whole metric surface. No metric carries a group_id,
// channel_id, user_id or device_id label: metric labels are scraped by
// whatever the operator points at /metrics, and membership is not theirs
// (gap-76 §5). A test enforces this by reflection.
type Metrics struct {
	reg  prometheus.Registerer
	gath prometheus.Gatherer

	HTTPRequests         *prometheus.CounterVec
	HTTPDuration         *prometheus.HistogramVec
	GatewayConnections   prometheus.Gauge
	GatewayFrames        *prometheus.CounterVec
	GatewayQueueOverflow prometheus.Counter
	DSCommits            *prometheus.CounterVec
	DSCommitDuration     prometheus.Histogram
	DSProposals          *prometheus.GaugeVec
	PendingRemovalAge    prometheus.Gauge
	FrozenGroups         prometheus.Gauge
	ElectionRounds       *prometheus.CounterVec
	WasiCalls            *prometheus.CounterVec
	WasiDuration         *prometheus.HistogramVec
	StoreTxDuration      *prometheus.HistogramVec
	BlobBytes            prometheus.Counter
	RateLimitedTotal     *prometheus.CounterVec
}

// NewMetrics takes the gatherer explicitly rather than type-asserting the
// registerer. prometheus.WrapRegistererWithPrefix and WrapRegistererWith return
// a Registerer that is NOT a Gatherer, so `m.reg.(prometheus.Gatherer)` panics
// on a perfectly ordinary argument — and Handler is built inside dillad.New, so
// the panic would take the instance down before it served anything.
func NewMetrics(r prometheus.Registerer, g prometheus.Gatherer) *Metrics {
	m := &Metrics{reg: r, gath: g}
	m.HTTPRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_http_requests_total", Help: "HTTP requests by route, method and status."},
		[]string{"route", "method", "code"})
	m.HTTPDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{Name: "dilla_http_request_duration_seconds", Help: "HTTP request duration by route."},
		[]string{"route"})
	m.GatewayConnections = prometheus.NewGauge(
		prometheus.GaugeOpts{Name: "dilla_gateway_connections", Help: "Open gateway connections."})
	m.GatewayFrames = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_gateway_frames_total", Help: "Gateway frames by opcode and direction."},
		[]string{"op", "dir"})
	m.GatewayQueueOverflow = prometheus.NewCounter(
		prometheus.CounterOpts{Name: "dilla_gateway_queue_overflow_total", Help: "Connections closed for a full writer queue."})
	m.DSCommits = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_ds_commits_total", Help: "Commits by result."}, []string{"result"})
	m.DSCommitDuration = prometheus.NewHistogram(
		prometheus.HistogramOpts{Name: "dilla_ds_commit_duration_seconds", Help: "Commit validation and persistence duration."})
	m.DSProposals = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{Name: "dilla_ds_proposals_outstanding", Help: "Outstanding instance proposals by kind."}, []string{"kind"})
	m.PendingRemovalAge = prometheus.NewGauge(
		prometheus.GaugeOpts{Name: "dilla_mls_pending_removal_age_seconds", Help: "Age of the oldest uncommitted instance Remove."})
	m.FrozenGroups = prometheus.NewGauge(
		prometheus.GaugeOpts{Name: "dilla_ds_frozen_groups", Help: "Groups frozen by an outstanding instance proposal."})
	m.ElectionRounds = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_ds_election_rounds_total", Help: "Committer election rounds by result."}, []string{"result"})
	m.WasiCalls = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_wasi_calls_total", Help: "wasi ABI calls by export."}, []string{"export"})
	m.WasiDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{Name: "dilla_wasi_call_duration_seconds", Help: "wasi ABI call duration by export."}, []string{"export"})
	m.StoreTxDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{Name: "dilla_store_tx_duration_seconds", Help: "Store transaction duration by engine."}, []string{"engine"})
	m.BlobBytes = prometheus.NewCounter(
		prometheus.CounterOpts{Name: "dilla_blob_bytes_total", Help: "Blob bytes accepted."})
	m.RateLimitedTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{Name: "dilla_rate_limited_total", Help: "Refusals by rate-limit class."}, []string{"class"})
	r.MustRegister(m.collectors()...)
	return m
}

func (m *Metrics) collectors() []prometheus.Collector {
	return []prometheus.Collector{
		m.HTTPRequests, m.HTTPDuration, m.GatewayConnections, m.GatewayFrames,
		m.GatewayQueueOverflow, m.DSCommits, m.DSCommitDuration, m.DSProposals,
		m.PendingRemovalAge, m.FrozenGroups, m.ElectionRounds, m.WasiCalls,
		m.WasiDuration, m.StoreTxDuration, m.BlobBytes, m.RateLimitedTotal,
	}
}

// Describe lets a test enumerate every registered metric name without first
// having to observe each one.
func (m *Metrics) Describe(ch chan<- *prometheus.Desc) {
	for _, c := range m.collectors() {
		c.Describe(ch)
	}
}

func (m *Metrics) ObserveHTTP(route, method string, status int, d time.Duration) {
	m.HTTPRequests.WithLabelValues(route, method, statusClass(status)).Inc()
	m.HTTPDuration.WithLabelValues(route).Observe(d.Seconds())
}

func (m *Metrics) RateLimited(class string) { m.RateLimitedTotal.WithLabelValues(class).Inc() }

func statusClass(status int) string {
	switch {
	case status < 200:
		return "1xx"
	case status < 300:
		return "2xx"
	case status < 400:
		return "3xx"
	case status < 500:
		return "4xx"
	default:
		return "5xx"
	}
}

// Handler serves the registry. With requireAdmin the scrape token is compared
// in constant time; without metrics.enabled the route is 404, not 403, so a
// scraper cannot tell a disabled endpoint from a guarded one.
func (m *Metrics) Handler(requireAdmin bool, token string) http.Handler {
	inner := promhttp.HandlerFor(m.gath, promhttp.HandlerOpts{})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !requireAdmin {
			inner.ServeHTTP(w, r)
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="dilla metrics"`)
			http.Error(w, "", http.StatusUnauthorized)
			return
		}
		inner.ServeHTTP(w, r)
	})
}
