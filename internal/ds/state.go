package ds

import (
	"context"
	"fmt"
	"sync"

	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

// stateCache holds live PublicGroup handles, each inside the wasm instance that created it: a
// handle is valid only there (mlswasi's package contract), so the instance travels with it.
//
// Two bounds make that safe, and both are load-bearing:
//
//  1. The cache holds at most `capacity` groups, which is `PoolSize - 1`. `Runtime.Acquire`
//     blocks on a buffered channel of `PoolSize` instances (`internal/mlswasi/pool.go:34-46`), so
//     an unbounded cache stops serving the moment the number of live groups reaches the pool size
//     — on a default `PoolSize = GOMAXPROCS` that is a handful of groups. The least recently used
//     group is closed and its instance released to make room; the next request for it re-imports
//     its blob, which is exactly what `withGroup` already does on a cold cache.
//  2. `Runtime.Acquire` is NEVER called while `c.mu` is held. Acquire blocks, and blocking under
//     the cache mutex freezes every other group, `evict` included.
//
// `liveGroup` has its own mutex because `mlswasi.Instance` is not safe for concurrent use: two
// requests for one group must not call into the same module at once. Every path that touches a
// handle goes through `withGroup`, which holds it for the duration of the call sequence.
type stateCache struct {
	wasm     *mlswasi.Runtime
	capacity int

	mu     sync.Mutex
	groups map[id.ID]*liveGroup
	lru    []id.ID // least recently used first
}

type liveGroup struct {
	mu    sync.Mutex
	inst  *mlswasi.Instance
	group *mlswasi.PublicGroup
}

func newStateCache(w *mlswasi.Runtime) *stateCache {
	capacity := 1
	if w != nil {
		capacity = w.PoolSize() - 1
	}
	if capacity < 1 {
		capacity = 1
	}
	return &stateCache{wasm: w, capacity: capacity, groups: map[id.ID]*liveGroup{}}
}

// withGroup runs fn against the group's live PublicGroup, importing the stored blob on first use.
// The import is lazy and per group: a restart with 10,000 groups costs nothing until a request
// arrives for one of them.
func (d *DS) withGroup(ctx context.Context, groupID id.ID, fn func(*mlswasi.PublicGroup) error) error {
	live, err := d.states.acquire(ctx, groupID, func() ([]byte, error) {
		row, err := d.opts.Store.GetGroup(ctx, groupID)
		if err != nil {
			return nil, err
		}
		if len(row.PublicGroupState) == 0 {
			return nil, fmt.Errorf("group %s has no state blob", groupID)
		}
		return row.PublicGroupState, nil
	})
	if err != nil {
		return err
	}
	// mlswasi.Instance is not safe for concurrent use (internal/mlswasi/pool.go:21-23) and the
	// cache hands the same instance to every caller of a group, so the handle lock is held for
	// the whole call sequence. Two concurrent GET /tree on one group — the ordinary joiner path —
	// would otherwise call api.Function.Call on one module at once and corrupt the guest
	// allocator, which -race cannot see.
	live.mu.Lock()
	defer live.mu.Unlock()
	return fn(live.group)
}

func (c *stateCache) acquire(ctx context.Context, groupID id.ID, load func() ([]byte, error)) (*liveGroup, error) {
	c.mu.Lock()
	if live, ok := c.groups[groupID]; ok {
		c.touchLocked(groupID)
		c.mu.Unlock()
		return live, nil
	}
	c.mu.Unlock()

	blob, err := load()
	if err != nil {
		return nil, err
	}
	// Make room BEFORE acquiring, and acquire OUTSIDE the cache mutex: Acquire blocks on the
	// pool's channel, and holding c.mu across it deadlocks every other group behind one slow
	// import.
	if err := c.evictUntilRoom(ctx); err != nil {
		return nil, err
	}
	inst, err := c.wasm.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	group, err := inst.PublicGroupImport(ctx, blob, groupID[:])
	if err != nil {
		inst.Release()
		return nil, err
	}

	c.mu.Lock()
	if existing, ok := c.groups[groupID]; ok {
		// Another goroutine imported the same group while this one was in the guest. Keep theirs
		// and give this instance straight back, rather than leaking it.
		c.touchLocked(groupID)
		c.mu.Unlock()
		_ = group.Close(ctx)
		inst.Release()
		return existing, nil
	}
	live := &liveGroup{inst: inst, group: group}
	c.groups[groupID] = live
	c.lru = append(c.lru, groupID)
	c.mu.Unlock()
	return live, nil
}

// evictUntilRoom closes least-recently-used groups until the cache is below capacity.
func (c *stateCache) evictUntilRoom(ctx context.Context) error {
	for {
		c.mu.Lock()
		if len(c.groups) < c.capacity || len(c.lru) == 0 {
			c.mu.Unlock()
			return nil
		}
		victim := c.lru[0]
		c.mu.Unlock()
		if err := c.evict(ctx, victim); err != nil {
			return err
		}
	}
}

func (c *stateCache) touchLocked(groupID id.ID) {
	for i, g := range c.lru {
		if g == groupID {
			c.lru = append(append(c.lru[:i:i], c.lru[i+1:]...), groupID)
			return
		}
	}
	c.lru = append(c.lru, groupID)
}

// put installs a freshly created handle, which registration and heal produce. It makes room the
// same way acquire does, so a burst of registrations cannot exhaust the pool either, and it
// evicts any handle already under that id rather than dropping it on the floor: an overwritten
// handle would hold its instance out of the pool for the life of the process.
func (c *stateCache) put(ctx context.Context, groupID id.ID, inst *mlswasi.Instance, group *mlswasi.PublicGroup) error {
	if err := c.evict(ctx, groupID); err != nil {
		return err
	}
	if err := c.evictUntilRoom(ctx); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.groups[groupID] = &liveGroup{inst: inst, group: group}
	c.touchLocked(groupID)
	return nil
}

// evict drops a handle, which restore, close and the LRU do; the next request re-imports.
func (c *stateCache) evict(ctx context.Context, groupID id.ID) error {
	c.mu.Lock()
	live, ok := c.groups[groupID]
	delete(c.groups, groupID)
	for i, g := range c.lru {
		if g == groupID {
			c.lru = append(c.lru[:i:i], c.lru[i+1:]...)
			break
		}
	}
	c.mu.Unlock()
	if !ok {
		return nil
	}
	// The handle may be mid-call; waiting for it is what makes eviction safe.
	live.mu.Lock()
	defer live.mu.Unlock()
	err := live.group.Close(ctx)
	live.inst.Release()
	return err
}

func (c *stateCache) closeAll(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var firstErr error
	for gid, live := range c.groups {
		if err := live.group.Close(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
		live.inst.Release()
		delete(c.groups, gid)
	}
	c.lru = nil
	return firstErr
}

// persistState writes the group's state blob and its derived columns. Every caller runs it inside
// the same transaction as the handshake row it belongs to (R12).
func persistState(ctx context.Context, repo store.Repository, groupID id.ID, g *mlswasi.PublicGroup, groupInfo []byte) error {
	blob, err := g.ExportState(ctx)
	if err != nil {
		return err
	}
	state, err := g.State(ctx)
	if err != nil {
		return err
	}
	return repo.PutGroupState(ctx, groupID, state.Epoch, blob, groupInfo, state.TreeHash)
}

// decodeCredentialIdentity reads dilla's CredentialIdentity out of a leaf credential.
//
// The layout is `core/dilla-core/src/identity/credential.rs:28-42`, and it is a TEN-element
// fixed-position array, not three:
//
//	[v, umk_pub(32), user_id(16), device_id(16), kind, tier, signer_tier,
//	 ssk_pub(32), sig_umk_ssk(64), sig_ssk_dev(64)]
//
// so user_id is at index 2 and device_id at index 3 — reading them at 1 and 2 would take
// `umk_pub` for the device id and `user_id` for the device id, and the length check alone rejects
// every real credential. `protocol/vectors/identity.json`'s `credential_identity.cbor` is the
// committed example, and TestCredentialIdentityDecodesTheCommittedVector decodes it.
//
// The DS never invents a credential; it only reads what the core validated, and it deliberately
// does not verify the two signatures here — `validate_key_package` and the guest's own leaf
// validation already did.
func decodeCredentialIdentity(b []byte) (deviceID, userID id.ID, err error) {
	var elems []cbor.RawMessage
	if err := cborx.Unmarshal(b, &elems); err != nil {
		return id.ID{}, id.ID{}, err
	}
	if len(elems) != 10 {
		return id.ID{}, id.ID{}, fmt.Errorf("credential identity has %d elements, want 10", len(elems))
	}
	if err := cborx.Unmarshal(elems[2], &userID); err != nil {
		return id.ID{}, id.ID{}, fmt.Errorf("credential identity user_id: %w", err)
	}
	if err := cborx.Unmarshal(elems[3], &deviceID); err != nil {
		return id.ID{}, id.ID{}, fmt.Errorf("credential identity device_id: %w", err)
	}
	return deviceID, userID, nil
}

// Binding is `dilla_binding`, group context extension 0xF001. The layout is
// `core/dilla-core/src/mls/binding.rs:70-82` and `protocol/01-groups.md`: a deterministic-CBOR
// EIGHT-element fixed-position array. `protocol/00` states that every dilla structure is a CBOR
// array, never a map, so there are no field names on the wire and no JSON anywhere.
//
//	[v, instance_id(16), community_id(16|null), target_id(16), kind, policy_version,
//	 e2ee_version, media_version]
//
// There is no `call_id` member: R9 puts the call id in a companion column.
type Binding struct {
	_             struct{} `cbor:",toarray"`
	V             uint64
	InstanceID    id.ID
	CommunityID   *id.ID
	TargetID      id.ID
	Kind          uint8
	PolicyVersion uint64
	E2EEVersion   uint64
	MediaVersion  uint64
}

// decodeBinding reads the bytes `public_group_state` handed over as a bstr wrapping the array
// (`core/dilla-core-wasi/src/exports.rs:249-263`, deviation A2-13).
func decodeBinding(b []byte) (Binding, error) {
	var out Binding
	if err := cborx.Unmarshal(b, &out); err != nil {
		return Binding{}, err
	}
	return out, nil
}

// callIDOf is the companion-column value of R9: for a call group the binding's target IS the call,
// and for every other kind there is no call.
func callIDOf(b Binding) *id.ID {
	const kindCall = 1
	if b.Kind != kindCall {
		return nil
	}
	target := b.TargetID
	return &target
}
