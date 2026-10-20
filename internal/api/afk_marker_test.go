package api_test

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// Fix round 1 (R-AFK1, R-AFK2, m-3): the built-in channel is told apart by its settings_json marker,
// read under the community lock; the audit log is history only.

const builtinMarker = `{"afk":"builtin"}`

// prunedAuditRepo answers every audit read as an empty log (an operator pruned it) and counts the
// reads, inside a transaction too.
type prunedAuditRepo struct {
	store.Repository
	reads *atomic.Int64
}

func (p prunedAuditRepo) ListAudit(context.Context, int64, int32) ([]store.AuditRow, error) {
	p.reads.Add(1)
	return nil, nil
}

func (p prunedAuditRepo) Tx(ctx context.Context, fn func(store.Repository) error) error {
	return p.Repository.Tx(ctx, func(tx store.Repository) error { return fn(prunedAuditRepo{tx, p.reads}) })
}

func TestTheBuiltInCarriesTheMarker(t *testing.T) {
	e, cid, _ := channelEnv(t)
	afk, _ := afkPointer(t, e, cid)
	row, err := e.Repo.GetChannel(t.Context(), afk)
	if err != nil || string(row.SettingsJSON) != builtinMarker {
		t.Fatalf("AFK settings_json = %q, %v; want %s", row.SettingsJSON, err, builtinMarker)
	}
}

