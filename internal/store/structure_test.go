package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// The plan names the helpers newRepos/newTestUser; Plan 1 shipped them as
// engines(t) (one migrated repository per available engine, keyed by engine
// name) and seedUser, and the shipped spelling wins.

func TestCommunityRoundTrip(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			owner := seedUser(ctx, t, repo).ID

			cid := id.New()
			in := store.CommunityRow{
				ID:                   cid,
				Owner:                owner,
				Name:                 "Kryptering",
				IconBlob:             nil,
				PolicyJSON:           []byte(`{"retention_days":0}`),
				PolicyVersion:        1,
				MinAccountAgeSeconds: 0,
				RequireMod2FA:        0,
				Created:              1000,
			}
			if err := repo.CreateCommunity(ctx, in); err != nil {
				t.Fatalf("CreateCommunity: %v", err)
			}

			got, err := repo.GetCommunity(ctx, cid)
			if err != nil {
				t.Fatalf("GetCommunity: %v", err)
			}
			if got.Name != "Kryptering" || got.Owner != owner || got.PolicyVersion != 1 {
				t.Fatalf("GetCommunity = %+v", got)
			}
			if string(got.PolicyJSON) != `{"retention_days":0}` {
				t.Fatalf("PolicyJSON = %q", got.PolicyJSON)
			}

			if err := repo.UpdateCommunityPolicy(ctx, cid, []byte(`{"retention_days":30}`), 2); err != nil {
				t.Fatalf("UpdateCommunityPolicy: %v", err)
			}
			got, err = repo.GetCommunity(ctx, cid)
			if err != nil {
				t.Fatalf("GetCommunity after update: %v", err)
			}
			if got.PolicyVersion != 2 || string(got.PolicyJSON) != `{"retention_days":30}` {
				t.Fatalf("after update = %+v", got)
			}

			if _, err := repo.GetCommunity(ctx, id.New()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetCommunity(unknown) = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestCommunityMembers(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			cid := id.New()
			owner := seedUser(ctx, t, repo).ID
			if err := repo.CreateCommunity(ctx, store.CommunityRow{
				ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`),
				PolicyVersion: 1, Created: 1,
			}); err != nil {
				t.Fatalf("CreateCommunity: %v", err)
			}

			users := make([]id.ID, 3)
			for i := range users {
				users[i] = seedUser(ctx, t, repo).ID
				if err := repo.PutMember(ctx, store.MemberOfCommunityRow{
					CommunityID: cid, UserID: users[i], Joined: int64(100 + i), Nick: "",
				}); err != nil {
					t.Fatalf("PutMember: %v", err)
				}
			}

			// PutMember is an upsert: a second call updates the nick and adds no row.
			if err := repo.PutMember(ctx, store.MemberOfCommunityRow{
				CommunityID: cid, UserID: users[0], Joined: 100, Nick: "nick",
			}); err != nil {
				t.Fatalf("PutMember upsert: %v", err)
			}

			var all []store.MemberOfCommunityRow
			var after id.ID
			for {
				page, err := repo.ListMembersOfCommunity(ctx, cid, after, 2)
				if err != nil {
					t.Fatalf("ListMembersOfCommunity: %v", err)
				}
				if len(page) == 0 {
					break
				}
				all = append(all, page...)
				after = page[len(page)-1].UserID
			}
			if len(all) != 3 {
				t.Fatalf("members = %d, want 3", len(all))
			}
			for i := 1; i < len(all); i++ {
				if string(all[i-1].UserID[:]) >= string(all[i].UserID[:]) {
					t.Fatalf("members not ordered by user_id: %x then %x", all[i-1].UserID, all[i].UserID)
				}
			}

			if err := repo.DeleteMember(ctx, cid, users[1]); err != nil {
				t.Fatalf("DeleteMember: %v", err)
			}
			rest, err := repo.ListMembersOfCommunity(ctx, cid, id.ID{}, 10)
			if err != nil {
				t.Fatalf("ListMembersOfCommunity: %v", err)
			}
			if len(rest) != 2 {
				t.Fatalf("after delete = %d, want 2", len(rest))
			}
		})
	}
}

func TestRolesPerCommunity(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			cid := id.New()
			owner := seedUser(ctx, t, repo).ID
			if err := repo.CreateCommunity(ctx, store.CommunityRow{
				ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`),
				PolicyVersion: 1, Created: 1,
			}); err != nil {
				t.Fatalf("CreateCommunity: %v", err)
			}
			everyone := store.RoleRow{
				ID: id.New(), CommunityID: cid, Name: "@everyone",
				Position: 0, Allow: 0x401c3, Deny: 0, Created: 1,
			}
			mod := store.RoleRow{
				ID: id.New(), CommunityID: cid, Name: "mod",
				Position: 10, Allow: 0x4, Deny: 0, Hoist: 1, Created: 2,
			}
			for _, r := range []store.RoleRow{mod, everyone} {
				if err := repo.PutRole(ctx, r); err != nil {
					t.Fatalf("PutRole: %v", err)
				}
			}
			got, err := repo.ListRoles(ctx, cid)
			if err != nil {
				t.Fatalf("ListRoles: %v", err)
			}
			if len(got) != 2 {
				t.Fatalf("ListRoles = %d rows, want 2", len(got))
			}
			if got[0].Position != 0 || got[1].Position != 10 {
				t.Fatalf("ListRoles is not ordered by position: %+v", got)
			}
			if got[0].Allow != 0x401c3 {
				t.Fatalf("@everyone allow = %#x", got[0].Allow)
			}
		})
	}
}

