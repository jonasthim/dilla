package testkit_test

// dilla-web-1 task 17: `dilla-testkit web-driver`, the native peer of the browser tests, against an
// in-process instance wired as production wires it. Two driver processes enrol through the
// bootstrap invite, build a community through the public routes, meet in its channel's text group
// and exchange messages. Then one upload is relabelled in flight, so the delivery service records
// the other device as the uploader of a ciphertext it did not make, and the receiving driver must
// refuse it: the sender a browser test reads from `sync` is the MLS-authenticated one, never the
// delivery service's label (C22).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/testkit"
)

var hex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)

// driverWait bounds one answer and one polling loop. Generous on purpose: CI runs this package
// under the race detector on a 4-vCPU runner (lesson c); nothing here asserts a duration.
const driverWait = 90 * time.Second

// lockedBuffer collects a driver's stderr; exec's copier writes it while a failing test reads it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// webDriver is one `dilla-testkit web-driver` process: one JSON request per stdin line, one answer
// per stdout line, in order.
type webDriver struct {
	t      *testing.T
	name   string
	stdin  io.WriteCloser
	lines  chan string
	stderr *lockedBuffer
	next   int
}

func startWebDriver(t *testing.T, h *testkit.Harness, base, name string, seed uint64) *webDriver {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, os.Getenv("DILLA_TESTKIT"), "web-driver", "--ds", base, "--seed", fmt.Sprint(seed))
	cmd.Env = append(os.Environ(),
		"DILLA_TESTKIT_INVITE="+h.Invite(),
		"DILLA_TESTKIT_CONTROL="+h.ControlURL(),
	)
	stderr := &lockedBuffer{}
	cmd.Stderr = stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s: %v", name, err)
	}
	lines := make(chan string, 16)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	t.Cleanup(func() {
		defer cancel()
		_ = stdin.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
		if t.Failed() {
			t.Logf("%s stderr:\n%s", name, stderr.String())
		}
	})
	return &webDriver{t: t, name: name, stdin: stdin, lines: lines, stderr: stderr}
}

// call sends one request and returns its answer, whatever "ok" says.
func (d *webDriver) call(op string, fields map[string]any) map[string]any {
	d.t.Helper()
	d.next++
	req := map[string]any{"id": d.next, "op": op}
	for k, v := range fields {
		req[k] = v
	}
	line, err := json.Marshal(req)
	if err != nil {
		d.t.Fatal(err)
	}
	if _, err := d.stdin.Write(append(line, '\n')); err != nil {
		d.t.Fatalf("%s %s: write: %v", d.name, op, err)
	}
	select {
	case got, open := <-d.lines:
		if !open {
			d.t.Fatalf("%s exited before answering %s:\n%s", d.name, op, d.stderr.String())
		}
		var answer map[string]any
		if err := json.Unmarshal([]byte(got), &answer); err != nil {
			d.t.Fatalf("%s %s: not JSON: %q", d.name, op, got)
		}
		if answer["id"] != float64(d.next) {
			d.t.Fatalf("%s %s: the answer %v carries another id", d.name, op, answer)
		}
		return answer
	case <-time.After(driverWait):
		d.t.Fatalf("%s did not answer %s within %v:\n%s", d.name, op, driverWait, d.stderr.String())
	}
	return nil
}

// ok is call for an op that must succeed.
func (d *webDriver) ok(op string, fields map[string]any) map[string]any {
	d.t.Helper()
	a := d.call(op, fields)
	if a["ok"] != true {
		d.t.Fatalf("%s %s refused: %v", d.name, op, a["error"])
	}
	return a
}

// waitFor syncs until a message with body arrives and returns it.
func (d *webDriver) waitFor(body string) map[string]any {
	d.t.Helper()
	deadline := time.Now().Add(driverWait)
	for {
		for _, item := range d.ok("sync", nil)["received"].([]any) {
			if m := item.(map[string]any); m["body"] == body {
				return m
			}
		}
		if time.Now().After(deadline) {
			d.t.Fatalf("%s never received %q within %v", d.name, body, driverWait)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// relabelProxy relays every request to the instance unchanged, except that once armed it sends
// the next POST /v1/groups/{id}/message with another device's bearer. httputil.ReverseProxy also
// relays the gateway's WebSocket upgrade, so a driver can live entirely behind it.
type relabelProxy struct {
	mu    sync.Mutex
	token string
	srv   *httptest.Server
}

func newRelabelProxy(t *testing.T, target string) *relabelProxy {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	relay := httputil.NewSingleHostReverseProxy(u)
	p := &relabelProxy{}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/v1/groups/") &&
			strings.HasSuffix(r.URL.Path, "/message") {
			p.mu.Lock()
			token := p.token
			p.token = ""
			p.mu.Unlock()
			if token != "" {
				r.Header.Set("Authorization", "Bearer "+token)
			}
		}
		relay.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		p.srv.CloseClientConnections()
		p.srv.Close()
	})
	return p
}

func (p *relabelProxy) arm(token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.token = token
}

func (p *relabelProxy) armed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.token != ""
}