func TestEnsureAFKChannelsNeverReadsTheAuditLog(t *testing.T) {
	e, _, ownerTok := channelEnv(t)
	owner := e.sess[ownerTok].UserID
	log := slog.New(slog.DiscardHandler)
	seedStoreCommunity(t, e, owner, "a")
	b, _ := seedStoreCommunity(t, e, owner, "b")
	pick := seedVoice(t, e, b, "pick")
	if err := e.Repo.SetCommunityAFK(t.Context(), b, store.CommunityAFK{ChannelID: &pick, TimeoutSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	createCommunity(t, e, ownerTok) // already built in
	if n, err := api.EnsureAFKChannels(t.Context(), e.Repo, e.DS, e.Clk, log); err != nil || n != 2 {
		t.Fatalf("first run = %d, %v; want 2", n, err)
	}
	if n, err := api.EnsureAFKChannels(t.Context(), e.Repo, e.DS, e.Clk, log); err != nil || n != 0 {
		t.Fatalf("second run = %d, %v; want 0", n, err)
	}
	// Every audit row gone: a third run still creates nothing, and never asks the log.
	reads := new(atomic.Int64)
	if n, err := api.EnsureAFKChannels(t.Context(), prunedAuditRepo{e.Repo, reads}, e.DS, e.Clk, log); err != nil || n != 0 {
		t.Fatalf("run after the audit log was pruned = %d, %v; want 0", n, err)
	}
	if reads.Load() != 0 {
		t.Fatalf("the backfill read the audit log %d times", reads.Load())
	}
}

// A web3.8 pick that looks like the built-in channel (named AFK, at 1<<30) but has no marker is a
// pick, and gets a new built-in channel.
func TestEnsureAFKChannelsReplacesAnUnmarkedLookalike(t *testing.T) {
	e, _, ownerTok := channelEnv(t)
	owner := e.sess[ownerTok].UserID
	cid, _ := seedStoreCommunity(t, e, owner, "lookalike")
	fake := id.New()
	if err := e.Repo.CreateChannel(t.Context(), store.ChannelRow{ID: fake, CommunityID: &cid, Kind: api.ChannelVoice,
		Name: "AFK", Position: api.AFKBuiltinPosition, SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: 1}); err != nil {
		t.Fatal(err)
	}
	if err := e.Repo.SetCommunityAFK(t.Context(), cid, store.CommunityAFK{ChannelID: &fake, TimeoutSeconds: 900}); err != nil {
		t.Fatal(err)
	}
	if n, err := api.EnsureAFKChannels(t.Context(), e.Repo, e.DS, e.Clk, slog.New(slog.DiscardHandler)); err != nil || n != 1 {
		t.Fatalf("EnsureAFKChannels = %d, %v; want 1", n, err)
	}
	ptr, timeout := afkPointer(t, e, cid)
	row, err := e.Repo.GetChannel(t.Context(), ptr)
	if err != nil || ptr == fake || timeout != 900 || string(row.SettingsJSON) != builtinMarker {
		t.Fatalf("pointer %s (%q) %d, want a new marked AFK with 900", ptr, row.SettingsJSON, timeout)
	}
	if _, err := e.Repo.GetChannel(t.Context(), fake); err != nil {
		t.Fatalf("the lookalike is gone: %v", err)
	}
}

// R-AFK2: an overwrite on the built-in channel (a rollback to web3.8 could write one) is removed by
// the next ensure; an overwrite on an ordinary channel stays.
func TestEnsureAFKStripsOverwritesOnTheBuiltIn(t *testing.T) {
	e, cid, tok := channelEnv(t)
	afk, _ := afkPointer(t, e, cid)
	lounge, _, status := newChannel(t, e, cid, tok, uint64(api.ChannelVoice), 0, 0, "lounge")
	if status != http.StatusCreated {
		t.Fatalf("lounge = %d", status)
	}
	owner := e.sess[tok].UserID
	for _, ch := range []id.ID{afk, lounge} {
		if err := e.Repo.PutOverwrite(t.Context(), store.OverwriteRow{ChannelID: ch, TargetKind: 1, TargetID: owner,
			Allow: uint64(api.PermPinMessages)}); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := api.EnsureAFKChannels(t.Context(), e.Repo, e.DS, e.Clk, slog.New(slog.DiscardHandler)); err != nil || n != 0 {
		t.Fatalf("EnsureAFKChannels = %d, %v; want 0 created", n, err)
	}
	if ow, err := e.Repo.ListOverwrites(t.Context(), afk); err != nil || len(ow) != 0 {
		t.Fatalf("AFK overwrites after the ensure = %v, %v; want none", ow, err)
	}
	if ow, err := e.Repo.ListOverwrites(t.Context(), lounge); err != nil || len(ow) != 1 {
		t.Fatalf("lounge overwrites after the ensure = %v, %v; want its one (control)", ow, err)
	}
	if ptr, _ := afkPointer(t, e, cid); ptr != afk {
		t.Fatal("the strip moved the pointer")
	}
}

// R-AFK8 (server half): a built-in AFK channel moved off 2^30 (a dev instance that ran an earlier web3.9
// build accepted the move) is put back by the next ensure, with a null-actor audit row; an ordinary
// channel's position is untouched, and a second run writes nothing.
func TestEnsureAFKRestoresThePosition(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := t.Context()
			clk := newEnv(t).Clk
			log := slog.New(slog.DiscardHandler)
			owner := id.New()
			if err := repo.CreateUser(ctx, newAPITestUser(owner, "u", policyT0)); err != nil {
				t.Fatal(err)
			}
			cid := id.New()
			if err := repo.CreateCommunity(ctx, store.CommunityRow{ID: cid, Owner: owner, Name: "c",
				PolicyJSON: []byte("{}"), PolicyVersion: 1, Created: policyT0}); err != nil {
				t.Fatal(err)
			}
			if err := repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: owner, Joined: policyT0}); err != nil {
				t.Fatal(err)
			}
			if err := repo.PutRole(ctx, store.RoleRow{ID: id.New(), CommunityID: cid, Name: "@everyone",
				Allow: uint64(api.DefaultEveryoneAllow), Created: policyT0}); err != nil {
				t.Fatal(err)
			}
			lounge := id.New()
			if err := repo.CreateChannel(ctx, store.ChannelRow{ID: lounge, CommunityID: &cid, Kind: api.ChannelVoice,
				Name: "lounge", Position: 7, SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: policyT0}); err != nil {
				t.Fatal(err)
			}
			if n, err := api.EnsureAFKChannels(ctx, repo, nil, clk, log); err != nil || n != 1 {
				t.Fatalf("seeding run = %d, %v; want 1", n, err)
			}
			cfg, err := repo.GetCommunityAFK(ctx, cid)
			if err != nil || cfg.ChannelID == nil {
				t.Fatalf("pointer = %+v, %v", cfg, err)
			}
			afk := *cfg.ChannelID
			row, err := repo.GetChannel(ctx, afk)
			if err != nil {
				t.Fatal(err)
			}
			row.Position, row.Name = 7, "Idle" // what an earlier web3.9 build let a PATCH write
			if err := repo.UpdateChannel(ctx, row); err != nil {
				t.Fatal(err)
			}
			restores := func() int {
				rows, err := repo.ListAudit(ctx, 0, 10_000)
				if err != nil {
					t.Fatalf("ListAudit: %v", err)
				}
				n := 0
				for _, a := range rows {
					if a.Action == "channel.update" && a.Target == afk.String() && strings.HasPrefix(a.Detail, "afk.position:") {
						if a.Actor != nil || a.Detail != "afk.position:7" {
							t.Fatalf("restore audit row = %+v; want a null actor and the position it left", a)
						}
						n++
					}
				}
				return n
			}
			if n, err := api.EnsureAFKChannels(ctx, repo, nil, clk, log); err != nil || n != 0 {
				t.Fatalf("restoring run = %d, %v; want 0 created", n, err)
			}
			got, err := repo.GetChannel(ctx, afk)
			if err != nil || got.Position != api.AFKBuiltinPosition || got.Name != "Idle" {
				t.Fatalf("AFK after the ensure = %+v, %v; want Idle back at 2^30", got, err)
			}
			if n := restores(); n != 1 {
				t.Fatalf("restore audit rows = %d, want 1", n)
			}
			if ptr, err := repo.GetCommunityAFK(ctx, cid); err != nil || ptr.ChannelID == nil || *ptr.ChannelID != afk {
				t.Fatalf("the restore moved the pointer: %+v, %v", ptr, err)
			}
			if l, err := repo.GetChannel(ctx, lounge); err != nil || l.Position != 7 {
				t.Fatalf("lounge = %+v, %v; want position 7 (control)", l, err)
			}
			// Idempotent: the second run changes nothing and audits nothing. An overwrite on the AFK channel
			// takes it past the unlocked pre-check into the transaction, where the restore decides again.
			if err := repo.PutOverwrite(ctx, store.OverwriteRow{ChannelID: afk, TargetKind: 1, TargetID: owner,
				Allow: uint64(api.PermPinMessages)}); err != nil {
				t.Fatal(err)
			}
			if n, err := api.EnsureAFKChannels(ctx, repo, nil, clk, log); err != nil || n != 0 {
				t.Fatalf("second run = %d, %v; want 0", n, err)
			}
			again, err := repo.GetChannel(ctx, afk)
			if err != nil || again.Position != api.AFKBuiltinPosition || again.Seq != got.Seq {
				t.Fatalf("AFK after the second run = %+v, %v", again, err)
			}
			if n := restores(); n != 1 {
				t.Fatalf("restore audit rows after the second run = %d, want 1", n)
			}
		})
	}
}

