package api_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// structureFixture is one community with a member and an outsider, and one channel of each
// kind, written straight into the real repository StructureChannels reads.
type structureFixture struct {
	src                       api.StructureChannels
	community, other          id.ID
	member, outsider          id.ID
	text, voice, category, dm id.ID
	readable, deletedText     id.ID
	otherText                 id.ID
}

func newStructureFixture(t *testing.T) structureFixture {
	t.Helper()
	e := newEnv(t)
	ctx := context.Background()
	f := structureFixture{src: api.StructureChannels{Repo: e.Repo}}
	f.member, _ = e.NewUser("member")
	f.outsider, _ = e.NewUser("outsider")
	newCommunity := func(owner id.ID) id.ID {
		cid := id.New()
		if err := e.Repo.CreateCommunity(ctx, store.CommunityRow{
			ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: 1,
		}); err != nil {
			t.Fatalf("CreateCommunity: %v", err)
		}
		if err := e.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: owner, Joined: 1}); err != nil {
			t.Fatalf("PutMember: %v", err)
		}
		return cid
	}
	f.community = newCommunity(f.member)
	f.other = newCommunity(f.outsider)
	newRow := func(cid *id.ID, kind, mode, vis uint8) id.ID {
		row := store.ChannelRow{
			ID: id.New(), CommunityID: cid, Kind: kind, Mode: mode, Visibility: vis,
			Name: "ch", SettingsJSON: []byte(`{}`), HostPolicyVersion: 1, Created: 1,
		}
		if err := e.Repo.CreateChannel(ctx, row); err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		return row.ID
	}
	f.text = newRow(&f.community, api.ChannelText, api.ModeE2EE, api.VisPrivate)
	f.voice = newRow(&f.community, api.ChannelVoice, api.ModeE2EE, api.VisPrivate)
	f.category = newRow(&f.community, api.ChannelCategory, api.ModeE2EE, api.VisPrivate)
	f.readable = newRow(&f.community, api.ChannelText, api.ModeReadable, api.VisDiscoverable)
	f.deletedText = newRow(&f.community, api.ChannelText, api.ModeE2EE, api.VisPrivate)
	if err := e.Repo.DeleteChannel(ctx, f.deletedText, 2); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	f.dm = newRow(nil, api.ChannelDM, api.ModeE2EE, api.VisPrivate)
	f.otherText = newRow(&f.other, api.ChannelText, api.ModeE2EE, api.VisPrivate)
	return f
}

func binding(community *id.ID, target id.ID, kind uint8) ds.Binding {
	return ds.Binding{V: 1, CommunityID: community, TargetID: target, Kind: kind, E2EEVersion: 1}
}

// Invariant 1's input, from the real table: a live channel's visibility and mode, and "no
// channel row" (not an error) for a deleted channel and for a target that was never a channel.
func TestStructureChannelsReportsTheStoredMode(t *testing.T) {
	f := newStructureFixture(t)
	ctx := context.Background()
	vis, mode, err := f.src.Channel(ctx, f.readable)
	if err != nil || vis != api.VisDiscoverable || mode != api.ModeReadable {
		t.Fatalf("Channel(readable) = %d, %d, %v", vis, mode, err)
	}
	vis, mode, err = f.src.Channel(ctx, f.text)
	if err != nil || vis != api.VisPrivate || mode != api.ModeE2EE {
		t.Fatalf("Channel(text) = %d, %d, %v", vis, mode, err)
	}
	for name, target := range map[string]id.ID{"deleted": f.deletedText, "unknown": id.New()} {
		if _, _, err := f.src.Channel(ctx, target); !errors.Is(err, ds.ErrNoChannel) {
			t.Errorf("Channel(%s) = %v, want ds.ErrNoChannel", name, err)
		}
	}
}

// The registration ACL, rule by rule (Plan 1 follow-up card 14).
func TestStructureChannelsGatesRegistrationOnMembership(t *testing.T) {
	f := newStructureFixture(t)
	ctx := context.Background()
	c, o := &f.community, &f.other
	for _, tc := range []struct {
		name string
		user id.ID
		b    ds.Binding
		want error // nil, ds.ErrNotEligible or ds.ErrBindingTarget
	}{
		{"a member's text group on a text channel", f.member, binding(c, f.text, 0), nil},
		{"a member's call group on a voice channel", f.member, binding(c, f.voice, 1), nil},
		{"an outsider's text group on the same channel", f.outsider, binding(c, f.text, 0), ds.ErrNotEligible},
		{"an outsider's call group on the same voice channel", f.outsider, binding(c, f.voice, 1), ds.ErrNotEligible},
		{"a binding naming another community than the channel's", f.outsider, binding(o, f.text, 0), ds.ErrBindingTarget},
		{"a binding naming no community for a community channel", f.member, binding(nil, f.text, 0), ds.ErrBindingTarget},
		{"a text group on a voice channel", f.member, binding(c, f.voice, 0), ds.ErrBindingTarget},
		{"a text group on a category", f.member, binding(c, f.category, 0), ds.ErrBindingTarget},
		{"a call group on a text channel", f.member, binding(c, f.text, 1), ds.ErrBindingTarget},
		{"a community text group whose target is no channel", f.member, binding(c, id.New(), 0), ds.ErrBindingTarget},
		{"a text group on a deleted channel", f.member, binding(c, f.deletedText, 0), ds.ErrBindingTarget},
		// R9: a call group's target may be the call itself; community membership decides.
		{"a member's call group whose target is the call", f.member, binding(c, id.New(), 1), nil},
		{"an outsider's call group whose target is the call", f.outsider, binding(c, id.New(), 1), ds.ErrNotEligible},
		{"a call group naming no live community", f.member, binding(new(id.New()), id.New(), 1), ds.ErrBindingTarget},
		// DMs wait for task 6's channel_members.
		{"a DM text group with no channel row", f.member, binding(nil, id.New(), 0), ds.ErrNotEligible},
		{"a DM call group with no channel row", f.member, binding(nil, id.New(), 1), ds.ErrNotEligible},
		{"a text group on a DM channel row", f.member, binding(nil, f.dm, 0), ds.ErrNotEligible},
		{"a DM channel row bound under a community", f.member, binding(c, f.dm, 0), ds.ErrBindingTarget},
		// Not channel groups.
		{"a pairing group", f.outsider, binding(nil, id.New(), 2), nil},
		{"an interaction group", f.outsider, binding(nil, id.New(), 3), nil},
		{"an unknown group kind", f.member, binding(c, f.text, 4), ds.ErrBindingTarget},
	} {
		err := f.src.MayRegister(ctx, tc.user, tc.b)
		switch {
		case tc.want == nil && err != nil:
			t.Errorf("%s: %v, want admitted", tc.name, err)
		case tc.want != nil && !errors.Is(err, tc.want):
			t.Errorf("%s: %v, want %v", tc.name, err, tc.want)
		}
	}
}

