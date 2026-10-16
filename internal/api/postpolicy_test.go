package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/postgres"
	pgmigrations "github.com/jonasthim/dilla/internal/store/postgres/migrations"
)

// The post policy (web3.7 SB1, protocol/02 § Upload class): a class-0 upload into a community
// text group needs send_messages and waits out slow mode; a class-1 upload (a fold) is never
// checked; a legacy two-element upload (a nil class) needs send_messages and is never slowed (R28).

func classOf(v uint8) *uint8 { return &v }

// policyEngines is newEnv's SQLite repository, plus a migrated Postgres one in a database of its
// own when DILLA_TEST_PG names a server, so every policy case runs on both engines.
func policyEngines(t *testing.T) map[string]store.Repository {
	t.Helper()
	out := map[string]store.Repository{"sqlite": newEnv(t).Repo}
	dsn := os.Getenv("DILLA_TEST_PG")
	if dsn == "" {
		t.Log("DILLA_TEST_PG is unset: the Postgres leg runs in CI's service container")
		return out
	}
	admin, err := postgres.Open(dsn, 1, time.Hour)
	if err != nil {
		t.Fatalf("postgres Open: %v", err)
	}
	name := "dilla_t_" + id.New().String()[:16]
	if _, err := admin.ExecContext(context.Background(), `CREATE DATABASE `+name); err != nil {
		_ = admin.Close()
		t.Fatalf("CREATE DATABASE: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`)
		_ = admin.Close()
	})
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("DILLA_TEST_PG is not a URL: %v", err)
	}
	u.Path = "/" + name
	db, err := postgres.Open(u.String(), 4, time.Hour)
	if err != nil {
		t.Fatalf("postgres Open: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectPostgres, db, pgmigrations.FS)
	if err != nil {
		t.Fatalf("postgres provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("postgres up: %v", err)
	}
	repo := postgres.New(db)
	t.Cleanup(func() { _ = repo.Close() })
	out["postgres"] = repo
	return out
}

// policyFixture is a community owned by someone else, one text channel, the @everyone role, a
// member with two devices, and a kind-0 group bound to the channel.
type policyFixture struct {
	t        *testing.T
	repo     store.Repository
	cid      id.ID
	channel  store.ChannelRow
	group    store.GroupRow
	user     id.ID
	phone    id.ID
	laptop   id.ID
	seq      uint64
	position uint64
}

const policyT0 = int64(1_790_000_000)

func newPolicyFixture(t *testing.T, repo store.Repository, everyone api.Bits, slowmode uint64) *policyFixture {
	t.Helper()
	ctx := context.Background()
	f := &policyFixture{t: t, repo: repo, cid: id.New(), user: id.New(), phone: id.New(), laptop: id.New(), position: 1}
	owner := id.New()
	for _, uid := range []id.ID{owner, f.user} {
		if err := repo.CreateUser(ctx, newAPITestUser(uid, "u", policyT0)); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
	}
	for _, did := range []id.ID{f.phone, f.laptop} {
		if err := repo.CreateDevice(ctx, newAPITestDevice(did, f.user, policyT0)); err != nil {
			t.Fatalf("CreateDevice: %v", err)
		}
	}
	if err := repo.CreateCommunity(ctx, store.CommunityRow{
		ID: f.cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: policyT0,
	}); err != nil {
		t.Fatalf("CreateCommunity: %v", err)
	}
	if err := repo.PutRole(ctx, store.RoleRow{
		ID: id.New(), CommunityID: f.cid, Name: "@everyone", Position: 0, Allow: uint64(everyone), Created: policyT0,
	}); err != nil {
		t.Fatalf("PutRole(@everyone): %v", err)
	}
	if err := repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: f.cid, UserID: f.user, Joined: policyT0}); err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	cid := f.cid
	f.channel = store.ChannelRow{
		ID: id.New(), CommunityID: &cid, Kind: api.ChannelText, Mode: api.ModeE2EE, Name: "general",
		SettingsJSON: []byte(`{}`), HostPolicyVersion: 1, SlowmodeSeconds: slowmode, Created: policyT0,
	}
	if err := repo.CreateChannel(ctx, f.channel); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	f.group = f.newGroup(0, &cid)
	return f
}

