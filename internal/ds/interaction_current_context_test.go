package ds_test

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/store"
)

func TestCurrentBotInteractionContextRequiresAcceptedReceiptAndExactLiveRoster(t *testing.T) {
	fixture := newKind3RegistrationFixture(t)
	ctx := context.Background()
	if _, _, err := fixture.h.ds.RegisterBotInteractionGroup(ctx, fixture.request); err != nil {
		t.Fatalf("register kind-3 group: %v", err)
	}

	got, err := fixture.h.ds.CurrentBotInteractionGroupContext(ctx, fixture.request.Registration.GroupID)
	if err != nil {
		t.Fatalf("load current context: %v", err)
	}
	if got.Registration.GroupID != fixture.request.Registration.GroupID {
		t.Fatalf("registration receipt for group %s = %s", fixture.request.Registration.GroupID, got.Registration.GroupID)
	}
	if got.LeafCount != 2 || len(got.Roster) != 2 || got.Epoch != 1 || got.Registration.Epoch != 1 {
		t.Fatalf("current authenticated group=%+v", got)
	}
	expected := fixture.request.TrustedPreflight.Expected
	if got.Binding.InstallationID != fixture.request.InstallationID || got.Binding.CommunityID != expected.CommunityID || got.Binding.ParticipantUserID != expected.ParticipantUserID || got.Binding.ParticipantDeviceID != expected.ParticipantDeviceID {
		t.Fatalf("binding does not match accepted registration: %+v", got.Binding)
	}

	// A database-only roster shortcut would bless inconsistent member metadata even though
	// current PublicGroup state still has two authenticated leaves. The DS refuses the mismatch.
	if err := fixture.h.repo.Tx(ctx, func(tx store.Repository) error {
		members, err := tx.ListMembers(ctx, fixture.request.Registration.GroupID)
		if err != nil {
			return err
		}
		return tx.ReplaceMembers(ctx, fixture.request.Registration.GroupID, got.Epoch, members[:1])
	}); err != nil {
		t.Fatalf("corrupt member projection for negative case: %v", err)
	}
	if _, err := fixture.h.ds.CurrentBotInteractionGroupContext(ctx, fixture.request.Registration.GroupID); err == nil {
		t.Fatal("current context accepted a roster projection that differs from authenticated MLS state")
	}

	// The still-present group row and MLS state must not substitute for proof that this was ever
	// accepted by kind-3 flow if the immutable registration record is absent.
	if err := fixture.h.repo.Tx(ctx, func(tx store.Repository) error {
		return tx.(store.BotGroupRegistrationReceipts).DeleteBotGroupRegistrationReceiptsByInstallation(ctx, fixture.request.InstallationID)
	}); err != nil {
		t.Fatalf("delete accepted receipt: %v", err)
	}
	if _, err := fixture.h.ds.CurrentBotInteractionGroupContext(ctx, fixture.request.Registration.GroupID); err == nil {
		t.Fatal("current context accepted a group with no immutable registration receipt")
	}
}
