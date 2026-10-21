package api_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
)

// registerInstance already guards `d.Config != nil` when it decides whether
// GET /v1/instance is enrolled-only, so a Deps without a Config is a shape the
// package's own routing table admits — and three tests in this package build
// exactly that. Both handlers then read d.Config.Auth, d.Config.Instance and
// d.Config.Limits unconditionally, which is a nil dereference: in production
// server.Recover turns it into a 500, but internal/api mounts no Recover, so
// the panic takes the whole test binary down instead of failing one test.
//
// The precedent is TestDeleteMeWithoutAConfigRefusesRatherThanSkippingTheStepUp
// in accounts_delete_test.go: a missing config fails CLOSED with a 500.
func TestTheInstanceRoutesWithoutAConfigFailClosed(t *testing.T) {
	_, deps := newTestAPI(t)
	unwired := deps
	unwired.Config = nil
	m := server.NewMux()
	api.Register(m, unwired)

	for _, path := range []string{"/v1/instance", "/v1/instance/limits"} {
		rec := httptest.NewRecorder()
		m.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("GET %s = %d with no config, want 500: a missing config must fail closed", path, rec.Code)
		}
	}
}

// E8: element 11 of the discovery document says whether the GIF picker is on, so a client shows no
// GIF button on an instance without a Giphy key. The key itself is never in the document.
func TestTheInstanceDocumentSaysWhetherGIFsAreOn(t *testing.T) {
	for _, tc := range []struct {
		key  string
		want uint64
	}{{"", 0}, {"k-SECRET-giphy", 1}} {
		h, _ := newTestAPIFull(t, func(c *config.Config) { c.Giphy.APIKey = tc.key },
			func(d *api.Deps) { d.ExternalSenderPub = make([]byte, 32) })
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/instance", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET /v1/instance = %d", rec.Code)
		}
		var doc []any
		if err := cborx.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if len(doc) != 12 || doc[11] != tc.want {
			t.Fatalf("key %q: document = %d elements, gifs = %v; want 12 and %v", tc.key, len(doc), doc[len(doc)-1], tc.want)
		}
		if bytes.Contains(rec.Body.Bytes(), []byte("SECRET")) {
			t.Fatal("the Giphy key is in the discovery document")
		}
	}
}