func (f *policyFixture) newGroup(kind uint8, community *id.ID) store.GroupRow {
	f.t.Helper()
	g := store.GroupRow{
		GroupID: id.New(), Binding: []byte{0x80}, Kind: kind, CommunityID: community, TargetID: f.channel.ID,
		Ciphersuite: 1, ExternalSenderKeyID: id.New(), E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1,
		Created: policyT0,
	}
	if err := f.repo.CreateGroup(context.Background(), g); err != nil {
		f.t.Fatalf("CreateGroup: %v", err)
	}
	return g
}

// grant gives the member a new role allowing bits.
func (f *policyFixture) grant(bits api.Bits) {
	f.t.Helper()
	ctx := context.Background()
	role := id.New()
	if err := f.repo.PutRole(ctx, store.RoleRow{
		ID: role, CommunityID: f.cid, Name: "r", Position: f.position, Allow: uint64(bits), Created: policyT0,
	}); err != nil {
		f.t.Fatalf("PutRole: %v", err)
	}
	f.position++
	if err := f.repo.PutMemberRole(ctx, f.cid, f.user, role); err != nil {
		f.t.Fatalf("PutMemberRole: %v", err)
	}
}

// post stores one app message in g from device at created, as the delivery service would.
func (f *policyFixture) post(g store.GroupRow, device id.ID, created int64, class *uint8) {
	f.t.Helper()
	f.seq++
	if err := f.repo.PutAppMessage(context.Background(), store.AppMessageRow{
		GroupID: g.GroupID, Seq: f.seq, Epoch: 1, UploaderDevice: device, Blob: []byte("ct"),
		FrankingTag: make([]byte, 32), Size: 2, Created: created, Class: class,
	}); err != nil {
		f.t.Fatalf("PutAppMessage: %v", err)
	}
}

func (f *policyFixture) check(g store.GroupRow, class *uint8, now int64) error {
	return api.PostPolicy{Repo: f.repo, Resolver: api.NewResolver(f.repo)}.Check(context.Background(), g, f.user, class, now)
}

func wantPolicyNil(t *testing.T, label string, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: Check = %v, want nil", label, err)
	}
}

func wantPolicyRefusal(t *testing.T, label string, err error, status int, code server.Code) *server.Error {
	t.Helper()
	var se *server.Error
	if !errors.As(err, &se) || se.Status() != status || se.Code != code {
		t.Fatalf("%s: Check = %v, want %d %s", label, err, status, code)
	}
	return se
}

func wantPolicySlowed(t *testing.T, label string, err error) {
	t.Helper()
	se := wantPolicyRefusal(t, label, err, http.StatusTooManyRequests, server.CodeRateLimited)
	if se.RetryAfterMS == nil || *se.RetryAfterMS != 5000 {
		t.Fatalf("%s: retry_after_ms = %v, want 5000", label, se.RetryAfterMS)
	}
	if se.Detail != "slowmode: 5 seconds left" {
		t.Fatalf("%s: detail = %q, want %q", label, se.Detail, "slowmode: 5 seconds left")
	}
}

const viewSend = api.PermViewChannel | api.PermSendMessages

func TestAPostWithoutSendIsForbidden(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 0)
			wantPolicyRefusal(t, "no send, class 0", f.check(f.group, classOf(0), policyT0), http.StatusForbidden, server.CodeForbidden)
			f.grant(api.PermSendMessages)
			wantPolicyNil(t, "a role with send, class 0", f.check(f.group, classOf(0), policyT0))
		})
	}
}

func TestAFoldWithoutSendIsAccepted(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 0)
			wantPolicyNil(t, "no send, class 1", f.check(f.group, classOf(1), policyT0))
		})
	}
}

