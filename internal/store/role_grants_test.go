package store_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
)

func TestRoleGrantMigrationBackfillsLegacyAssignmentsAsManual(t *testing.T) {
	db := openSQLite(t)
	p, err := goose.NewProvider(goose.DialectSQLite3, db, sqlitemigrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := p.UpTo(ctx, 28); err != nil {
		t.Fatalf("migrate through 28: %v", err)
	}
	cid, user, role := id.New(), id.New(), id.New()
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,username,display,kind,umk_pub,ssk_pub,sig_umk_ssk,created) VALUES(?,?,?,?,?,?,?,?)`,
		user, "legacy", "Legacy", 0, make([]byte, 32), make([]byte, 32), make([]byte, 64), 1); err != nil {
		t.Fatalf("insert legacy user: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO communities(id,owner,name,policy_json,created) VALUES(?,?,?,?,?)`, cid, user, "legacy", `{}`, 1); err != nil {
		t.Fatalf("insert community: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO members(community_id,user_id,joined) VALUES(?,?,?)`, cid, user, 1); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO roles(id,community_id,name,created) VALUES(?,?,?,?)`, role, cid, "legacy", 1); err != nil {
		t.Fatalf("insert role: %v", err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO member_roles(community_id,user_id,role_id) VALUES(?,?,?)`, cid, user, role); err != nil {
		t.Fatalf("insert legacy assignment: %v", err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatalf("finish migrations: %v", err)
	}
	var source string
	if err := db.QueryRowContext(ctx, `SELECT source FROM member_role_grant_sources WHERE community_id=? AND user_id=? AND role_id=?`, cid, user, role).Scan(&source); err != nil {
		t.Fatalf("read backfilled source: %v", err)
	}
	if source != string(store.RoleGrantManual) {
		t.Fatalf("backfilled source = %q, want manual", source)
	}
}

func TestRoleGrantSourcesPreserveEffectiveRoleUntilLastSourceIsRemoved(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			cid := seedCommunity(ctx, t, repo)
			user := seedUser(ctx, t, repo).ID
			if err := repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: user, Joined: 1}); err != nil {
				t.Fatal(err)
			}
			role := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "member", Created: 1}
			if err := repo.PutRole(ctx, role); err != nil {
				t.Fatal(err)
			}

			if err := repo.AddMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil {
				t.Fatalf("add self grant: %v", err)
			}
			if users, err := repo.ListSelfRoleGrantUsers(ctx, cid, role.ID); err != nil || len(users) != 1 || users[0] != user {
				t.Fatalf("self grant users = %v, %v; want only member", users, err)
			}
			if has, err := repo.HasMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil || !has {
				t.Fatalf("self source exists = %v, %v; want true", has, err)
			}
			if has, err := repo.HasMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantManual); err != nil || has {
				t.Fatalf("manual source exists = %v, %v; want false", has, err)
			}
			if err := repo.PutMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("add manual grant: %v", err)
			}
			if err := repo.RemoveMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil {
				t.Fatalf("remove self grant: %v", err)
			}
			if users, err := repo.ListSelfRoleGrantUsers(ctx, cid, role.ID); err != nil || len(users) != 0 {
				t.Fatalf("self grant users after removal = %v, %v; want none", users, err)
			}
			if has, err := repo.HasMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil || has {
				t.Fatalf("self source after removal = %v, %v; want false", has, err)
			}
			held, err := repo.ListMemberRoles(ctx, cid, user)
			if err != nil || !slices.Contains(held, role.ID) {
				t.Fatalf("role after self removal = %v, %v; want manual role retained", held, err)
			}

			if err := repo.DeleteMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("manual revoke: %v", err)
			}
			held, err = repo.ListMemberRoles(ctx, cid, user)
			if err != nil || slices.Contains(held, role.ID) {
				t.Fatalf("role after manual revoke = %v, %v; want absent", held, err)
			}
			if err := repo.RemoveMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("remove absent self grant = %v, want ErrNotFound", err)
			}

			if err := repo.PutMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("add manual grant again: %v", err)
			}
			if err := repo.AddMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil {
				t.Fatalf("add self grant again: %v", err)
			}
			if err := repo.DeleteMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("manual revoke with self grant present: %v", err)
			}
			held, err = repo.ListMemberRoles(ctx, cid, user)
			if err != nil || !slices.Contains(held, role.ID) {
				t.Fatalf("role after manual revoke = %v, %v; want self grant retained", held, err)
			}
			if err := repo.RemoveMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil {
				t.Fatalf("remove remaining self grant: %v", err)
			}
			held, err = repo.ListMemberRoles(ctx, cid, user)
			if err != nil || slices.Contains(held, role.ID) {
				t.Fatalf("role after final source removal = %v, %v; want absent", held, err)
			}

			if err := repo.PutMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("add manual grant for revoke-all: %v", err)
			}
			if err := repo.AddMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantSelf); err != nil {
				t.Fatalf("add self grant for revoke-all: %v", err)
			}
			if err := repo.AddMemberRoleGrant(ctx, cid, user, role.ID, store.RoleGrantReaction); err != nil {
				t.Fatalf("add reaction grant for revoke-all: %v", err)
			}
			if err := repo.RevokeMemberRole(ctx, cid, user, role.ID); err != nil {
				t.Fatalf("revoke all sources: %v", err)
			}
			held, err = repo.ListMemberRoles(ctx, cid, user)
			if err != nil || slices.Contains(held, role.ID) {
				t.Fatalf("role after revoke all sources = %v, %v; want absent", held, err)
			}
			for _, source := range []store.RoleGrantSource{store.RoleGrantManual, store.RoleGrantSelf, store.RoleGrantReaction} {
				if err := repo.RemoveMemberRoleGrant(ctx, cid, user, role.ID, source); !errors.Is(err, store.ErrNotFound) {
					t.Errorf("remove %s after revoke all = %v, want ErrNotFound", source, err)
				}
			}
		})
	}
}

func TestSelfRolePolicyIsAtomicPersistentAndCommunityScoped(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			cid := seedCommunity(ctx, t, repo)
			approver := seedUser(ctx, t, repo).ID
			first := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "first", Created: 1}
			second := store.RoleRow{ID: id.New(), CommunityID: cid, Name: "second", Created: 1}
			if err := repo.PutRole(ctx, first); err != nil {
				t.Fatal(err)
			}
			if err := repo.PutRole(ctx, second); err != nil {
				t.Fatal(err)
			}
			if err := repo.SetSelfRolePolicy(ctx, cid, approver, []id.ID{first.ID}, 10); err == nil {
				t.Fatal("policy write outside transaction succeeded")
			}
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				if err := tx.LockCommunity(ctx, cid); err != nil {
					return err
				}
				return tx.SetSelfRolePolicy(ctx, cid, approver, []id.ID{second.ID, first.ID}, 11)
			}); err != nil {
				t.Fatalf("write policy: %v", err)
			}
			rows, err := repo.ListSelfRolePolicy(ctx, cid)
			if err != nil {
				t.Fatal(err)
			}
			if len(rows) != 2 || rows[0].ApprovedBy != approver || rows[0].ApprovedAt != 11 || rows[1].ApprovedAt != 11 {
				t.Fatalf("policy rows = %+v", rows)
			}
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				if err := tx.LockCommunity(ctx, cid); err != nil {
					return err
				}
				return tx.SetSelfRolePolicy(ctx, cid, approver, []id.ID{first.ID}, 12)
			}); err != nil {
				t.Fatalf("replace policy: %v", err)
			}
			rows, err = repo.ListSelfRolePolicy(ctx, cid)
			if err != nil || len(rows) != 1 || rows[0].RoleID != first.ID || rows[0].ApprovedAt != 12 {
				t.Fatalf("replaced policy = %+v, %v", rows, err)
			}
		})
	}
}
