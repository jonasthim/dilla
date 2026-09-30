package api_test

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func channelEnv(t *testing.T) (*env, id.ID, string) {
	t.Helper()
	e := newEnv(t)
	log := slog.New(slog.DiscardHandler)
	api.NewCommunities(e.Repo, e.DS, e.Clk, log).Register(e.Mux)
	api.NewChannels(e.Repo, e.DS, e.Clk, 10, log).Register(e.Mux)
	_, tok := e.NewUser("owner")
	return e, createCommunity(t, e, tok), tok
}

// newChannel posts one channel and returns its id and the decoded mode.
func newChannel(t *testing.T, e *env, cid id.ID, tok string, kind, mode, vis uint64, name string) (id.ID, uint64, int) {
	t.Helper()
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{kind, mode, vis, nil, name, "", uint64(0), uint64(0)})
	if status != http.StatusCreated {
		return id.ID{}, 0, status
	}
	var out []cbor.RawMessage
	if err := cborx.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	var chID id.ID
	var gotMode uint64
	mustUnmarshal(t, out[0], &chID)
	mustUnmarshal(t, out[1], &gotMode)
	return chID, gotMode, status
}

// mustUnmarshalBody is mustUnmarshal over a whole response body.
func mustUnmarshalBody(t *testing.T, body []byte, v any) {
	t.Helper()
	mustUnmarshal(t, body, v)
}

func TestInviteAndDiscoverableChannelsAreForcedReadable(t *testing.T) {
	e, cid, tok := channelEnv(t)
	for _, vis := range []uint64{1, 2} { // invite, discoverable
		chID, mode, status := newChannel(t, e, cid, tok, 0, 0 /* asks for e2ee */, vis, "public")
		if status != http.StatusCreated {
			t.Fatalf("visibility %d: status %d", vis, status)
		}
		if mode != 1 {
			t.Fatalf("visibility %d: mode = %d, want 1 (readable)", vis, mode)
		}
		row, err := e.Repo.GetChannel(t.Context(), chID)
		if err != nil {
			t.Fatalf("GetChannel: %v", err)
		}
		if row.Mode != api.ModeReadable {
			t.Fatalf("stored mode = %d", row.Mode)
		}
	}
}

// I3 (fix wave): a channel that stops being end-to-end encrypted is never allowed an MLS text
// group (spec, trust boundaries; protocol/01). A PATCH to mode=readable, or to a visibility that
// forces it, closes the channel's open text group after the commit, and the ACL admits nobody to
// a text group whose channel carries none, so no Add or join lands in it. A voice channel's call
// group is not a text group and survives a visibility change.
func TestLeavingEndToEndEncryptionClosesTheTextGroup(t *testing.T) {
	for _, c := range []struct {
		name  string
		patch []any
	}{
		{"mode=readable", []any{nil, nil, uint64(1), nil, nil, nil, nil}},
		{"visibility=discoverable", []any{nil, nil, nil, uint64(2), nil, nil, nil}},
	} {
		t.Run(c.name, func(t *testing.T) {
			e, cid, tok := channelEnv(t)
			ch, _, _ := newChannel(t, e, cid, tok, 0, 0, 0, "secret")
			group := seedTextGroup(t, e, ch, cid)
			owner := e.sess[tok].UserID
			seedMember(t, e, group, owner, 0)
			if ok, err := (api.ResolverACL{Repo: e.Repo}).Eligible(t.Context(), group, owner); err != nil || !ok {
				t.Fatalf("before the PATCH the owner is eligible = %v, %v; want true", ok, err)
			}
			if status, body := e.Do(http.MethodPatch, "/v1/channels/"+ch.String(), tok, c.patch); status != http.StatusNoContent {
				t.Fatalf("PATCH %s = %d (%x)", c.name, status, body)
			}
			if closed := e.DS.closed(); len(closed) != 1 || closed[0] != group {
				t.Fatalf("closed groups = %v, want the text group %s", closed, group)
			}
			if ok, err := (api.ResolverACL{Repo: e.Repo}).Eligible(t.Context(), group, owner); err != nil || ok {
				t.Fatalf("after the PATCH the owner is eligible for the text group = %v, %v; want false", ok, err)
			}
		})
	}

	e, cid, tok := channelEnv(t)
	voice, _, _ := newChannel(t, e, cid, tok, 1, 0, 0, "call")
	seedGroupOfKind(t, e, voice, cid, 1)
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+voice.String(), tok,
		[]any{nil, nil, nil, uint64(2), nil, nil, nil}); status != http.StatusNoContent {
		t.Fatal("PATCH of the voice channel's visibility failed")
	}
	if closed := e.DS.closed(); len(closed) != 0 {
		t.Fatalf("a voice channel's visibility change closed %v, want its call group left open", closed)
	}
}