// TestCommunityMetaMembershipAndRoleGrants covers the methods the plan adds to
// §4.1 (P2-D7, P2-D7b, and P2-D9's GetRole, which task 1's grant route needs),
// and the policy-version guard: two writers that read the same version must
// not both land a policy under the same number.
func TestCommunityMetaMembershipAndRoleGrants(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			cid := id.New()
			owner := seedUser(ctx, t, repo).ID
			if err := repo.CreateCommunity(ctx, store.CommunityRow{
				ID: cid, Owner: owner, Name: "c", PolicyJSON: []byte(`{}`),
				PolicyVersion: 1, Created: 1,
			}); err != nil {
				t.Fatalf("CreateCommunity: %v", err)
			}

			// UpdateCommunityMeta writes the three mutable columns.
			if err := repo.UpdateCommunityMeta(ctx, cid, "renamed", 3600, 1); err != nil {
				t.Fatalf("UpdateCommunityMeta: %v", err)
			}
			got, err := repo.GetCommunity(ctx, cid)
			if err != nil {
				t.Fatalf("GetCommunity: %v", err)
			}
			if got.Name != "renamed" || got.MinAccountAgeSeconds != 3600 || got.RequireMod2FA != 1 {
				t.Fatalf("after UpdateCommunityMeta = %+v", got)
			}
			if err := repo.UpdateCommunityMeta(ctx, id.New(), "x", 0, 0); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("UpdateCommunityMeta(unknown) = %v, want ErrNotFound", err)
			}

			// The policy version is monotone: a writer that lost the race to the
			// same version is refused with ErrConflict, not silently accepted.
			if err := repo.UpdateCommunityPolicy(ctx, cid, []byte(`{"retention_days":7}`), 2); err != nil {
				t.Fatalf("UpdateCommunityPolicy v2: %v", err)
			}
			if err := repo.UpdateCommunityPolicy(ctx, cid, []byte(`{"retention_days":9}`), 2); !errors.Is(err, store.ErrConflict) {
				t.Fatalf("UpdateCommunityPolicy stale v2 = %v, want ErrConflict", err)
			}
			if err := repo.UpdateCommunityPolicy(ctx, id.New(), []byte(`{}`), 2); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("UpdateCommunityPolicy(unknown) = %v, want ErrNotFound", err)
			}
			got, _ = repo.GetCommunity(ctx, cid)
			if string(got.PolicyJSON) != `{"retention_days":7}` || got.PolicyVersion != 2 {
				t.Fatalf("the stale write landed: %+v", got)
			}

			// GetMember, and ErrNotFound for a non-member.
			member := seedUser(ctx, t, repo).ID
			if err := repo.PutMember(ctx, store.MemberOfCommunityRow{
				CommunityID: cid, UserID: member, Joined: 5, Nick: "Åsa",
			}); err != nil {
				t.Fatalf("PutMember: %v", err)
			}
			m, err := repo.GetMember(ctx, cid, member)
			if err != nil {
				t.Fatalf("GetMember: %v", err)
			}
			if m.Joined != 5 || m.Nick != "Åsa" {
				t.Fatalf("GetMember = %+v", m)
			}
			if _, err := repo.GetMember(ctx, cid, id.New()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetMember(non-member) = %v, want ErrNotFound", err)
			}

			// Role grants: GetRole, PutMemberRole (idempotent), ListMemberRoles,
			// DeleteMemberRole.
			role := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "mod", Position: 3, Allow: 0x4, Created: 7}
			if err := repo.PutRole(ctx, role); err != nil {
				t.Fatalf("PutRole: %v", err)
			}
			gotRole, err := repo.GetRole(ctx, role.ID)
			if err != nil {
				t.Fatalf("GetRole: %v", err)
			}
			if gotRole != role {
				t.Fatalf("GetRole = %+v, want %+v", gotRole, role)
			}
			if _, err := repo.GetRole(ctx, id.New()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetRole(unknown) = %v, want ErrNotFound", err)
			}
			for range 2 {
				if err := repo.PutMemberRole(ctx, cid, member, role.ID); err != nil {
					t.Fatalf("PutMemberRole: %v", err)
				}
			}
			held, err := repo.ListMemberRoles(ctx, cid, member)
			if err != nil {
				t.Fatalf("ListMemberRoles: %v", err)
			}
			if len(held) != 1 || held[0] != role.ID {
				t.Fatalf("ListMemberRoles = %v, want [%v]", held, role.ID)
			}
			if err := repo.DeleteMemberRole(ctx, cid, member, role.ID); err != nil {
				t.Fatalf("DeleteMemberRole: %v", err)
			}
			if err := repo.DeleteMemberRole(ctx, cid, member, role.ID); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("DeleteMemberRole twice = %v, want ErrNotFound", err)
			}

			// Leaving drops the member's grants with the membership row, so a
			// re-join does not resurrect a role the member held before.
			if err := repo.PutMemberRole(ctx, cid, member, role.ID); err != nil {
				t.Fatalf("PutMemberRole: %v", err)
			}
			if err := repo.DeleteMember(ctx, cid, member); err != nil {
				t.Fatalf("DeleteMember: %v", err)
			}
			if err := repo.DeleteMember(ctx, cid, member); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("DeleteMember twice = %v, want ErrNotFound", err)
			}
			held, err = repo.ListMemberRoles(ctx, cid, member)
			if err != nil {
				t.Fatalf("ListMemberRoles after leave: %v", err)
			}
			if len(held) != 0 {
				t.Fatalf("grants survived the membership: %v", held)
			}

			// SoftDeleteCommunity tombstones: the community is gone to every read
			// and a second delete is ErrNotFound.
			if err := repo.SoftDeleteCommunity(ctx, cid, 99); err != nil {
				t.Fatalf("SoftDeleteCommunity: %v", err)
			}
			if _, err := repo.GetCommunity(ctx, cid); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("GetCommunity after delete = %v, want ErrNotFound", err)
			}
			if err := repo.SoftDeleteCommunity(ctx, cid, 100); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("SoftDeleteCommunity twice = %v, want ErrNotFound", err)
			}
		})
	}
}
