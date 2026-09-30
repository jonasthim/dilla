package api_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
)

// C4 (fix wave): the delivery service proposes a device into a DM only once its user's signed
// device list names it, and pairing publishes the KeyPackages (protocol/03 § Pairing, step 2)
// before the list (step 5). So an accepted list publish is handed to AfterDeviceList, on a context
// the request does not end, and a refused one is not.
func TestAnAcceptedDeviceListPublishIsHandedToAfterDeviceList(t *testing.T) {
	e := newEnv(t)
	user, token := e.NewUser("pairer")
	var seen []id.ID
	deps := api.Deps{
		Repo: e.Repo, Clock: e.Clk,
		AfterDeviceList: func(ctx context.Context, u id.ID) {
			if ctx.Err() != nil {
				t.Errorf("the hook's context has already ended: %v", ctx.Err())
			}
			seen = append(seen, u)
		},
	}
	e.Mux.Handle("PUT /v1/users/{user_id}/device-list", http.HandlerFunc(deps.PutDeviceList))
	path := "/v1/users/" + user.String() + "/device-list"
	body := []any{uint64(1), []byte{0x80}, bytes.Repeat([]byte{7}, 64), make([]byte, 32)}

	if status, raw := e.Do(http.MethodPut, path, token, body); status != http.StatusNoContent {
		t.Fatalf("publish: status %d, want 204: %x", status, raw)
	}
	// The same version again is a 409 and reaches no hook.
	if status, _ := e.Do(http.MethodPut, path, token, body); status != http.StatusConflict {
		t.Fatalf("republishing version 1: status %d, want 409", status)
	}
	if len(seen) != 1 || seen[0] != user {
		t.Fatalf("AfterDeviceList saw %v, want exactly one run for %s", seen, user)
	}
}
