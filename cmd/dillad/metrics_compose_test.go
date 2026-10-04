package main

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

// fqNameOf is the metric name in a prometheus.Desc's String().
var fqNameOf = regexp.MustCompile(`fqName: "([^"]+)"`)

// I-1 of the integration re-review: every dilla_* family the process defines reaches /metrics as
// serve.go composes it (newMetrics: dillad's own registry plus LiveKit's default registry through
// the allowlisting LiveKitGatherer), the relay's backstop counters included as startTURN builds
// them. The expected families are enumerated from the registries — every dilla_* series on the
// default registry and every one dillad's Metrics describes — so a series added later on the wrong
// registry fails here. A vector with no series yet has no sample to serve, so the served check
// covers the families the registries gather.
func TestTheComposedMetricsServeEveryDillaFamily(t *testing.T) {
	m := newMetrics()
	relay := relayMetricsFor(m)
	relay.CutOverflow()
	relay.CapacityRefused()
	relay.PeerDropped()

	rec := httptest.NewRecorder()
	m.Handler(false, "").ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d", rec.Code)
	}
	served := map[string]bool{}
	sc := bufio.NewScanner(strings.NewReader(rec.Body.String()))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		if name, ok := strings.CutPrefix(sc.Text(), "# TYPE "); ok {
			served[strings.Fields(name)[0]] = true
		}
	}

	expected := map[string]bool{}
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather the default registry: %v", err)
	}
	for _, f := range families {
		if strings.HasPrefix(f.GetName(), "dilla_") {
			expected[f.GetName()] = true
		}
	}
	descs := make(chan *prometheus.Desc, 256)
	go func() {
		m.Describe(descs)
		close(descs)
	}()
	described := 0
	for d := range descs {
		sub := fqNameOf.FindStringSubmatch(d.String())
		if sub == nil {
			t.Fatalf("a Desc without a name: %s", d)
		}
		described++
		// A label-free series always has its one sample, so it must be served; a vector is served
		// once it has a series.
		if strings.Contains(d.String(), "variableLabels: {}") {
			expected[sub[1]] = true
		}
	}
	if described == 0 {
		t.Fatal("dillad's Metrics described no series")
	}
	var missing []string
	for name := range expected {
		if !served[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) != 0 {
		t.Fatalf("dilla_* families defined but not served on the composed /metrics: %v", missing)
	}
	for _, name := range []string{"dilla_turn_cut_overflows_total", "dilla_turn_capacity_refusals_total", "dilla_turn_peer_drops_total"} {
		if !served[name] {
			t.Errorf("the relay backstop %s is not served", name)
		}
	}
}