// A member who leaves loses the right to register in the community with the membership.
func TestLeavingACommunityEndsTheRightToRegisterInIt(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	owner, _ := e.NewUser("owner")
	member, _ := e.NewUser("member")
	cid := id.New()
	if err := e.Repo.CreateCommunity(ctx, store.CommunityRow{
		ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: 1,
	}); err != nil {
		t.Fatalf("CreateCommunity: %v", err)
	}
	if err := e.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: member, Joined: 1}); err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	ch := store.ChannelRow{
		ID: id.New(), CommunityID: &cid, Name: "general", SettingsJSON: []byte(`{}`),
		HostPolicyVersion: 1, Created: 1,
	}
	if err := e.Repo.CreateChannel(ctx, ch); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	src := api.StructureChannels{Repo: e.Repo}
	if err := src.MayRegister(ctx, member, binding(&cid, ch.ID, 0)); err != nil {
		t.Fatalf("a member was refused: %v", err)
	}
	if err := e.Repo.DeleteMember(ctx, cid, member); err != nil {
		t.Fatalf("DeleteMember: %v", err)
	}
	if err := src.MayRegister(ctx, member, binding(&cid, ch.ID, 0)); !errors.Is(err, ds.ErrNotEligible) {
		t.Fatalf("a former member = %v, want ds.ErrNotEligible", err)
	}
}

// End to end: the real delivery service, the real wasm core and the committed fixture, with
// StructureChannels over the real repository as the composition root injects it. The fixture's
// binding is a DM-shaped text group (no community, target = its group id), so the three answers
// here are the three the store can give it.
func TestRegisterThroughTheRealChannelSource(t *testing.T) {
	for _, c := range []struct {
		name       string
		seed       func(t *testing.T, h *groupsAPI)
		wantStatus int
		wantCode   string
	}{
		{
			// Card 14: before task 2 any enrolled device registered this group.
			name:       "no channel row: a DM, refused until task 6's channel membership",
			seed:       func(*testing.T, *groupsAPI) {},
			wantStatus: http.StatusForbidden, wantCode: "E_FORBIDDEN",
		},
		{
			name: "the target is a discoverable channel: invariant 1 from the real table",
			seed: func(t *testing.T, h *groupsAPI) {
				seedChannelAt(t, h, api.ModeReadable, api.VisDiscoverable)
			},
			wantStatus: http.StatusForbidden, wantCode: "E_MODE_READABLE",
		},
		{
			name: "the target is a community channel the binding does not name",
			seed: func(t *testing.T, h *groupsAPI) {
				seedChannelAt(t, h, api.ModeE2EE, api.VisPrivate)
			},
			wantStatus: http.StatusBadRequest, wantCode: "E_BINDING_INVALID",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			h := newGroupsAPIWith(t, func(repo store.Repository) ds.Channels {
				return api.StructureChannels{Repo: repo}
			})
			c.seed(t, h)
			res := h.do(t, http.MethodPost, "/v1/groups", h.session, h.createBody(t))
			if res.Code != c.wantStatus {
				t.Fatalf("status = %d, want %d: %x", res.Code, c.wantStatus, res.Body.Bytes())
			}
			var body []any
			if err := cborx.Unmarshal(res.Body.Bytes(), &body); err != nil || len(body) == 0 {
				t.Fatalf("error body: %v (%x)", err, res.Body.Bytes())
			}
			if body[0] != c.wantCode {
				t.Fatalf("code = %v, want %s", body[0], c.wantCode)
			}
			if _, err := h.deps.Repo.GetGroup(context.Background(), h.groupID); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("a refused registration left a group row: %v", err)
			}
		})
	}
}

// seedChannelAt creates a community owned by the harness's session user and a text channel in it
// whose id is the fixture's binding target.
func seedChannelAt(t *testing.T, h *groupsAPI, mode, visibility uint8) {
	t.Helper()
	ctx := context.Background()
	cid := id.New()
	if err := h.deps.Repo.CreateCommunity(ctx, store.CommunityRow{
		ID: cid, Owner: h.user, Name: "c", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: 1,
	}); err != nil {
		t.Fatalf("CreateCommunity: %v", err)
	}
	if err := h.deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: h.user, Joined: 1}); err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	if err := h.deps.Repo.CreateChannel(ctx, store.ChannelRow{
		ID: h.groupID, CommunityID: &cid, Kind: api.ChannelText, Mode: mode, Visibility: visibility,
		Name: "general", SettingsJSON: []byte(`{}`), HostPolicyVersion: 1, Created: 1,
	}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
}