func TestPatchToE2EEOnAVisibleChannelIsRefused(t *testing.T) {
	e, cid, tok := channelEnv(t)
	chID, _, _ := newChannel(t, e, cid, tok, 0, 1, 2, "public")
	status, body := e.Do(http.MethodPatch, "/v1/channels/"+chID.String(), tok,
		[]any{nil, nil, uint64(0) /* e2ee */, nil, nil, nil, nil})
	if status != http.StatusBadRequest {
		t.Fatalf("PATCH mode=e2ee = %d, want 400", status)
	}
	if code := e.ErrCode(body); code != "E_INVALID_REQUEST" {
		t.Fatalf("code = %s", code)
	}

	// The same PATCH is accepted once the channel is private again, and both
	// changes may not be made in one request either, because the order would
	// decide the outcome.
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+chID.String(), tok,
		[]any{nil, nil, uint64(0), uint64(0), nil, nil, nil}); status != http.StatusBadRequest {
		t.Fatalf("combined PATCH = %d, want 400", status)
	}
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+chID.String(), tok,
		[]any{nil, nil, nil, uint64(0), nil, nil, nil}); status != http.StatusNoContent {
		t.Fatalf("PATCH visibility=private failed")
	}
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+chID.String(), tok,
		[]any{nil, nil, uint64(0), nil, nil, nil, nil}); status != http.StatusNoContent {
		t.Fatalf("PATCH mode=e2ee after going private failed")
	}
}

func TestACategoryMayNotHaveAParent(t *testing.T) {
	e, cid, tok := channelEnv(t)
	parent, _, _ := newChannel(t, e, cid, tok, 2, 1, 0, "cat")
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{uint64(2), uint64(1), uint64(0), parent, "nested", "", uint64(0), uint64(0)})
	if status != http.StatusBadRequest {
		t.Fatalf("nested category = %d, want 400", status)
	}
	if code := e.ErrCode(body); code != "E_INVALID_REQUEST" {
		t.Fatalf("code = %s", code)
	}

	// A text channel under that category is fine; a text channel under a text
	// channel is not.
	text, _, _ := newChannel(t, e, cid, tok, 0, 1, 0, "general")
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+text.String(), tok,
		[]any{nil, nil, nil, nil, parent, nil, nil}); status != http.StatusNoContent {
		t.Fatalf("reparent under a category failed")
	}
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{uint64(0), uint64(1), uint64(0), text, "bad", "", uint64(0), uint64(0)}); status != http.StatusBadRequest {
		t.Fatalf("text under text = %d, want 400", status)
	}
}

func TestAPositionChangeMovesTheChannel(t *testing.T) {
	e, cid, tok := channelEnv(t)
	// Three channels at distinct positions, so the assertion is about position
	// and not about the id tie-break.
	var ids []id.ID
	for i, n := range []string{"c", "a", "b"} {
		status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
			[]any{uint64(0), uint64(1), uint64(0), nil, n, "", uint64(10 * (i + 1)), uint64(0)})
		if status != http.StatusCreated {
			t.Fatalf("POST channel %s = %d (%x)", n, status, body)
		}
		var out []cbor.RawMessage
		mustUnmarshalBody(t, body, &out)
		var chID id.ID
		mustUnmarshal(t, out[0], &chID)
		ids = append(ids, chID)
	}
	rows, err := e.Repo.ListChannels(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(rows) != 3 || rows[0].ID != ids[0] || rows[1].ID != ids[1] || rows[2].ID != ids[2] {
		t.Fatalf("initial order = %+v, want positions 10, 20, 30", rows)
	}
	// Move the last one in front of the first: a real reorder, not a no-op.
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+ids[2].String(), tok,
		[]any{nil, nil, nil, nil, nil, uint64(5), nil}); status != http.StatusNoContent {
		t.Fatal("PATCH position failed")
	}
	again, err := e.Repo.ListChannels(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if again[0].ID != ids[2] {
		t.Fatalf("the reordered channel did not move to the front: %+v", again)
	}
}

