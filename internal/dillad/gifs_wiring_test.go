package dillad_test

import (
	"context"
	"net/http"
	"testing"
)

// E8: the GIF routes are mounted behind the enrolled-session middleware, so an anonymous caller is
// refused before the handler (and so before any key check) and never reaches Giphy.
func TestTheGIFRoutesAreMountedBehindTheSessionMiddleware(t *testing.T) {
	srv, h, _ := newInstance(t)
	defer srv.Shutdown(context.Background())
	for _, path := range []string{"/v1/gifs/search?q=cat", "/v1/gifs/media/abc123?r=preview"} {
		rec := call(t, h, http.MethodGet, path, "", nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s without a session = %d %q, want 401", path, rec.Code, errorCode(rec))
		}
	}
}
