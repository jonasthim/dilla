package dillad_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/dillad/dilladtest"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// Fix wave I18: the composition root, built as `dillad serve` builds it (no ACL and no channel
// source in Options), answers invariant 4's eligibility with the permission resolver. The group
// GroupInfo read external joiners need is the probe: a participant of a group DM who holds no leaf
// yet may read it (the resolver admits a DM's participants), and an unrelated account may not (404,
// as for a group that does not exist). An admit-everyone seam would let the stranger in; Plan 1's
// ds.DenyUnlessMember would shut the participant out.
func TestTheCompositionRootWiresTheResolverACL(t *testing.T) {
	srv, h, _ := newInstance(t)
	ctx := t.Context()
	seeded, err := dilladtest.SeedUsers(ctx, srv, []dilladtest.SeedRequest{
		seedRequest("ana"), seedRequest("ben"), seedRequest("stranger"),
	})
	if err != nil {
		t.Fatalf("SeedUsers: %v", err)
	}
	token := func(i int) string {
		for _, tok := range seeded[i].Tokens {
			return tok
		}
		t.Fatalf("no session for %s", seeded[i].UserID)
		return ""
	}
	user := func(i int) id.ID {
		u, err := id.Parse(seeded[i].UserID)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}

	repo := srv.Repo()
	now := srv.Now().Unix()
	dm, group := id.New(), id.New()
	if err := repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.CreateChannel(ctx, store.ChannelRow{
			ID: dm, Kind: api.ChannelGroupDM, SettingsJSON: []byte("{}"), HostPolicyVersion: 1, Created: now,
		}); err != nil {
			return err
		}
		for _, u := range []id.ID{user(0), user(1)} {
			if err := tx.PutChannelMember(ctx, dm, u, now); err != nil {
				return err
			}
		}
		return tx.CreateGroup(ctx, store.GroupRow{
			GroupID: group, Binding: []byte{0x80}, Kind: api.GroupText, TargetID: dm, Ciphersuite: 1,
			Epoch: 1, GroupInfoBlob: []byte("group info"), ExternalSenderKeyID: id.New(),
			E2EEVersion: 1, MediaVersion: 1, PolicyVersion: 1, Created: now,
		})
	}); err != nil {
		t.Fatalf("seed the group DM: %v", err)
	}

	info := "/v1/groups/" + group.String() + "/info"
	if rec := call(t, h, http.MethodGet, info, token(1), nil); rec.Code != http.StatusOK {
		t.Errorf("GET info as a participant with no leaf = %d %s, want 200: the resolver admits a DM's participants",
			rec.Code, errorCode(rec))
	}
	rec := call(t, h, http.MethodGet, info, token(2), nil)
	if rec.Code != http.StatusNotFound || errorCode(rec) != "E_NOT_FOUND" {
		t.Errorf("GET info as an unrelated account = %d %s, want 404 E_NOT_FOUND", rec.Code, errorCode(rec))
	}
}

// seedRequest is one account with one device and all-zero public keys: the reads here verify no
// signature.
func seedRequest(name string) dilladtest.SeedRequest {
	return dilladtest.SeedRequest{
		Username: name, Display: name,
		UMKPub: strings.Repeat("00", 32), SSKPub: strings.Repeat("00", 32), SigUMKSSK: strings.Repeat("00", 64),
		Devices: []dilladtest.Device{{DeviceID: id.New().String(), DSKPub: strings.Repeat("00", 32), Tier: 1, Credential: "80"}},
	}
}
