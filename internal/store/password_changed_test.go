package store_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// Task 11 (Jonas, Q7), migration 00052: a password's change time is unknown (nil) until MarkPasswordChanged records it, a
// new PutPasswordCredential (sign-up or a change) keeps the recorded time, and an account without a password is ErrNotFound.
func TestPasswordChangedAt(t *testing.T) {
	for engine, repo := range engines(t) {
		t.Run(engine, func(t *testing.T) {
			ctx := context.Background()
			user := seedUser(ctx, t, repo)
			if _, err := repo.GetPasswordChangedAt(ctx, user.ID); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("no password: err = %v, want ErrNotFound", err)
			}
			if err := repo.MarkPasswordChanged(ctx, user.ID, 5); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("mark without a password: err = %v, want ErrNotFound", err)
			}
			if err := repo.PutPasswordCredential(ctx, user.ID, "$argon2id$x", 1); err != nil {
				t.Fatal(err)
			}
			if at, err := repo.GetPasswordChangedAt(ctx, user.ID); err != nil || at != nil {
				t.Fatalf("before any change: at = %v, err = %v, want nil, nil", at, err)
			}
			if err := repo.MarkPasswordChanged(ctx, user.ID, 1_800_000_000); err != nil {
				t.Fatal(err)
			}
			if err := repo.PutPasswordCredential(ctx, user.ID, "$argon2id$y", 1_800_000_000); err != nil {
				t.Fatal(err)
			}
			at, err := repo.GetPasswordChangedAt(ctx, user.ID)
			if err != nil || at == nil || *at != 1_800_000_000 {
				t.Fatalf("after a change: at = %v, err = %v, want 1800000000", at, err)
			}
			if _, err := repo.GetPasswordChangedAt(ctx, id.New()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("an unknown user: err = %v, want ErrNotFound", err)
			}
		})
	}
}
