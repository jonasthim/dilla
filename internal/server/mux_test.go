package server_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jonasthim/dilla/internal/server"
)

func TestConflictingPatternsPanicAtRegistration(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("two conflicting patterns registered without a panic")
		}
	}()
	m := server.NewMux()
	h := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	m.Handle("GET /v1/groups/{id}", h)
	m.Handle("GET /v1/groups/{other}", h)
}

func TestAutomatic405CarriesAllow(t *testing.T) {
	m := server.NewMux()
	m.Handle("POST /v1/accounts", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv := httptest.NewServer(m)
	defer srv.Close()
	res, err := httpGet(t, srv.URL+"/v1/accounts")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", res.StatusCode)
	}
	_ = m.Mux() // the extension point 1b and 2 register through must exist
	if res.Header.Get("Allow") == "" {
		t.Fatal("the automatic 405 carries no Allow header")
	}
}

// httpGet is http.Get bound to the test's context.
func httpGet(t *testing.T, url string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	return http.DefaultClient.Do(req)
}
