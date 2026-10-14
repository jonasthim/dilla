package api_test

import (
	"log/slog"
	"net/http"
	"sync"
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
)

// changedGW records every op 54 community_changed per user, as DeliverUser hands it to the user's
// live connections.
type changedGW struct {
	mu   sync.Mutex
	seen map[id.ID][]id.ID // user → the community ids it was told of, in order
}

func (g *changedGW) DeliverUser(u id.ID, f gateway.Frame) {
	if f.Op != gateway.OpCommunityChanged {
		return
	}
	var raw []cbor.RawMessage
	var cid id.ID
	if cborx.Unmarshal(f.Payload, &raw) != nil || len(raw) != 1 || cborx.Unmarshal(raw[0], &cid) != nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.seen[u] = append(g.seen[u], cid)
}

func (g *changedGW) count(u id.ID) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.seen[u])
}

// Each structural change a member's open tab must learn of is announced once, after its commit, to
// every member and to nobody else: a channel's create, update and delete, and a community PATCH. A
// refused change announces nothing.
func TestEveryStructuralChangeTellsTheMembersOnce(t *testing.T) {
	e := newEnv(t)
	log := slog.New(slog.DiscardHandler)
	gw := &changedGW{seen: map[id.ID][]id.ID{}}
	notify := api.NewStructureNotifier(gw, e.Repo, log)
	api.NewCommunities(e.Repo, e.DS, e.Clk, log).WithNotifier(notify).Register(e.Mux)
	api.NewChannels(e.Repo, e.DS, e.Clk, 10, log).WithNotifier(notify).Register(e.Mux)
	owner, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)
	member, memberTok := e.NewUser("member")
	if status, body := join(e, cid, memberTok, nil); status != http.StatusOK {
		t.Fatalf("join = %d (%x)", status, body)
	}
	stranger, _ := e.NewUser("stranger")

	want := 0
	step := func(name string, status, wantStatus int) {
		t.Helper()
		if status != wantStatus {
			t.Fatalf("%s = %d, want %d", name, status, wantStatus)
		}
		if wantStatus < 300 {
			want++
		}
		for _, u := range []id.ID{owner, member} {
			if got := gw.count(u); got != want {
				t.Fatalf("after %s user %s was told %d times, want %d", name, u, got, want)
			}
		}
		if got := gw.count(stranger); got != 0 {
			t.Fatalf("after %s a non-member was told %d times", name, got)
		}
	}

	ch, _, status := newChannel(t, e, cid, ownerTok, 0, 0, 0, "planering")
	step("create", status, http.StatusCreated)
	status, _ = e.Do(http.MethodPatch, "/v1/channels/"+ch.String(), ownerTok, []any{"fika", nil, nil, nil, nil, nil, nil})
	step("update", status, http.StatusNoContent)
	status, _ = e.Do(http.MethodPatch, "/v1/channels/"+ch.String(), memberTok, []any{"nope", nil, nil, nil, nil, nil, nil})
	step("a refused update", status, http.StatusForbidden)
	status, _ = e.Do(http.MethodDelete, "/v1/channels/"+ch.String(), ownerTok, nil)
	step("delete", status, http.StatusNoContent)
	status, _ = e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), ownerTok, []any{"Fika", nil, nil, nil})
	step("community patch", status, http.StatusOK)

	for _, u := range []id.ID{owner, member} {
		for _, got := range gw.seen[u] {
			if got != cid {
				t.Fatalf("user %s was told of community %s, want %s", u, got, cid)
			}
		}
	}
}