func TestEqualPositionsBreakOnID(t *testing.T) {
	e, cid, tok := channelEnv(t)
	// Both created at position 0; ties break on id, so the listing is
	// deterministic across runs and across engines.
	a, _, _ := newChannel(t, e, cid, tok, 0, 1, 0, "a")
	b, _, _ := newChannel(t, e, cid, tok, 0, 1, 0, "b")
	_, _ = a, b
	rows, err := e.Repo.ListChannels(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("channels = %d", len(rows))
	}
	if rows[0].Position != rows[1].Position {
		t.Fatalf("both channels should be at position 0: %+v", rows)
	}
	if string(rows[0].ID[:]) >= string(rows[1].ID[:]) {
		t.Fatalf("not ordered by id within a position: %x then %x", rows[0].ID, rows[1].ID)
	}
	for range 4 {
		again, _ := e.Repo.ListChannels(t.Context(), cid)
		if again[0].ID != rows[0].ID || again[1].ID != rows[1].ID {
			t.Fatal("ListChannels is not deterministic for equal positions")
		}
	}
}

func TestAVoiceChannelIsCreatedInAReadableCommunity(t *testing.T) {
	e, cid, tok := channelEnv(t)
	// Every text channel readable; the voice channel is still created and its
	// calls get a call group (kind 1), which protocol/01 requires regardless of
	// the community's text mode.
	chID, mode, status := newChannel(t, e, cid, tok, 1 /* voice */, 1, 2, "Allmänt")
	if status != http.StatusCreated {
		t.Fatalf("voice channel = %d", status)
	}
	if mode != 1 {
		t.Fatalf("voice channel mode = %d", mode)
	}
	row, err := e.Repo.GetChannel(t.Context(), chID)
	if err != nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if row.Kind != api.ChannelVoice {
		t.Fatalf("kind = %d", row.Kind)
	}
	// The channel's mode never reaches a call group: task 16 mints the call
	// group with kind 1 and the DS refuses only kind 0 on a readable channel.
	if api.TextGroupAllowed(row) {
		t.Fatal("a readable channel must not allow an MLS text group")
	}
	if !api.CallGroupAllowed(row) {
		t.Fatal("a voice channel must always allow a call group")
	}
}

func TestDeleteCommunityTombstonesChannels(t *testing.T) {
	e, cid, tok := channelEnv(t)
	chID, _, _ := newChannel(t, e, cid, tok, 0, 1, 0, "general")
	if status, _ := e.Do(http.MethodDelete, "/v1/communities/"+cid.String(), tok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE community failed")
	}
	if _, err := e.Repo.GetChannel(t.Context(), chID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("GetChannel after community delete = %v, want ErrNotFound", err)
	}
}

// ---------------------------------------------------------------- beyond the brief

// A text channel that is private and end-to-end encrypted is the one channel an
// MLS text group may be registered for; everything else about the two predicates
// follows from protocol/01's group-kind table.
func TestTheGroupPredicatesFollowTheKindTable(t *testing.T) {
	deleted := int64(1)
	for _, c := range []struct {
		name       string
		row        store.ChannelRow
		text, call bool
	}{
		{"private e2ee text", store.ChannelRow{Kind: api.ChannelText, Mode: api.ModeE2EE}, true, false},
		{"readable text", store.ChannelRow{Kind: api.ChannelText, Mode: api.ModeReadable}, false, false},
		{"e2ee voice", store.ChannelRow{Kind: api.ChannelVoice, Mode: api.ModeE2EE}, false, true},
		{"category", store.ChannelRow{Kind: api.ChannelCategory, Mode: api.ModeE2EE}, false, false},
		{"dm", store.ChannelRow{Kind: api.ChannelDM, Mode: api.ModeE2EE}, true, true},
		{"group dm", store.ChannelRow{Kind: api.ChannelGroupDM, Mode: api.ModeE2EE}, true, true},
		{"deleted text", store.ChannelRow{Kind: api.ChannelText, DeletedAt: &deleted}, false, false},
		{"deleted voice", store.ChannelRow{Kind: api.ChannelVoice, DeletedAt: &deleted}, false, false},
	} {
		if got := api.TextGroupAllowed(c.row); got != c.text {
			t.Errorf("%s: TextGroupAllowed = %v, want %v", c.name, got, c.text)
		}
		if got := api.CallGroupAllowed(c.row); got != c.call {
			t.Errorf("%s: CallGroupAllowed = %v, want %v", c.name, got, c.call)
		}
	}
}

