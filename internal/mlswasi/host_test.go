package mlswasi

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

func newTestRuntime(t *testing.T, opts Options) *Runtime {
	t.Helper()
	ctx := context.Background()
	if opts.CacheDir == "" {
		opts.CacheDir = sharedCacheDir(t)
	}
	r, err := New(ctx, loadWasm(t), opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		if err := r.Close(context.Background()); err != nil {
			t.Errorf("Close: %v", err)
		}
	})
	return r
}

// readAndFree copies a packed (ptr<<32)|len response out of linear memory and
// releases the guest buffer, the way Call does. The raw-pointer tests need it
// because they drive an export directly instead of through Call.
func readAndFree(t *testing.T, inst *Instance, packed uint64) []byte {
	t.Helper()
	ptr, length := uint32(packed>>32), uint32(packed)
	view, ok := inst.mod.Memory().Read(ptr, length)
	if !ok {
		t.Fatalf("reading %d bytes at %d exceeds the %d-byte memory", length, ptr, inst.mod.Memory().Size())
	}
	out := bytes.Clone(view)
	if _, err := inst.invoke(context.Background(), "dilla_free", inst.free, uint64(ptr), uint64(length)); err != nil {
		t.Fatalf("dilla_free: %v", err)
	}
	return out
}

// The export section is the ABI contract. It also records a measured fact that
// contradicts gap-19 item 8 and facts-wazero §3.1: a rustc 1.98.1 `cdylib` for
// wasm32-wasip1 is linked with `--no-entry` and no crt object, so the module
// exports the 17 dilla functions and `memory` and *no* `_initialize`. A guard
// that demanded `_initialize` would reject this correct artifact, so New must
// not; should a later build gain the reactor entry, this test says so.
func TestModuleExportsTheWasiABIAndNoReactorEntry(t *testing.T) {
	r := newTestRuntime(t, Options{PoolSize: 1})

	exported := r.compiled.ExportedFunctions()
	for _, name := range RequiredExports {
		if _, ok := exported[name]; !ok {
			t.Errorf("dilla_core_wasi.wasm is missing the export %q", name)
		}
	}
	if len(exported) != len(RequiredExports) {
		names := make([]string, 0, len(exported))
		for name := range exported {
			names = append(names, name)
		}
		t.Errorf("export section holds %d functions %v, want exactly the %d ABI exports",
			len(exported), names, len(RequiredExports))
	}
	if _, ok := exported["_initialize"]; ok {
		t.Error("this build exports _initialize after all: the module is a WASI reactor, " +
			"so RequiredExports must gain the name and New must assert it")
	}
	if len(r.compiled.ExportedMemories()) == 0 {
		t.Error("dilla_core_wasi.wasm exports no memory")
	}
}

// WithSysWalltime is load-bearing: wazero's default wall clock is a fake that
// starts near the Unix epoch, so every leaf's KeyPackage lifetime fails
// validation and from_external returns an error in microseconds. A wazero arm
// that looks impossibly fast is this bug, not a result (gap-18 4.5).
func TestClockAndRandomnessConfigurationIsLoadBearing(t *testing.T) {
	ctx := context.Background()
	f := loadDS1500(t)

	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()
	g, err := inst.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo)
	if err != nil {
		t.Fatalf("PublicGroupFromExternal with the configured clock: %v", err)
	}
	defer g.Close(ctx)
	state, err := g.State(ctx)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if len(state.Members) != f.manifest.Leaves {
		t.Fatalf("members = %d, want %d", len(state.Members), f.manifest.Leaves)
	}

	// Control: the same module with wazero's defaults must fail.
	ctrlRT := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigCompiler())
	defer ctrlRT.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, ctrlRT); err != nil {
		t.Fatalf("control wasi: %v", err)
	}
	ctrlCompiled, err := ctrlRT.CompileModule(ctx, loadWasm(t))
	if err != nil {
		t.Fatalf("control compile: %v", err)
	}
	ctrlMod, err := ctrlRT.InstantiateModule(ctx, ctrlCompiled,
		wazero.NewModuleConfig().WithName("").WithStartFunctions(startFunctions...))
	if err != nil {
		t.Fatalf("control instantiate: %v", err)
	}
	ctrl := &Instance{rt: r, mod: ctrlMod,
		alloc: ctrlMod.ExportedFunction("dilla_alloc"),
		free:  ctrlMod.ExportedFunction("dilla_free")}
	if _, err := ctrl.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo); err == nil {
		t.Fatal("from_external succeeded under wazero's fake 1ms-per-read clock; " +
			"WithSysWalltime is then not load-bearing and every later measurement is suspect")
	} else {
		t.Logf("control arm under wazero's default clock failed as it must: %v", err)
	}
}

