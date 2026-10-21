package dillad_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

// R-UP11: api.sock's routes. The barred lookup answers as the call routes do (api.BarredDevices,
// whose barred states its own tests cover): an id with no device row is not barred, and a
// malformed id is a 400. GET /media/recent-mints counts the call tokens minted within 60 s.
func TestTheAPISocketAnswersTheBarredLookupAndRecentMints(t *testing.T) {
	srv, _, _ := newInstance(t)
	h := srv.ControlHandler()
	get := func(path string, out any) int {
		t.Helper()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))
		if rec.Code == http.StatusOK && out != nil {
			if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
				t.Fatalf("GET %s: %v (%s)", path, err, rec.Body.String())
			}
		}
		return rec.Code
	}
	var barred struct {
		Barred *bool `json:"barred"`
	}
	if code := get("/relay/barred/"+id.New().String(), &barred); code != http.StatusOK || barred.Barred == nil || *barred.Barred {
		t.Fatalf("an unknown device: %d %v, want 200 not barred", code, barred.Barred)
	}
	if code := get("/relay/barred/not-an-id", nil); code != http.StatusBadRequest {
		t.Fatalf("a malformed id: %d, want 400", code)
	}
	var mints struct {
		Count    *int `json:"count"`
		WindowMS int  `json:"window_ms"`
	}
	if code := get("/media/recent-mints", &mints); code != http.StatusOK || mints.Count == nil || *mints.Count != 0 || mints.WindowMS != 60_000 {
		t.Fatalf("recent mints: %d %+v, want 200 count 0 over 60 s", code, mints)
	}
}