// GET /v1/channels/{id} is the eleven-element channel document; a non-member
// is told the channel does not exist, and only the owner may change it.
func TestChannelReadAndManageGates(t *testing.T) {
	e, cid, tok := channelEnv(t)
	chID, _, _ := newChannel(t, e, cid, tok, 0, 0, 0, "general")

	status, body := e.Do(http.MethodGet, "/v1/channels/"+chID.String(), tok, nil)
	if status != http.StatusOK {
		t.Fatalf("GET channel = %d (%x)", status, body)
	}
	var doc []cbor.RawMessage
	mustUnmarshalBody(t, body, &doc)
	if len(doc) != 11 {
		t.Fatalf("channel document has %d elements, want 11", len(doc))
	}
	var gotID, gotCommunity id.ID
	var name string
	mustUnmarshal(t, doc[0], &gotID)
	mustUnmarshal(t, doc[1], &gotCommunity)
	mustUnmarshal(t, doc[6], &name)
	if gotID != chID || gotCommunity != cid || name != "general" {
		t.Fatalf("channel document = %v/%v/%q", gotID, gotCommunity, name)
	}

	// A stranger: 404 on every route, never 403, so the id reveals nothing.
	_, stranger := e.NewUser("stranger")
	for _, req := range []struct {
		method string
		body   any
	}{
		{http.MethodGet, nil},
		{http.MethodPatch, []any{"x", nil, nil, nil, nil, nil, nil}},
		{http.MethodDelete, nil},
	} {
		status, body := e.Do(req.method, "/v1/channels/"+chID.String(), stranger, req.body)
		if status != http.StatusNotFound || e.ErrCode(body) != "E_NOT_FOUND" {
			t.Fatalf("stranger %s = %d, want 404 E_NOT_FOUND", req.method, status)
		}
	}
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", stranger,
		[]any{uint64(0), uint64(0), uint64(0), nil, "x", "", uint64(0), uint64(0)}); status != http.StatusNotFound {
		t.Fatalf("stranger POST channel = %d, want 404", status)
	}

	// A member who is not the owner reads, and may not manage.
	memberID, member := e.NewUser("member")
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", member, []any{nil}); status != http.StatusOK {
		t.Fatalf("join = %d", status)
	}
	if _, err := e.Repo.GetMember(t.Context(), cid, memberID); err != nil {
		t.Fatalf("the member did not join: %v", err)
	}
	if status, _ := e.Do(http.MethodGet, "/v1/channels/"+chID.String(), member, nil); status != http.StatusOK {
		t.Fatalf("member GET = %d, want 200", status)
	}
	for _, req := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPatch, "/v1/channels/" + chID.String(), []any{"x", nil, nil, nil, nil, nil, nil}},
		{http.MethodDelete, "/v1/channels/" + chID.String(), nil},
		{http.MethodPost, "/v1/communities/" + cid.String() + "/channels",
			[]any{uint64(0), uint64(0), uint64(0), nil, "x", "", uint64(0), uint64(0)}},
	} {
		status, body := e.Do(req.method, req.path, member, req.body)
		if status != http.StatusForbidden || e.ErrCode(body) != "E_FORBIDDEN" {
			t.Fatalf("member %s %s = %d, want 403 E_FORBIDDEN", req.method, req.path, status)
		}
	}

	// No session at all.
	if status, _ := e.Do(http.MethodGet, "/v1/channels/"+chID.String(), "", nil); status != http.StatusUnauthorized {
		t.Fatalf("anonymous GET = %d, want 401", status)
	}
}

// Every bounded field is refused past its bound, with E_INVALID_REQUEST.
func TestChannelFieldBounds(t *testing.T) {
	e, cid, tok := channelEnv(t)
	post := func(kind, mode, vis uint64, name, topic string, position, slowmode uint64) int {
		status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
			[]any{kind, mode, vis, nil, name, topic, position, slowmode})
		return status
	}
	for _, c := range []struct {
		name   string
		status int
	}{
		{name: "empty name", status: post(0, 0, 0, "", "", 0, 0)},
		{name: "long name", status: post(0, 0, 0, strings.Repeat("n", 101), "", 0, 0)},
		{name: "control character in name", status: post(0, 0, 0, "a\x00b", "", 0, 0)},
		{name: "non-UTF-8 name", status: post(0, 0, 0, "a\xffb", "", 0, 0)},
		{name: "long topic", status: post(0, 0, 0, "ok", strings.Repeat("t", 1025), 0, 0)},
		{name: "NUL in topic", status: post(0, 0, 0, "ok", "a\x00b", 0, 0)},
		{name: "slowmode past six hours", status: post(0, 0, 0, "ok", "", 0, 21601)},
		{name: "position past the bound", status: post(0, 0, 0, "ok", "", 1<<31, 0)},
		{name: "unknown kind", status: post(5, 0, 0, "ok", "", 0, 0)},
		{name: "a DM through the community route", status: post(3, 0, 0, "ok", "", 0, 0)},
		{name: "a group DM through the community route", status: post(4, 0, 0, "ok", "", 0, 0)},
		{name: "unknown mode", status: post(0, 2, 0, "ok", "", 0, 0)},
		{name: "unknown visibility", status: post(0, 0, 3, "ok", "", 0, 0)},
	} {
		if c.status != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", c.name, c.status)
		}
	}
	// The bounds themselves are legal, and a topic may carry line breaks.
	if status := post(0, 0, 0, strings.Repeat("n", 100), "line one\nline two", 1<<31-1, 21600); status != http.StatusCreated {
		t.Fatalf("a channel at every bound = %d, want 201", status)
	}
}

