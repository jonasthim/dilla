package ds

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// DeviceLists decodes and verifies a user's signed device list, which is invariant 4's DSK clause:
// "its DSK is in the newest signed device list". The decoder and the ssk_signature check are the
// core's (`core/dilla-core/src/identity/device_list.rs`), reached through the guest, so the Go
// side never re-implements the format and cannot disagree with the client that produced it.
//
// It is declared here, with its Plan-1 stub, because ds.Options names the seam (the same reason
// as ACL and PermissiveChannels). Task 20's brief re-declares it beside checkAddedMember, its
// first caller; that step is a check against this declaration.
type DeviceLists interface {
	// Entries verifies the list's ssk_signature against the user's ssk_pub and returns the
	// dsk_pub of every entry that is not revoked. A list that does not verify is an error, and an
	// error is a refusal.
	Entries(ctx context.Context, userID id.ID) ([][]byte, error)
}

// ErrDeviceListUnavailable is what the Plan-1 DeviceLists answers for every user: the wasi ABI has
// no device-list export yet (NV-B8), so the DS cannot verify a list and must not pretend it can.
var ErrDeviceListUnavailable = errors.New("ds: the device-list verifier is not available")

// NewDeviceLists builds the DeviceLists invariant 4's Add clause uses.
//
// NV-B8: the wasi ABI has no device-list export yet. Until it does, Entries returns an error for
// every user, which makes every Add refuse with rule = "add_key_package" — the fail-closed
// direction, and the only honest one: a substring search over the serialized blob is not
// membership, because a 32-byte window can fall inside another entry's signature or any
// attacker-influenced field. The step that resolves it is one additive export,
// `device_list_entries([abi, blob, ssk_pub]) -> [0, [[dsk_pub, revoked]]]`, wrapping
// `dilla_core::identity::device_list`'s own verifier; it is a follow-up card.
//
// The repository and the runtime are held from here rather than passed at the first call site
// because that export is the only thing missing: when it lands, Entries reads the stored list
// through `repo` and verifies it through `wasm`, and no caller changes.
func NewDeviceLists(repo store.Repository, wasm *mlswasi.Runtime) DeviceLists {
	return &coreDeviceLists{repo: repo, wasm: wasm}
}

type coreDeviceLists struct {
	repo store.Repository
	wasm *mlswasi.Runtime
}

func (c *coreDeviceLists) Entries(_ context.Context, _ id.ID) ([][]byte, error) {
	return nil, ErrDeviceListUnavailable
}