// m-1: two ensures at once against one database write exactly one built-in channel per community.
func TestConcurrentEnsuresCreateOnePerCommunity(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := t.Context()
			clk := newEnv(t).Clk
			owner := id.New()
			if err := repo.CreateUser(ctx, newAPITestUser(owner, "u", policyT0)); err != nil {
				t.Fatal(err)
			}
			var cids []id.ID
			for i := range 4 {
				cid := id.New()
				if err := repo.CreateCommunity(ctx, store.CommunityRow{ID: cid, Owner: owner, Name: "c",
					PolicyJSON: []byte("{}"), PolicyVersion: 1, Created: policyT0}); err != nil {
					t.Fatal(err)
				}
				if err := repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: owner, Joined: policyT0}); err != nil {
					t.Fatal(err)
				}
				if err := repo.PutRole(ctx, store.RoleRow{ID: id.New(), CommunityID: cid, Name: "@everyone",
					Allow: uint64(api.DefaultEveryoneAllow), Created: policyT0}); err != nil {
					t.Fatal(err)
				}
				if i == 0 { // a web3.8 pick
					pick := id.New()
					if err := repo.CreateChannel(ctx, store.ChannelRow{ID: pick, CommunityID: &cid, Kind: api.ChannelVoice,
						Name: "pick", SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: policyT0}); err != nil {
						t.Fatal(err)
					}
					if err := repo.SetCommunityAFK(ctx, cid, store.CommunityAFK{ChannelID: &pick, TimeoutSeconds: 60}); err != nil {
						t.Fatal(err)
					}
				}
				cids = append(cids, cid)
			}
			var wg sync.WaitGroup
			var total atomic.Int64
			for range 2 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					n, err := api.EnsureAFKChannels(ctx, repo, nil, clk, slog.New(slog.DiscardHandler))
					if err != nil {
						t.Errorf("EnsureAFKChannels: %v", err)
					}
					total.Add(int64(n))
				}()
			}
			wg.Wait()
			if total.Load() != int64(len(cids)) {
				t.Fatalf("the two runs created %d, want %d", total.Load(), len(cids))
			}
			for _, cid := range cids {
				all, err := repo.ListChannels(ctx, cid)
				if err != nil {
					t.Fatal(err)
				}
				marked := 0
				for _, c := range all {
					if string(c.SettingsJSON) == builtinMarker {
						marked++
					}
				}
				if marked != 1 {
					t.Fatalf("community %s has %d built-in channels, want 1", cid, marked)
				}
			}
		})
	}
}

// afkReadCounter counts GetCommunityAFK.
type afkReadCounter struct {
	store.Repository
	reads *atomic.Int64
}

func (a afkReadCounter) GetCommunityAFK(ctx context.Context, cid id.ID) (store.CommunityAFK, error) {
	a.reads.Add(1)
	return a.Repository.GetCommunityAFK(ctx, cid)
}

// m-3: one listing reads the AFK pointer once, however many channels it resolves.
func TestTheListingReadsThePointerOnce(t *testing.T) {
	e, cid, tok := channelEnv(t)
	for _, n := range []string{"a", "b", "c", "d"} {
		if _, _, status := newChannel(t, e, cid, tok, uint64(api.ChannelText), 1, 0, n); status != http.StatusCreated {
			t.Fatalf("channel %s = %d", n, status)
		}
	}
	reads := new(atomic.Int64)
	counted := newEnv(t)
	counted.Repo = afkReadCounter{e.Repo, reads}
	counted.sess = e.sess
	api.NewChannels(counted.Repo, counted.DS, counted.Clk, 10, slog.New(slog.DiscardHandler)).Register(counted.Mux)
	status, body := counted.Do(http.MethodGet, "/v1/communities/"+cid.String()+"/channels", tok, nil)
	if status != http.StatusOK {
		t.Fatalf("GET channels = %d (%x)", status, body)
	}
	if got := reads.Load(); got != 1 {
		t.Fatalf("one listing of 5 channels read the AFK pointer %d times, want 1", got)
	}
}