func TestABIReportsVersionOne(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})
	info, err := r.ABI(ctx)
	if err != nil {
		t.Fatalf("ABI: %v", err)
	}
	if info.ABIVersion != 1 {
		t.Errorf("ABIVersion = %d, want 1", info.ABIVersion)
	}
	if info.E2EEVersion != 1 || info.MediaVersion != 1 {
		t.Errorf("E2EEVersion/MediaVersion = %d/%d, want 1/1", info.E2EEVersion, info.MediaVersion)
	}
	if info.CoreVersion == "" {
		t.Error("CoreVersion is empty")
	}
	if len(info.Ciphersuites) == 0 || info.Ciphersuites[0] != 1 {
		t.Errorf("Ciphersuites = %v, want the mandatory 0x0001 first", info.Ciphersuites)
	}
}

// dilla_alloc and dilla_free are the whole memory protocol: the host allocates
// the request buffer, the guest borrows it, the host frees both it and the
// response. Nothing else in the package works if this round trip does not.
func TestAllocAndFreeRoundTrip(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	const size = 4096
	out, err := inst.invoke(ctx, "dilla_alloc", inst.alloc, size)
	if err != nil {
		t.Fatalf("dilla_alloc: %v", err)
	}
	ptr := uint32(out[0])
	if ptr == 0 {
		t.Fatal("dilla_alloc returned a null pointer for a 4 KiB request")
	}
	if uint64(ptr)+size > uint64(inst.mod.Memory().Size()) {
		t.Fatalf("dilla_alloc returned %d, which is outside the %d-byte memory", ptr, inst.mod.Memory().Size())
	}
	payload := bytes.Repeat([]byte{0x5c}, size)
	if !inst.mod.Memory().Write(ptr, payload) {
		t.Fatalf("writing %d bytes at %d failed", size, ptr)
	}
	back, ok := inst.mod.Memory().Read(ptr, size)
	if !ok || !bytes.Equal(back, payload) {
		t.Fatal("the allocated region did not read back what was written into it")
	}
	if _, err := inst.invoke(ctx, "dilla_free", inst.free, uint64(ptr), size); err != nil {
		t.Fatalf("dilla_free: %v", err)
	}
	// A zero-length free is a no-op the guest tolerates, and a null pointer is
	// explicitly ignored rather than trapping.
	if _, err := inst.invoke(ctx, "dilla_free", inst.free, 0, 0); err != nil {
		t.Fatalf("dilla_free(0, 0): %v", err)
	}
	if inst.poisoned {
		t.Error("the alloc/free round trip trapped the instance")
	}
}

