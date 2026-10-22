package dillad_test

// UP11-b through the composition root: POST /v1/calls/{call_id}/relay sits behind the same session
// middleware and the same per-device write bucket as its neighbour POST /v1/calls/{call_id}/share.

import (
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// owedAccountToken is accountToken without satisfyFactor: an account registered through POST
// /v1/accounts owes a second factor until it adds one.
func owedAccountToken(t *testing.T, h http.Handler, code string) string {
	t.Helper()
	body, err := cborx.Marshal(newAccountRequest(code, "owed", newTestDevice(t)))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	res := post(t, h, "/v1/accounts", body)
	if res.Code != http.StatusOK {
		t.Fatalf("POST /v1/accounts = %d: %s", res.Code, res.Body.String())
	}
	var account []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &account); err != nil {
		t.Fatalf("decode: %v", err)
	}
	token, ok := account[2].(string)
	if !ok || token == "" {
		t.Fatalf("no session token in the account response: %#v", account)
	}
	return token
}

func TestTheRelayRouteIsGatedAsItsNeighbourCallRoute(t *testing.T) {
	for _, route := range []string{"relay", "share"} {
		t.Run(route, func(t *testing.T) {
			path := "/v1/calls/" + id.New().String() + "/" + route

			// An account that owes a second factor is refused before anything else, as on every `E` route.
			_, h, code := newInstance(t)
			owed := owedAccountToken(t, h, code)
			if rec := call(t, h, http.MethodPost, path, owed, []any{}); rec.Code != http.StatusForbidden || errorCode(rec) != "E_FACTOR_REQUIRED" {
				t.Fatalf("POST %s as an owed session = %d %q, want 403 E_FACTOR_REQUIRED", path, rec.Code, errorCode(rec))
			}

			// Past the write burst a device is refused 429 E_RATE_LIMITED, whatever the route would have
			// answered (here 404 E_NOT_FOUND, the route's own answer for an unknown call).
			srv, h, code := newInstance(t)
			tok := accountToken(t, srv, code)
			burst := testConfig(t).Limits.Rate.WriteBurst
			for i := range 2 * burst {
				rec := call(t, h, http.MethodPost, path, tok, []any{})
				if rec.Code == http.StatusTooManyRequests {
					if i < burst {
						t.Fatalf("request %d of a write burst of %d was refused", i+1, burst)
					}
					if errorCode(rec) != "E_RATE_LIMITED" {
						t.Fatalf("429 carried %q, want E_RATE_LIMITED", errorCode(rec))
					}
					return
				}
				if rec.Code != http.StatusNotFound || errorCode(rec) != "E_NOT_FOUND" {
					t.Fatalf("POST %s for an unknown call = %d %q, want 404 E_NOT_FOUND (the route is mounted)", path, rec.Code, errorCode(rec))
				}
			}
			t.Fatalf("%d posts to %s in a row were never refused; the write burst is %d", 2*burst, path, burst)
		})
	}
}
