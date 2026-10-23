package store_test

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestDJRolePolicyIsInstallationScoped(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			community := seedCommunity(ctx, t, repo)
			owner := seedUser(ctx, t, repo).ID
			role := store.RoleRow{ID: id.New(), CommunityID: community, Name: "dj", Position: 2, Created: 1}
			if err := repo.PutRole(ctx, role); err != nil {
				t.Fatal(err)
			}
			installation := store.BotInstallationRow{ID: id.New(), CommunityID: community, State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner, ApprovedAt: 1, Created: 1, Updated: 1}
			if err := repo.CreateBotInstallation(ctx, installation); err != nil {
				t.Fatal(err)
			}
			policy := repo.(store.Structure)
			if err := policy.SetDJRolePolicy(ctx, installation.ID, owner, []id.ID{role.ID}, 2); err == nil {
				t.Fatal("write outside transaction succeeded")
			}
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				return tx.(store.Structure).SetDJRolePolicy(ctx, installation.ID, owner, []id.ID{role.ID}, 2)
			}); err != nil {
				t.Fatal(err)
			}
			got, err := policy.ListDJRolePolicy(ctx, installation.ID)
			if err != nil || len(got) != 1 || got[0].InstallationID != installation.ID || got[0].RoleID != role.ID || got[0].ApprovedBy != owner || got[0].ApprovedAt != 2 {
				t.Fatalf("installation policy = %+v, %v", got, err)
			}
			removedAt := int64(3)
			installation.Revision++
			installation.State = store.BotInstallationDisabled
			installation.RemovedAt = &removedAt
			installation.Updated = removedAt
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				return tx.UpdateBotInstallation(ctx, installation.ID, installation.Revision-1, installation)
			}); err != nil {
				t.Fatal(err)
			}
			replacement := store.BotInstallationRow{ID: id.New(), CommunityID: community, State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner, ApprovedAt: 4, Created: 4, Updated: 4}
			if err := repo.CreateBotInstallation(ctx, replacement); err != nil {
				t.Fatal(err)
			}
			got, err = policy.ListDJRolePolicy(ctx, replacement.ID)
			if err != nil || len(got) != 0 {
				t.Fatalf("replacement inherited old policy = %+v, %v", got, err)
			}
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				return tx.(store.Structure).SetDJRolePolicy(ctx, installation.ID, owner, nil, 3)
			}); err != nil {
				t.Fatal(err)
			}
			got, err = policy.ListDJRolePolicy(ctx, installation.ID)
			if err != nil || len(got) != 0 {
				t.Fatalf("cleared policy = %+v, %v", got, err)
			}
		})
	}
}