func mustID(t *testing.T, v any) id.ID {
	t.Helper()
	s, _ := v.(string)
	if !hex32.MatchString(s) {
		t.Fatalf("%v is not 32 lowercase hex", v)
	}
	parsed, err := id.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestTheWebDriverPeersExchangeMessagesUnderTheProductionACL(t *testing.T) {
	h := testkit.Start(t, testkit.Options{DataDir: t.TempDir(), ProductionACL: true})
	t.Cleanup(h.Stop)
	ctx := context.Background()
	repo := h.Repo()

	proxy := newRelabelProxy(t, h.BaseURL())
	alice := startWebDriver(t, h, proxy.srv.URL, "alice", 0xa11ce)
	bob := startWebDriver(t, h, h.BaseURL(), "bob", 0xb0b)

	// setup: an account, a device list, KeyPackages, a community, a channel and an invite, all
	// through the public routes, read back from the instance's own store.
	sa := alice.ok("setup", map[string]any{"community": "web driver", "channel": "general"})
	if sa["username"] != "peer0a11ce" || sa["display"] != "peer0a11ce" {
		t.Fatalf("setup answered username %v display %v, want peer0a11ce twice", sa["username"], sa["display"])
	}
	aliceUser, aliceDev := mustID(t, sa["user_id"]), mustID(t, sa["device_id"])
	community, channel := mustID(t, sa["community_id"]), mustID(t, sa["channel_id"])
	if code, _ := sa["invite_code"].(string); code == "" {
		t.Fatalf("setup answered no invite_code: %v", sa)
	}
	c, err := repo.GetCommunity(ctx, community)
	if err != nil || c.Owner != aliceUser || c.Name != "web driver" {
		t.Fatalf("community row = %+v, %v; want owner %s named \"web driver\"", c, err, aliceUser)
	}
	ch, err := repo.GetChannel(ctx, channel)
	if err != nil || ch.CommunityID == nil || *ch.CommunityID != community || ch.Kind != api.ChannelText ||
		ch.Mode != 0 || ch.Visibility != 0 || ch.Name != "general" {
		t.Fatalf("channel row = %+v, %v; want an e2ee private text channel \"general\" of %s", ch, err, community)
	}
	dev, err := repo.GetDevice(ctx, aliceDev)
	if err != nil || dev.UserID != aliceUser || dev.Tier != 0 {
		t.Fatalf("device row = %+v, %v; want a native-tier device of %s", dev, err, aliceUser)
	}
	if n, err := repo.CountKeyPackages(ctx, aliceDev, time.Now().Unix()); err != nil || n != 32 {
		t.Fatalf("KeyPackages of alice's device = %d, %v; want 32", n, err)
	}

	// register: the channel's text group, under the production registration ACL.
	ra := alice.ok("register", nil)
	group := mustID(t, ra["group_id"])
	if ra["epoch"] != float64(0) {
		t.Fatalf("register answered epoch %v, want 0", ra["epoch"])
	}
	groups, err := repo.GroupsForTarget(ctx, channel, api.GroupText)
	if err != nil || len(groups) != 1 || groups[0].GroupID != group {
		t.Fatalf("open text groups of the channel = %v, %v; want exactly %s", groups, err, group)
	}

	// join: a second peer enters the community with its invite and the group by external commit.
	sb := bob.ok("setup", map[string]any{"community": "bob's own", "channel": "elsewhere"})
	bobUser, bobDev := mustID(t, sb["user_id"]), mustID(t, sb["device_id"])
	jb := bob.ok("join", map[string]any{
		"community_id": sa["community_id"], "channel_id": sa["channel_id"],
		"group_id": ra["group_id"], "invite_code": sa["invite_code"],
	})
	if jb["group_id"] != ra["group_id"] || jb["epoch"] != float64(1) {
		t.Fatalf("join answered %v, want group %v at epoch 1", jb, ra["group_id"])
	}
	if _, err := repo.GetMember(ctx, community, bobUser); err != nil {
		t.Fatalf("bob is not a member of alice's community after join: %v", err)
	}

	// members: alice applies bob's external commit and sees both devices.
	deadline := time.Now().Add(driverWait)
	for {
		devices := alice.ok("members", nil)["devices"].([]any)
		if len(devices) == 2 && slices.Contains(devices, sa["device_id"]) && slices.Contains(devices, sb["device_id"]) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("alice's roster never held both devices: %v", devices)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if s := alice.ok("sync", nil); s["epoch"] != float64(1) || s["members"] != float64(2) {
		t.Fatalf("alice's sync after the join = %v, want epoch 1 with 2 members", s)
	}

	// send and sync, both ways: the sender is the MLS credential's, with its user and tier.
	sent := alice.ok("send", map[string]any{"body": "hello from alice"})
	if seq, _ := sent["seq"].(float64); seq < 1 {
		t.Fatalf("send answered seq %v", sent["seq"])
	}
	got := bob.waitFor("hello from alice")
	if got["seq"] != sent["seq"] || got["sender_user"] != sa["user_id"] || got["sender_device"] != sa["device_id"] || got["tier"] != float64(0) {
		t.Fatalf("bob received %v; want seq %v from alice's user and device at tier 0", got, sent["seq"])
	}
	bob.ok("send", map[string]any{"body": "hello from bob"})
	back := alice.waitFor("hello from bob")
	if back["sender_user"] != sb["user_id"] || back["sender_device"] != sb["device_id"] || back["tier"] != float64(0) {
		t.Fatalf("alice received %v; want bob's user and device at tier 0", back)
	}

	// The relabelled upload: alice's ciphertext reaches the delivery service under bob's session.
	bobRow, err := repo.GetDevice(ctx, bobDev)
	if err != nil {
		t.Fatal(err)
	}
	token, err := h.Server().Sessions().NewDeviceSession(ctx, repo, bobRow.UserID, bobRow.ID, bobRow.Tier)
	if err != nil {
		t.Fatalf("a session for bob's device: %v", err)
	}
	proxy.arm(token.Token)
	relabelled := alice.ok("send", map[string]any{"body": "relabelled in flight"})
	if proxy.armed() {
		t.Fatal("the proxy never saw alice's upload, so nothing was relabelled")
	}
	want := fmt.Sprintf("the MLS sender %s is not the uploader %s", aliceDev, bobDev)
	deadline = time.Now().Add(driverWait)
	for {
		a := bob.call("sync", nil)
		if a["ok"] == false {
			if msg := fmt.Sprint(a["error"]); !strings.Contains(msg, want) {
				t.Fatalf("bob's sync failed for another reason: %s (want it to contain %q)", msg, want)
			}
			break
		}
		if items := a["received"].([]any); len(items) > 0 {
			t.Fatalf("bob accepted a message whose MLS sender (alice) is not its uploader of record (bob): %v", items)
		}
		if time.Now().After(deadline) {
			t.Fatalf("bob never saw the relabelled upload (seq %v) within %v", relabelled["seq"], driverWait)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// waitRoster asks d for its roster until it holds exactly want; with commit set it first runs `sync`,
// which commits any outstanding instance proposal (the Remove a revocation proposes).
func waitRoster(t *testing.T, d *webDriver, commit bool, want ...string) {
	t.Helper()
	deadline := time.Now().Add(driverWait)
	for {
		if commit {
			d.ok("sync", nil)
		}
		got := d.ok("members", nil)["devices"].([]any)
		match := len(got) == len(want)
		for _, w := range want {
			match = match && slices.Contains(got, any(w))
		}
		if match {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s's roster is %v, want exactly %v", d.name, got, want)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// waitForDM runs sync_dm on channel until a message with body arrives and returns it.
func (d *webDriver) waitForDM(channel any, body string) map[string]any {
	d.t.Helper()
	deadline := time.Now().Add(driverWait)
	for {
		for _, item := range d.ok("sync_dm", map[string]any{"channel_id": channel})["received"].([]any) {
			if m := item.(map[string]any); m["body"] == body {
				return m
			}
		}
		if time.Now().After(deadline) {
			d.t.Fatalf("%s never received %q in DM %v within %v", d.name, body, channel, driverWait)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// dilla-web-2a task 9: the peer enrols a second device with its password and its SSK, revokes it, and
// opens a DM that another peer joins by its Welcome, all against the production wiring.
func TestTheWebDriverPeerEnrolsRevokesAndOpensDMs(t *testing.T) {
	h := testkit.Start(t, testkit.Options{DataDir: t.TempDir(), ProductionACL: true})
	t.Cleanup(h.Stop)
	ctx := context.Background()
	repo := h.Repo()
	alice := startWebDriver(t, h, h.BaseURL(), "alice", 0xa11ce2)
	bob := startWebDriver(t, h, h.BaseURL(), "bob", 0xb0b2)

	// setup: a password and three channels, each with its registered text group.
	sa := alice.ok("setup", map[string]any{"community": "enrol", "channel": "general",
		"password": "correct horse battery staple", "channels": 3})
	aliceUser := mustID(t, sa["user_id"])
	ids, _ := sa["channel_ids"].([]any)
	if len(ids) != 3 || ids[0] != sa["channel_id"] {
		t.Fatalf("setup answered channel_ids %v with channel_id %v; want three, the first being channel_id", ids, sa["channel_id"])
	}
	var firstGroup id.ID
	for i, v := range ids {
		ch := mustID(t, v)
		row, err := repo.GetChannel(ctx, ch)
		want := "general"
		if i > 0 {
			want = fmt.Sprintf("general-%d", i+1)
		}
		if err != nil || row.Name != want {
			t.Fatalf("channel %d = %+v, %v; want it named %q", i, row, err, want)
		}
		groups, err := repo.GroupsForTarget(ctx, ch, api.GroupText)
		if err != nil || len(groups) != 1 {
			t.Fatalf("text groups of channel %d = %v, %v; want exactly one, registered by setup", i, groups, err)
		}
		if i == 0 {
			firstGroup = groups[0].GroupID
		}
	}
	if phc, err := repo.GetPasswordCredential(ctx, aliceUser); err != nil || phc == "" {
		t.Fatalf("alice's password credential = %q, %v; want one stored", phc, err)
	}
	ra := alice.ok("register", nil)
	if mustID(t, ra["group_id"]) != firstGroup || ra["epoch"] != float64(0) {
		t.Fatalf("register after setup{channels: 3} answered %v; want the first channel's group %s at epoch 0", ra, firstGroup)
	}

	// A peer set up without a password cannot enrol.
	sb := bob.ok("setup", map[string]any{"community": "bob's own", "channel": "elsewhere"})
	bobUser := mustID(t, sb["user_id"])
	if a := bob.call("enrol", nil); a["ok"] != false || !strings.Contains(fmt.Sprint(a["error"]), "enrol needs setup with a password") {
		t.Fatalf("enrol without a password answered %v", a)
	}

	// bob joins alice's first channel: two leaves.
	bob.ok("join", map[string]any{"community_id": sa["community_id"], "channel_id": sa["channel_id"],
		"group_id": ra["group_id"], "invite_code": sa["invite_code"]})
	waitRoster(t, alice, false, sa["device_id"].(string), sb["device_id"].(string))

	// members takes the channel it addresses: bob joined the first channel only, so channel 3's group
	// holds alice alone (the instance's Add of bob there is a proposal nobody committed; members never
	// commits). A driver that ignored channel_id would answer the first channel's two devices.
	if got := alice.ok("members", map[string]any{"channel_id": ids[2]})["devices"].([]any); len(got) != 1 || got[0] != sa["device_id"] {
		t.Fatalf("members of channel 3: got %d devices, want 1 (%v)", len(got), got)
	}
	if got := alice.ok("members", nil)["devices"].([]any); len(got) != 2 {
		t.Fatalf("members of the first channel: got %d devices, want 2 (%v)", len(got), got)
	}

	// enrol: pending first, enrolled after the PUT, the third leaf in the group.
	en := alice.ok("enrol", nil)
	enrolDev := mustID(t, en["device_id"])
	if en["version"] != float64(2) || fmt.Sprint(en["scopes"]) != "[1 0]" {
		t.Fatalf("enrol answered %v; want version 2 and scopes [1 0] (a pending session, then an enrolled one)", en)
	}
	if epoch, _ := en["epoch"].(float64); epoch < 2 {
		t.Fatalf("enrol answered epoch %v; the external join must land above the two-member epoch", en["epoch"])
	}
	dev, err := repo.GetDevice(ctx, enrolDev)
	if err != nil || dev.UserID != aliceUser || dev.Tier != 1 || dev.SignerTier != 1 || dev.RevokedAt != nil {
		t.Fatalf("the enrolled device row = %+v, %v; want a live browser-tier (1) device of alice", dev, err)
	}
	if list, err := repo.GetDeviceList(ctx, aliceUser); err != nil || list.Version != 2 {
		t.Fatalf("alice's newest device list = %+v, %v; want version 2", list, err)
	}
	if n, err := repo.CountSessionsByDevice(ctx, enrolDev); err != nil || n != 2 {
		t.Fatalf("sessions of the enrolled device = %d, %v; want 2 (the pending one and the enrolled one)", n, err)
	}
	waitRoster(t, alice, false, sa["device_id"].(string), sb["device_id"].(string), en["device_id"].(string))

	// revoke: the row is revoked, its sessions are gone, and its leaf leaves after alice's next commit.
	rv := alice.ok("revoke", map[string]any{"device_id": en["device_id"]})
	if rv["version"] != float64(3) {
		t.Fatalf("revoke answered %v; want version 3", rv)
	}
	if dev, err := repo.GetDevice(ctx, enrolDev); err != nil || dev.RevokedAt == nil {
		t.Fatalf("the revoked device row = %+v, %v; want revoked_at set", dev, err)
	}
	if n, err := repo.CountSessionsByDevice(ctx, enrolDev); err != nil || n != 0 {
		t.Fatalf("sessions of the revoked device = %d, %v; want 0", n, err)
	}
	if list, err := repo.GetDeviceList(ctx, aliceUser); err != nil || list.Version != 3 {
		t.Fatalf("alice's newest device list = %+v, %v; want version 3", list, err)
	}
	waitRoster(t, alice, true, sa["device_id"].(string), sb["device_id"].(string))
	if a := alice.call("revoke", map[string]any{"device_id": en["device_id"]}); a["ok"] != false ||
		!strings.Contains(fmt.Sprint(a["error"]), "device_id is not an unrevoked entry of the device list") {
		t.Fatalf("a second revoke of the same device answered %v", a)
	}

	// DMs: alice opens one and registers its group; bob joins by the Welcome of alice's commit.
	od := alice.ok("open_dm", map[string]any{"user_id": sb["user_id"]})
	dmCh, dmGroup := mustID(t, od["channel_id"]), mustID(t, od["group_id"])
	if dmCh != api.DMChannelID([]id.ID{aliceUser, bobUser}) || od["created"] != true || od["epoch"] != float64(0) {
		t.Fatalf("open_dm answered %v; want the derived 1:1 channel, created, epoch 0", od)
	}
	if ch, err := repo.GetChannel(ctx, dmCh); err != nil || ch.CommunityID != nil || ch.Kind != api.ChannelDM {
		t.Fatalf("the DM channel row = %+v, %v; want kind 3 with no community", ch, err)
	}
	if groups, err := repo.GroupsForTarget(ctx, dmCh, api.GroupText); err != nil || len(groups) != 1 || groups[0].GroupID != dmGroup {
		t.Fatalf("text groups of the DM = %v, %v; want exactly %s", groups, err, dmGroup)
	}
	deadline := time.Now().Add(driverWait)
	for joined := false; !joined; {
		alice.ok("sync_dm", map[string]any{"channel_id": od["channel_id"]})
		for _, item := range bob.ok("dms", nil)["dms"].([]any) {
			m := item.(map[string]any)
			if m["channel_id"] != od["channel_id"] {
				continue
			}
			if m["group_id"] != od["group_id"] {
				t.Fatalf("bob holds DM %v in group %v; want %v", m["channel_id"], m["group_id"], od["group_id"])
			}
			if epoch, _ := m["epoch"].(float64); epoch < 1 {
				t.Fatalf("bob joined the DM at epoch %v; a Welcome lands at 1 or above", m["epoch"])
			}
			joined = true
		}
		if !joined && time.Now().After(deadline) {
			t.Fatalf("bob never joined the DM within %v", driverWait)
		}
		if !joined {
			time.Sleep(100 * time.Millisecond)
		}
	}
	sent := alice.ok("send_dm", map[string]any{"channel_id": od["channel_id"], "body": "dm from alice"})
	got := bob.waitForDM(od["channel_id"], "dm from alice")
	if got["seq"] != sent["seq"] || got["sender_user"] != sa["user_id"] || got["sender_device"] != sa["device_id"] {
		t.Fatalf("bob received %v; want seq %v from alice's user and device", got, sent["seq"])
	}
	bob.ok("send_dm", map[string]any{"channel_id": od["channel_id"], "body": "dm from bob"})
	back := alice.waitForDM(od["channel_id"], "dm from bob")
	if back["sender_user"] != sb["user_id"] || back["sender_device"] != sb["device_id"] {
		t.Fatalf("alice received %v; want bob's user and device", back)
	}
	again := alice.ok("open_dm", map[string]any{"user_id": sb["user_id"]})
	if again["channel_id"] != od["channel_id"] || again["group_id"] != od["group_id"] || again["created"] != false {
		t.Fatalf("a second open_dm answered %v; want the same DM and group, not created", again)
	}
}
