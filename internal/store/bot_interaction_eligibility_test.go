package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func interactionEligibilityRevision(t *testing.T, repo store.Repository, community, user id.ID) uint64 {
	t.Helper()
	var revision uint64
	err := repo.Tx(context.Background(), func(tx store.Repository) error {
		var err error
		revision, err = tx.(store.BotInteractionEligibility).GetBotInteractionEligibilityRevision(context.Background(), community, user)
		return err
	})
	if err != nil {
		t.Fatalf("read interaction eligibility revision: %v", err)
	}
	return revision
}

func TestBotInteractionEligibilityRevisionFencesMembershipBanAndDeviceChanges(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			community := seedCommunity(ctx, t, repo)
			user := seedUser(ctx, t, repo).ID
			if err := repo.Tx(ctx, func(tx store.Repository) error {
				_, err := tx.(store.BotInteractionEligibility).GetBotInteractionEligibilityRevision(ctx, community, user)
				return err
			}); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("revision before membership = %v, want not found", err)
			}

			member := store.MemberOfCommunityRow{CommunityID: community, UserID: user, Joined: 10}
			if err := repo.PutMember(ctx, member); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 1 {
				t.Fatalf("first membership revision = %d, want 1", got)
			}
			member.Nick = "unchanged-membership"
			if err := repo.PutMember(ctx, member); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 1 {
				t.Fatalf("membership metadata update revision = %d, want unchanged 1", got)
			}

			owner := seedUser(ctx, t, repo).ID
			ban := store.BanRow{CommunityID: community, UserID: user, ByUser: owner, Created: 11}
			if err := repo.PutBan(ctx, ban); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 2 {
				t.Fatalf("ban insertion revision = %d, want 2", got)
			}
			ban.Reason = "updated"
			if err := repo.PutBan(ctx, ban); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 3 {
				t.Fatalf("ban update revision = %d, want 3", got)
			}
			if err := repo.DeleteBan(ctx, community, user); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 4 {
				t.Fatalf("ban removal revision = %d, want 4", got)
			}

			device := store.DeviceRow{ID: id.New(), UserID: user, DSKPub: make([]byte, 32), CredentialBlob: []byte{0}, Created: 12}
			if err := repo.CreateDevice(ctx, device); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 5 {
				t.Fatalf("device insertion revision = %d, want 5", got)
			}
			if err := repo.TouchDevice(ctx, device.ID, 99); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 5 {
				t.Fatalf("last-seen update revision = %d, want unchanged 5", got)
			}
			if err := repo.UpdateDeviceCredential(ctx, device.ID, []byte{1, 2, 3}); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 6 {
				t.Fatalf("credential update revision = %d, want 6", got)
			}
			if err := repo.RevokeDevice(ctx, device.ID, 13); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 7 {
				t.Fatalf("device revocation revision = %d, want 7", got)
			}

			list := store.DeviceListRow{UserID: user, Version: 1, Blob: []byte{0x80}, SSKSignature: make([]byte, 64), PrevHash: make([]byte, 32), Created: 14}
			if err := repo.PutDeviceList(ctx, list); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 8 {
				t.Fatalf("device-list insertion revision = %d, want 8", got)
			}

			rollback := errors.New("rollback eligibility update")
			list.Version = 2
			err := repo.Tx(ctx, func(tx store.Repository) error {
				if err := tx.PutDeviceList(ctx, list); err != nil {
					return err
				}
				return rollback
			})
			if !errors.Is(err, rollback) {
				t.Fatalf("rollback device-list update = %v, want sentinel", err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 8 {
				t.Fatalf("rolled-back device-list revision = %d, want 8", got)
			}

			if err := repo.DeleteMember(ctx, community, user); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 9 {
				t.Fatalf("membership removal revision = %d, want 9", got)
			}
			if err := repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: user, Joined: 15}); err != nil {
				t.Fatal(err)
			}
			if got := interactionEligibilityRevision(t, repo, community, user); got != 10 {
				t.Fatalf("rejoin revision = %d, want 10", got)
			}
		})
	}
}