// The (ptr, len) bounds check of commit 20409c1: a pair naming bytes outside
// linear memory, or one whose sum wraps the 32-bit address space, must come
// back as an ordinary E_ABI_SHAPE failure frame the host can log — never as a
// trap and never as undefined behaviour inside the guest.
func TestAnOutOfRangeRequestIsAnAbiShapeFrameNotATrap(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	abiFn := inst.mod.ExportedFunction("dilla_abi")
	size := inst.mod.Memory().Size()
	for _, tc := range []struct {
		name     string
		ptr, len uint32
	}{
		{"one byte past the end", size, 1},
		{"a region straddling the end", size - 1, 2},
		{"a pair that wraps the address space", 0xffff_0000, 0x0001_0001},
	} {
		packed, err := inst.invoke(ctx, "dilla_abi", abiFn, uint64(tc.ptr), uint64(tc.len))
		if err != nil {
			t.Fatalf("%s: an out-of-range request must answer with a frame, not trap: %v", tc.name, err)
		}
		var abiErr *ABIError
		if _, err := responseElements(readAndFree(t, inst, packed[0])); !errors.As(err, &abiErr) {
			t.Errorf("%s: got %v, want an *ABIError", tc.name, err)
		} else if abiErr.Code != "E_ABI_SHAPE" {
			t.Errorf("%s: code = %q, want E_ABI_SHAPE", tc.name, abiErr.Code)
		}
		if inst.poisoned {
			t.Fatalf("%s: the instance was poisoned; the guard must keep the module usable", tc.name)
		}
	}

	// The module is still usable afterwards, which is the point of returning a
	// frame instead of trapping.
	req, err := encodeRequest()
	if err != nil {
		t.Fatalf("encodeRequest: %v", err)
	}
	if _, err := inst.Call(ctx, "dilla_abi", req); err != nil {
		t.Fatalf("the instance is unusable after a refused request: %v", err)
	}
}

// Memory.Read returns a view into linear memory that memory.grow invalidates,
// so Call must copy before any further guest call.
func TestCallCopiesTheResponseOutOfLinearMemory(t *testing.T) {
	ctx := context.Background()
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	req, err := encodeRequest()
	if err != nil {
		t.Fatalf("encodeRequest: %v", err)
	}
	first, err := inst.Call(ctx, "dilla_abi", req)
	if err != nil {
		t.Fatalf("dilla_abi: %v", err)
	}
	if len(first) == 0 {
		t.Fatal("dilla_abi returned an empty response")
	}

	// The guard: `first` must not alias linear memory at all. Compare the backing
	// arrays themselves, which needs nothing from wazero's slice headers and
	// nothing from the guest allocator.
	//
	// Two earlier framings of this check were inert and are gone. A cap()/len()
	// comparison cannot work: wazero v1.12.0's MemoryInstance.Read returns
	// `m.Buffer[offset : offset+byteCount : offset+byteCount]`
	// (internal/wasm/memory.go:165), a three-index slice, so a view has cap == len
	// exactly like a copy does. Scribbling over the block dilla_free just released
	// cannot work either: Call's deferred free of the *request* buffer runs after
	// the response is freed and reshuffles dlmalloc's free list, so the next
	// same-sized dilla_alloc does not hand the response block back.
	//
	// The copy is load-bearing rather than defensive: MemoryInstance.Grow
	// reassigns `m.Buffer` (memory.go:260), so a view Call leaked would point into
	// a stale array as soon as the guest grew memory. Take the whole-memory view
	// now, before any call that could move it.
	whole, ok := inst.mod.Memory().Read(0, inst.mod.Memory().Size())
	if !ok {
		t.Fatalf("reading the whole %d-byte linear memory failed", inst.mod.Memory().Size())
	}
	memBase := uintptr(unsafe.Pointer(unsafe.SliceData(whole)))
	respBase := uintptr(unsafe.Pointer(unsafe.SliceData(first)))
	if respBase >= memBase && respBase < memBase+uintptr(len(whole)) {
		t.Fatalf("Call returned a slice backed by wazero's linear memory at offset %d of %d bytes: "+
			"the response was not copied out", respBase-memBase, len(whole))
	}

	// A cheap extra rather than the guard: force the guest to allocate roughly a
	// megabyte and very likely grow memory. wazero's compiler grows inside an
	// mmap'd reservation, so an aliasing slice often survives this unchanged —
	// which is exactly why the pointer-identity guard above exists.
	snapshot := bytes.Clone(first)
	g, err := inst.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo)
	if err != nil {
		t.Fatalf("PublicGroupFromExternal: %v", err)
	}
	if _, _, _, err := g.Tree(ctx); err != nil {
		t.Fatalf("Tree: %v", err)
	}
	if err := g.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !bytes.Equal(first, snapshot) {
		t.Fatal("the first response changed after a later guest call: Call returned a view, not a copy")
	}
}