// Deleting a category leaves its channels in place at the top level, and a
// channel moves to the top level by naming the all-zero parent.
func TestCategoryDeleteAndTopLevelMove(t *testing.T) {
	e, cid, tok := channelEnv(t)
	cat, _, _ := newChannel(t, e, cid, tok, 2, 0, 0, "cat")
	var child id.ID
	{
		status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
			[]any{uint64(0), uint64(0), uint64(0), cat, "child", "", uint64(0), uint64(0)})
		if status != http.StatusCreated {
			t.Fatalf("POST child = %d", status)
		}
		var out []cbor.RawMessage
		mustUnmarshalBody(t, body, &out)
		mustUnmarshal(t, out[0], &child)
	}
	other, _, _ := newChannel(t, e, cid, tok, 0, 0, 0, "other")
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+other.String(), tok,
		[]any{nil, nil, nil, nil, cat, nil, nil}); status != http.StatusNoContent {
		t.Fatal("reparent under the category failed")
	}
	// Move `other` back to the top level with the all-zero id.
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+other.String(), tok,
		[]any{nil, nil, nil, nil, id.ID{}, nil, nil}); status != http.StatusNoContent {
		t.Fatal("move to the top level failed")
	}
	if row, err := e.Repo.GetChannel(t.Context(), other); err != nil || row.ParentID != nil {
		t.Fatalf("after the top-level move: parent = %v, err %v", row.ParentID, err)
	}

	if status, _ := e.Do(http.MethodDelete, "/v1/channels/"+cat.String(), tok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE category failed")
	}
	row, err := e.Repo.GetChannel(t.Context(), child)
	if err != nil {
		t.Fatalf("the category's child went with it: %v", err)
	}
	if row.ParentID != nil {
		t.Fatalf("the child still names the deleted category %v", *row.ParentID)
	}
	// And the child stays editable: its parent is not a dangling tombstone.
	if status, _ := e.Do(http.MethodPatch, "/v1/channels/"+child.String(), tok,
		[]any{"renamed", nil, nil, nil, nil, nil, nil}); status != http.StatusNoContent {
		t.Fatal("PATCH the former child failed")
	}
	if status, _ := e.Do(http.MethodGet, "/v1/channels/"+cat.String(), tok, nil); status != http.StatusNotFound {
		t.Fatalf("GET the deleted category = %d, want 404", status)
	}
	if status, _ := e.Do(http.MethodDelete, "/v1/channels/"+cat.String(), tok, nil); status != http.StatusNotFound {
		t.Fatalf("DELETE the deleted category again = %d, want 404", status)
	}
}

// A parent in another community is refused like any other bad parent.
func TestAParentFromAnotherCommunityIsRefused(t *testing.T) {
	e, cid, tok := channelEnv(t)
	otherCommunity := createCommunity(t, e, tok)
	foreign, _, _ := newChannel(t, e, otherCommunity, tok, 2, 0, 0, "foreign")
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{uint64(0), uint64(0), uint64(0), foreign, "x", "", uint64(0), uint64(0)})
	if status != http.StatusBadRequest || e.ErrCode(body) != "E_INVALID_REQUEST" {
		t.Fatalf("foreign parent = %d, want 400", status)
	}
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/channels", tok,
		[]any{uint64(0), uint64(0), uint64(0), id.New(), "x", "", uint64(0), uint64(0)}); status != http.StatusBadRequest {
		t.Fatalf("unknown parent = %d, want 400", status)
	}
}
