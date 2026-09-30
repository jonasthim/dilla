package dillad

import (
	"context"
	"fmt"
	"os"

	"github.com/jonasthim/dilla/internal/blob"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/ops"
)

// diagnostics is the report GET /v1/admin/diagnostics answers (P2-5): the `dillad doctor` legs
// that can be answered from inside the serving process, under doctor's leg names and in doctor's
// order — the database and its schema version, the data directory's mode, the wasi core the
// delivery service validates in (the runtime this process loaded, not a fresh one), the UDP
// configuration and the blob store's consistency. The legs that probe the network or read state
// another process holds (config parsing, the SQLite pragmas as a fresh connection sees them, clock
// skew against remote peers, the certificate, a TURN allocation) stay `dillad doctor`'s: an admin
// request must not make the instance dial out.
func diagnostics(o Options, wasm *mlswasi.Runtime, blobs *blob.Store) func(context.Context) ops.Report {
	return func(ctx context.Context) ops.Report {
		var r ops.Report
		add := func(l ops.Leg) { r.Legs = append(r.Legs, l) }
		red := func(name string, err error) { add(ops.Leg{Name: name, Status: ops.Red, Detail: err.Error()}) }

		if v, err := o.Repo.SchemaVersion(ctx); err != nil {
			red("database", err)
		} else {
			add(ops.Leg{Name: "database", Status: ops.Green, Detail: fmt.Sprintf("schema version %d", v)})
		}
		// StateDirectoryMode=0700 (facts-ops.md §6.3): group and world have no access at all.
		dir := o.Config.Instance.DataDir
		if info, err := os.Stat(dir); err != nil {
			red("data_dir", err)
		} else if perm := info.Mode().Perm(); perm&0o077 != 0 {
			red("data_dir", fmt.Errorf("%s has mode %04o; group and world must have no access", dir, perm))
		} else {
			add(ops.Leg{Name: "data_dir", Status: ops.Green, Detail: fmt.Sprintf("%s mode %04o", dir, perm)})
		}
		if info, err := wasm.ABI(ctx); err != nil {
			red("wasi", err)
		} else {
			add(ops.Leg{Name: "wasi", Status: ops.Green,
				Detail: fmt.Sprintf("abi_version=%d core_version=%s", info.ABIVersion, info.CoreVersion)})
		}
		add(ops.UDPLeg(*o.Config))
		add(ops.BlobConsistencyLeg(ctx, o.Repo, blobs))
		return r
	}
}