// NV8: interfaces.md §2.10 now states that the guest borrows the request buffer
// and the host frees it. If the guest instead took ownership (Vec::from_raw_parts),
// Call's deferred dilla_free would be a double free inside the guest allocator,
// which shows up later as an unrelated trap or as unbounded memory growth. 500
// round trips through the same allocator is a cheap, deterministic pin on that.
func TestRepeatedCallsDoNotCorruptTheGuestAllocator(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	req, err := encodeRequest()
	if err != nil {
		t.Fatalf("encodeRequest: %v", err)
	}
	var settled uint32
	for i := range 500 {
		if _, err := inst.Call(ctx, "dilla_abi", req); err != nil {
			t.Fatalf("dilla_abi call %d: %v", i, err)
		}
		if i == 49 {
			settled = inst.mod.Memory().Size()
		}
	}
	if grown := inst.mod.Memory().Size(); grown != settled {
		t.Errorf("linear memory grew from %d to %d bytes over 450 identical calls; the request "+
			"buffer is not being reclaimed exactly once (see NV8)", settled, grown)
	}
	if inst.poisoned {
		t.Error("the instance trapped during the loop")
	}
}

// The W1 roadmap card is "wazero spike (PublicGroup + **external Remove signing**)
// go/no-go" (spec line 643), and spec line 415 names signing external proposals as
// one of the three jobs dilla-core-wasi exists for. Half the card is therefore
// this export, so it has to be exercised on wasm32-wasip1 before the go/no-go is
// declared. interfaces.md §2.10 export 17 takes only group_id, epoch, leaf_index
// and a 32-byte signing key, so the committed fixture is sufficient and no
// KeyPackage is involved.
func TestExternalProposeRemoveSignsOnWasip1(t *testing.T) {
	ctx := context.Background()
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	signingKey := bytes.Repeat([]byte{0x42}, 32) // the instance's Ed25519 private half
	msg, err := inst.ExternalProposeRemove(ctx, f.groupID, f.manifest.Epoch, 0, signingKey)
	if err != nil {
		t.Fatalf("ExternalProposeRemove: %v", err)
	}
	if len(msg) == 0 {
		t.Fatal("external_propose_remove returned an empty MLS message")
	}
	if inst.poisoned {
		t.Fatal("signing an external Remove trapped the instance; the ABI must never trap")
	}

	// Ed25519 signing is deterministic (RFC 8032), and an external Remove frame
	// carries no timestamp or nonce, so the same inputs must give the same bytes.
	// A difference means something non-deterministic entered the frame and the
	// signing path is not what it looks like.
	again, err := inst.ExternalProposeRemove(ctx, f.groupID, f.manifest.Epoch, 0, signingKey)
	if err != nil {
		t.Fatalf("ExternalProposeRemove, second call: %v", err)
	}
	if !bytes.Equal(msg, again) {
		t.Errorf("two identical external Remove signings differ (%d vs %d bytes); Ed25519 is "+
			"deterministic and the frame carries no nonce", len(msg), len(again))
	}

	// A signing key of the wrong length is an ABI error frame, never a trap:
	// abi::open's bytes_exact::<32> rejects it.
	if _, err := inst.ExternalProposeRemove(ctx, f.groupID, f.manifest.Epoch, 0, signingKey[:31]); err == nil {
		t.Error("a 31-byte signing key was accepted")
	} else if errors.Is(err, ErrTrap) {
		t.Errorf("a 31-byte signing key trapped the guest: %v", err)
	}
	if inst.poisoned {
		t.Error("an ABI-level rejection poisoned the instance")
	}
}

