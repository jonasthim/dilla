package api

import (
	"net/http/httptest"
	"testing"
)

// UP6b: GET /v1/groups/{id}/handshakes serves kind-3 rows only when the query asks for them with
// kinds=3 (protocol/02 § Handshake records); anything else is the stream without them.
func TestTheHandshakesRouteServesKind3OnlyWhenAsked(t *testing.T) {
	for query, want := range map[string]bool{
		"from=1&limit=512":           false,
		"from=1&limit=512&kinds=3":   true,
		"kinds=0,3":                  true,
		"kinds=%203":                 true,
		"kinds=4":                    false,
		"kinds=":                     false,
		"kinds=33":                   false,
		"kinds=2&kinds=3":            true,
		"from=1&kinds=withdrawn_row": false,
	} {
		r := httptest.NewRequestWithContext(t.Context(), "GET", "/v1/groups/x/handshakes?"+query, nil)
		if got := wantsKind3(r); got != want {
			t.Fatalf("?%s: wantsKind3 = %v, want %v", query, got, want)
		}
	}
}
