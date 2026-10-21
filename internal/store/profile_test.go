package store_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// A new account has an empty status message and bio; UpdateProfile writes all three profile fields
// in one statement, GetUser reads them back, and a tombstone clears them.
func TestUpdateProfileRoundTrips(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			user := seedUser(ctx, t, repo)
			fresh, err := repo.GetUser(ctx, user.ID)
			if err != nil || fresh.StatusMsg != "" || fresh.Bio != "" {
				t.Fatalf("a new account has status %q and bio %q, want both empty (%v)", fresh.StatusMsg, fresh.Bio, err)
			}
			if err := repo.UpdateProfile(ctx, user.ID, "Ada L", "on a call", "line one\nline two"); err != nil {
				t.Fatalf("UpdateProfile: %v", err)
			}
			got, err := repo.GetUser(ctx, user.ID)
			if err != nil || got.Display != "Ada L" || got.StatusMsg != "on a call" || got.Bio != "line one\nline two" {
				t.Fatalf("GetUser = %+v, %v; want the written profile", got, err)
			}
			if got.Username != fresh.Username {
				t.Fatalf("the username changed: %q", got.Username)
			}
			if err := repo.UpdateProfile(ctx, id.New(), "x", "", ""); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("UpdateProfile of an unknown user = %v, want ErrNotFound", err)
			}
			if err := repo.TombstoneUser(ctx, user.ID, 5); err != nil {
				t.Fatal(err)
			}
			got, err = repo.GetUser(ctx, user.ID)
			if err != nil || got.Display != "" || got.StatusMsg != "" || got.Bio != "" {
				t.Fatalf("a tombstone keeps display %q, status %q, bio %q; want all cleared (%v)", got.Display, got.StatusMsg, got.Bio, err)
			}
		})
	}
}

// The columns bound their own length in characters, so a client that skips the API's check cannot
// store more than 190 and 500.
func TestProfileColumnsBoundTheirLength(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			user := seedUser(ctx, t, repo)
			if err := repo.UpdateProfile(ctx, user.ID, "d", strings.Repeat("ä", 190), strings.Repeat("ö", 500)); err != nil {
				t.Fatalf("the maximum lengths are refused: %v", err)
			}
			if err := repo.UpdateProfile(ctx, user.ID, "d", strings.Repeat("a", 191), ""); err == nil {
				t.Fatal("a 191-character status message was stored")
			}
			if err := repo.UpdateProfile(ctx, user.ID, "d", "", strings.Repeat("a", 501)); err == nil {
				t.Fatal("a 501-character bio was stored")
			}
		})
	}
}