// api.Function.Call is not goroutine-safe, so the pool must hand every
// goroutine its own instance. Run with -race.
func TestPoolIsConcurrentlyUsable(t *testing.T) {
	ctx := context.Background()
	const workers = 4
	r := newTestRuntime(t, Options{PoolSize: workers})

	var wg sync.WaitGroup
	errs := make(chan error, workers*8)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 8 {
				inst, err := r.Acquire(ctx)
				if err != nil {
					errs <- err
					return
				}
				req, err := encodeRequest()
				if err != nil {
					errs <- err
					inst.Release()
					return
				}
				if _, err := inst.Call(ctx, "dilla_abi", req); err != nil {
					errs <- err
				}
				inst.Release()
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent call: %v", err)
	}
}

// A trapped instance's linear memory, the allocator included, may be mid-update,
// so it must never go back into the pool.
func TestTrapPoisonsTheInstance(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})

	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	before := inst.mod
	// Ask the guest allocator for the whole 32-bit address space. wasm32 cannot
	// serve it, so Rust's handle_alloc_error runs and aborts the instance: that
	// is the one deterministic guest-side failure this ABI can be made to
	// produce, since every ordinary mistake is answered with an error frame.
	if _, err := inst.invoke(ctx, "dilla_alloc", inst.alloc, 0xffff_ffff); !errors.Is(err, ErrTrap) {
		t.Fatalf("an impossible dilla_alloc returned %v, want ErrTrap", err)
	}
	if !inst.poisoned {
		t.Fatal("a trapped instance was not marked poisoned")
	}
	inst.Release()

	again, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire after a trap: %v", err)
	}
	defer again.Release()
	if again.mod == before {
		t.Fatal("the poisoned module went back into the pool")
	}
	req, err := encodeRequest()
	if err != nil {
		t.Fatalf("encodeRequest: %v", err)
	}
	if _, err := again.Call(ctx, "dilla_abi", req); err != nil {
		t.Fatalf("replacement instance is not usable: %v", err)
	}
}

// Releasing twice must put one instance back, not two. Before Release was made
// idempotent the second call queued the same *Instance again, so the pool would
// hand one module to two callers at once — one linear memory, one guest
// allocator, and api.Function.Call is not goroutine-safe — and the corruption
// would surface in some unrelated call. Both instances of a two-instance pool are
// taken out first, so that the second, erroneous send has a free slot and the
// mistake shows up as an over-full pool rather than as a blocked goroutine.
func TestADoubleReleaseDoesNotQueueTheInstanceTwice(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 2})

	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	other, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire (second): %v", err)
	}
	defer other.Release()

	inst.Release()
	inst.Release() // the mistake under test

	held, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire after the double Release: %v", err)
	}
	defer held.Release()

	// One instance went back, and the other is still held: the pool is empty, so
	// a bounded Acquire can only end in its deadline. An instance here is the
	// double-queued one.
	short, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
	defer cancel()
	extra, err := r.Acquire(short)
	if err == nil {
		if extra.mod == held.mod {
			t.Fatal("the double Release queued the instance twice: one module, two callers")
		}
		extra.Release()
		t.Fatal("the pool grew a third instance from a double Release")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("Acquire on an empty pool returned %v, want context.DeadlineExceeded", err)
	}

	// The released handle is spent, and says so rather than dereferencing the
	// module the pool has since handed to someone else.
	req, err := encodeRequest()
	if err != nil {
		t.Fatalf("encodeRequest: %v", err)
	}
	if _, err := inst.Call(ctx, "dilla_abi", req); !errors.Is(err, ErrReleased) {
		t.Errorf("Call on a released instance returned %v, want ErrReleased", err)
	}

	// The instance that went back into circulation is unharmed.
	if _, err := held.Call(ctx, "dilla_abi", req); err != nil {
		t.Errorf("the pooled instance is not usable: %v", err)
	}
}

