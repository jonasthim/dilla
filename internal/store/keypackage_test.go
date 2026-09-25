package store_test

// The KeyPackage directory's one concurrency invariant: N callers taking from a directory of N
// packages get N DISTINCT packages, never one twice.
//
// It lives here, beside `engines`, rather than in internal/ds, because the rule is the QUERY's and
// the two engines encode it differently. On SQLite writes serialise through the single write
// connection, so the sub-select cannot hand one row to two callers. On Postgres they do not: two
// concurrent takes read the same snapshot, and only `FOR UPDATE SKIP LOCKED` makes the second
// caller skip the row the first is consuming. `ProposeAddBatch` makes concurrent takes for one
// device routine, and a KeyPackage served twice is two joiners holding the same init key.
//
// The Postgres leg is skipped locally and runs in CI's service container.

import (
	"context"
	"sync"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestConcurrentTakesNeverServeOneKeyPackageTwice(t *testing.T) {
	ctx := context.Background()
	for name, repo := range engines(t) {
		t.Run(name, func(t *testing.T) {
			const n = 16
			user := seedUser(ctx, t, repo)
			device := store.DeviceRow{
				ID: id.New(), UserID: user.ID, DSKPub: make([]byte, 32),
				CredentialBlob: []byte{1}, LastSeen: 1_700_000_000, Created: 1_700_000_000,
			}
			if err := repo.CreateDevice(ctx, device); err != nil {
				t.Fatalf("CreateDevice: %v", err)
			}
			rows := make([]store.KeyPackageRow, 0, n)
			for i := range n {
				ref := make([]byte, 32)
				ref[0], ref[1] = byte(i), byte(i>>8)
				rows = append(rows, store.KeyPackageRow{
					DeviceID: device.ID, KPRef: ref, Blob: []byte{byte(i)}, LastResort: 0,
					Expires: 2_000_000_000, Created: 1_700_000_000,
				})
			}
			if err := repo.PutKeyPackages(ctx, device.ID, rows); err != nil {
				t.Fatalf("PutKeyPackages: %v", err)
			}

			refs := make(chan string, n)
			var wg sync.WaitGroup
			for range n {
				wg.Add(1)
				go func() {
					defer wg.Done()
					kp, err := repo.TakeKeyPackage(ctx, device.ID, 1_700_000_001)
					if err != nil {
						return // a take that found nothing is not a double-serve
					}
					refs <- string(kp.KPRef)
				}()
			}
			wg.Wait()
			close(refs)

			seen := map[string]struct{}{}
			for ref := range refs {
				if _, dup := seen[ref]; dup {
					t.Fatal("one KeyPackage was served to two callers")
				}
				seen[ref] = struct{}{}
			}
			if len(seen) != n {
				t.Fatalf("%d distinct packages served, want %d", len(seen), n)
			}
		})
	}
}