func TestSlowModeRefusesTheSecondPostWithItsWait(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, viewSend, 10)
			f.post(f.group, f.phone, policyT0, classOf(0))
			wantPolicySlowed(t, "class 0 at +5", f.check(f.group, classOf(0), policyT0+5))
			wantPolicyNil(t, "class 0 at +10", f.check(f.group, classOf(0), policyT0+10))
		})
	}
}

func TestBypassSlowmodeSkipsTheWait(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, viewSend, 10)
			f.post(f.group, f.phone, policyT0, classOf(0))
			f.grant(api.PermBypassSlowmode)
			wantPolicyNil(t, "bypass, class 0 at +5", f.check(f.group, classOf(0), policyT0+5))
		})
	}
}

func TestFoldsAreNotSlowed(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, viewSend, 10)
			f.post(f.group, f.phone, policyT0, classOf(0))
			wantPolicyNil(t, "class 1 at +5", f.check(f.group, classOf(1), policyT0+5))
		})
	}
}

func TestSlowModeCountsEveryDeviceOfTheUser(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, viewSend, 10)
			f.post(f.group, f.laptop, policyT0, classOf(0))
			// The next upload comes from the phone: the session's device does not matter, the user does.
			wantPolicySlowed(t, "class 0 at +5 after the other device's post", f.check(f.group, classOf(0), policyT0+5))
			wantPolicyNil(t, "class 0 at +10", f.check(f.group, classOf(0), policyT0+10))
		})
	}
}

func TestDirectMessagesAreUnchecked(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 10)
			dm := f.newGroup(0, nil)
			f.post(dm, f.phone, policyT0-1, classOf(0))
			wantPolicyNil(t, "a DM group, class 0, a post 1 s earlier", f.check(dm, classOf(0), policyT0))
		})
	}
}

func TestACallGroupIsUnchecked(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 10)
			cid := f.cid
			call := f.newGroup(1, &cid)
			wantPolicyNil(t, "a call group, no send, class 0", f.check(call, classOf(0), policyT0))
		})
	}
}

func TestAnAdministratorDoesNotWait(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 10)
			f.grant(api.PermAdministrator)
			f.post(f.group, f.phone, policyT0, classOf(0))
			wantPolicyNil(t, "an administrator, class 0 at +5", f.check(f.group, classOf(0), policyT0+5))
		})
	}
}

func TestALegacyUploadNeedsSend(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, api.PermViewChannel, 0)
			wantPolicyRefusal(t, "no send, a legacy upload", f.check(f.group, nil, policyT0), http.StatusForbidden, server.CodeForbidden)
			f.grant(api.PermSendMessages)
			wantPolicyNil(t, "a role with send, a legacy upload", f.check(f.group, nil, policyT0))
		})
	}
}

// slowReadRepo counts the slow-mode reads the policy makes.
type slowReadRepo struct {
	store.Repository
	reads atomic.Int32
}

func (r *slowReadRepo) LastClassZeroUploadAt(ctx context.Context, channelID, userID id.ID) (int64, error) {
	r.reads.Add(1)
	return r.Repository.LastClassZeroUploadAt(ctx, channelID, userID)
}

func TestALegacyUploadIsNotSlowed(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) {
			f := newPolicyFixture(t, repo, viewSend, 10)
			f.post(f.group, f.phone, policyT0, classOf(0))
			rec := &slowReadRepo{Repository: repo}
			p := api.PostPolicy{Repo: rec, Resolver: api.NewResolver(repo)}
			wantPolicyNil(t, "a legacy upload at +5", p.Check(context.Background(), f.group, f.user, nil, policyT0+5))
			if n := rec.reads.Load(); n != 0 {
				t.Fatalf("a legacy upload read LastClassZeroUploadAt %d times, want 0", n)
			}
			// Control: the same wrapper sees the read of a class-0 upload, which is slowed.
			wantPolicySlowed(t, "class 0 at +5", p.Check(context.Background(), f.group, f.user, classOf(0), policyT0+5))
			if n := rec.reads.Load(); n != 1 {
				t.Fatalf("a class-0 upload read LastClassZeroUploadAt %d times, want 1", n)
			}
		})
	}
}