func TestABIErrorsNeverTrap(t *testing.T) {
	ctx := context.Background()
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	// A handle that was never allocated.
	bogus := &PublicGroup{inst: inst, handle: 0xdeadbeef}
	_, err = bogus.ExportState(ctx)
	var abiErr *ABIError
	if !errors.As(err, &abiErr) {
		t.Fatalf("export_state on a bogus handle returned %v, want an *ABIError", err)
	}
	if abiErr.Code != "E_ABI_HANDLE" {
		t.Errorf("code = %q, want E_ABI_HANDLE", abiErr.Code)
	}
	if errors.Is(err, ErrTrap) {
		t.Error("a bad handle trapped; the ABI must return a frame, never trap")
	}
	if inst.poisoned {
		t.Error("an ABI-level error poisoned the instance")
	}

	// An unknown ABI version is an error frame, not a trap.
	req, err := encodeRequestVersion(9999)
	if err != nil {
		t.Fatalf("encodeRequestVersion: %v", err)
	}
	resp, err := inst.Call(ctx, "dilla_abi", req)
	if err != nil {
		t.Fatalf("dilla_abi with a bad version: %v", err)
	}
	if _, err := responseElements(resp); !errors.As(err, &abiErr) || abiErr.Code != "E_ABI_VERSION" {
		t.Errorf("bad abi version gave %v, want an *ABIError with code E_ABI_VERSION", err)
	}
}

func TestStateRoundTripsThroughExportAndImport(t *testing.T) {
	ctx := context.Background()
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
	if err != nil {
		t.Fatalf("PublicGroupImport: %v", err)
	}
	state, err := g.State(ctx)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Epoch != f.manifest.Epoch {
		t.Errorf("epoch = %d, want %d", state.Epoch, f.manifest.Epoch)
	}
	if !bytes.Equal(state.TreeHash, f.treeHash) {
		t.Errorf("tree hash = %x, want %x", state.TreeHash, f.treeHash)
	}
	blob, err := g.ExportState(ctx)
	if err != nil {
		t.Fatalf("ExportState: %v", err)
	}
	if len(blob) == 0 || blob[0] != 1 {
		t.Fatalf("exported state does not start with the version byte 1: %x", blob[:min(8, len(blob))])
	}
	if err := g.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}

	again, err := inst.PublicGroupImport(ctx, blob, f.groupID)
	if err != nil {
		t.Fatalf("re-import: %v", err)
	}
	defer again.Close(ctx)
	back, err := again.State(ctx)
	if err != nil {
		t.Fatalf("State after re-import: %v", err)
	}
	if back.Epoch != state.Epoch || !bytes.Equal(back.TreeHash, state.TreeHash) {
		t.Errorf("re-imported state differs: epoch %d/%d, tree hash %x/%x",
			back.Epoch, state.Epoch, back.TreeHash, state.TreeHash)
	}
}

func TestCommitProcessAndMerge(t *testing.T) {
	ctx := context.Background()
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{PoolSize: 1})
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
	if err != nil {
		t.Fatalf("PublicGroupImport: %v", err)
	}
	defer g.Close(ctx)

	p, err := g.Process(ctx, f.commits[0])
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if p.Kind != KindCommit {
		t.Fatalf("kind = %d, want KindCommit", p.Kind)
	}
	if p.Staged == nil {
		t.Fatal("a commit produced no staged handle")
	}
	epoch, err := g.Merge(ctx, *p.Staged)
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if epoch != f.manifest.Epoch+1 {
		t.Errorf("epoch after merge = %d, want %d", epoch, f.manifest.Epoch+1)
	}
}

func TestNewNamesTheMissingExport(t *testing.T) {
	// A module that is not dilla-core-wasi carries none of the ABI, and wazero
	// would happily instantiate it; New must refuse it by name.
	_, err := New(context.Background(), []byte("\x00asm\x01\x00\x00\x00"), Options{PoolSize: 1})
	if err == nil {
		t.Fatal("New accepted a module with no exports")
	}
	if !strings.Contains(err.Error(), "missing export") {
		t.Errorf("New error = %v, want it to name the missing export", err)
	}
}
