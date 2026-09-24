package mlswasi

import (
	"context"
	"math"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// R10's thresholds. gap-18 5.2 derives tighter ones (p99 <= 100 ms for a
// 256-Add commit); the rulings override the lens, and the report records both.
const (
	gateCommitP50    = 1 * time.Second
	gateTreeImport   = 5 * time.Second
	gateRSSPerModule = 512 << 20 // bytes
	gateSamples      = 50
	gateInstances    = 8
)

// requireGate skips unless DILLA_GATE=1. R10's thresholds are defined "on the dev
// box (16 cores, 30 GB)"; GitHub's ubuntu-latest is a shared 4-vCPU / 16 GB runner
// (gap-22 item 10's runner table) and CI additionally runs the package under
// -race. Timing the same code under different hardware and instrumentation than
// the threshold was calibrated for produces either a spurious red build or a
// number that means nothing, and a NO-GO is a product decision that must not be
// taken by a runner. The correctness assertions this gate would otherwise carry
// (1,500 members, epoch+1, KindCommit) are asserted unconditionally by
// host_test.go, so nothing is lost by skipping here.
func requireGate(tb testing.TB) {
	tb.Helper()
	if os.Getenv("DILLA_GATE") != "1" {
		tb.Skip("set DILLA_GATE=1 to run the R10 go/no-go gate; its thresholds are calibrated " +
			"on the dev box (16 cores, 30 GB), not on a CI runner")
	}
}

// residentBytes reads the resident set size from /proc/self/statm. Go exposes
// no per-instance figure, so the gate measures a whole-process delta across
// gateInstances instances and divides; the report says so.
func residentBytes(tb testing.TB) uint64 {
	tb.Helper()
	if runtime.GOOS != "linux" {
		tb.Skipf("resident-set measurement needs /proc; GOOS is %s", runtime.GOOS)
	}
	raw, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		tb.Fatalf("read /proc/self/statm: %v", err)
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		tb.Fatalf("/proc/self/statm has %d fields, want at least 2", len(fields))
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		tb.Fatalf("parse resident pages %q: %v", fields[1], err)
	}
	return pages * uint64(os.Getpagesize())
}

// percentile is the nearest-rank definition: the p-th percentile of n sorted
// samples is the one at rank ceil(p*n), counting from 1.
//
// The earlier `int(p * float64(len(sorted)-1))` is the *index* half of linear
// interpolation with the interpolation dropped and the remainder truncated
// towards zero, so for n = 50 it returned the 49th sample as p99 — the second
// largest. A p99 that can never be the largest sample under-reports precisely the
// tail the gate exists to watch. p50 is unaffected at n = 50: both spellings give
// the 25th.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// Arithmetic only, so it runs in CI: the gate tests it feeds are DILLA_GATE-only,
// which would otherwise leave the definition unasserted everywhere.
func TestPercentileIsNearestRank(t *testing.T) {
	samples := make([]time.Duration, 50)
	for i := range samples {
		samples[i] = time.Duration(i+1) * time.Millisecond // 1ms .. 50ms, sorted
	}

	for _, tc := range []struct {
		name string
		p    float64
		want time.Duration
	}{
		// ceil(0.99*50) = 50, i.e. the largest sample. The old index gave 49ms.
		{"p99 of 50 samples is the 50th", 0.99, 50 * time.Millisecond},
		{"p50 of 50 samples is the 25th", 0.50, 25 * time.Millisecond},
		{"p100 is the last", 1.0, 50 * time.Millisecond},
		{"p0 is the first", 0, 1 * time.Millisecond},
	} {
		if got := percentile(samples, tc.p); got != tc.want {
			t.Errorf("%s: percentile(50 samples, %v) = %s, want %s", tc.name, tc.p, got, tc.want)
		}
	}

	// One sample is its own every percentile, and no percentile may index past the
	// slice: the gate calls this with whatever the run produced.
	if got := percentile([]time.Duration{7 * time.Millisecond}, 0.99); got != 7*time.Millisecond {
		t.Errorf("percentile(1 sample, 0.99) = %s, want 7ms", got)
	}
	if got := percentile(nil, 0.99); got != 0 {
		t.Errorf("percentile(nil, 0.99) = %s, want 0", got)
	}
}

// TestGoNoGoTreeImport measures PublicGroupFromExternal on the 1,500-leaf tree.
func TestGoNoGoTreeImport(t *testing.T) {
	requireGate(t)
	ctx := context.Background()
	f := loadDS1500(t)
	r, err := New(ctx, loadWasm(t), Options{PoolSize: 1, CacheDir: sharedCacheDir(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close(ctx)
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	samples := make([]time.Duration, 0, 5)
	for range 5 {
		start := time.Now()
		g, err := inst.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo)
		if err != nil {
			t.Fatalf("PublicGroupFromExternal: %v", err)
		}
		samples = append(samples, time.Since(start))

		// Assert the result, not just the absence of an error: an MLS
		// validation failure is fast, and success is what is being timed.
		state, err := g.State(ctx)
		if err != nil {
			t.Fatalf("State: %v", err)
		}
		if len(state.Members) != f.manifest.Leaves {
			t.Fatalf("members = %d, want %d", len(state.Members), f.manifest.Leaves)
		}
		if err := g.Close(ctx); err != nil {
			t.Fatalf("Close: %v", err)
		}
	}
	slices.Sort(samples)
	p50 := percentile(samples, 0.50)
	t.Logf("GATE tree_import p50=%s min=%s max=%s (threshold %s)", p50, samples[0], samples[len(samples)-1], gateTreeImport)
	if p50 > gateTreeImport {
		t.Errorf("NO-GO: tree import p50 %s exceeds R10's %s", p50, gateTreeImport)
	}
}

// TestGoNoGoCommitLatency is the decisive number: Process + Merge for one commit
// against a freshly imported 1,500-leaf base state. go test -bench reports a
// mean, never a percentile, so the gate lives in a test.
func TestGoNoGoCommitLatency(t *testing.T) {
	requireGate(t)
	ctx := context.Background()
	f := loadDS1500(t)
	r, err := New(ctx, loadWasm(t), Options{PoolSize: 1, CacheDir: sharedCacheDir(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close(ctx)
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer inst.Release()

	// commits/00..07 are 256-Add batches, 08 a Remove and 09 a self-Update.
	// gap-18 2.2: the 256-Add batch is the worst case, because OpenMLS runs
	// validate_leaf_node_capabilities once per queued proposal.
	shapes := map[string][]int{
		"add256": {0, 1, 2, 3, 4, 5, 6, 7},
		"remove": {8},
		"update": {9},
	}
	for name, indices := range shapes {
		t.Run(name, func(t *testing.T) {
			samples := make([]time.Duration, 0, gateSamples)
			for i := range gateSamples {
				commit := f.commits[indices[i%len(indices)]]

				g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
				if err != nil {
					t.Fatalf("PublicGroupImport: %v", err)
				}
				start := time.Now()
				p, err := g.Process(ctx, commit)
				if err != nil {
					t.Fatalf("Process: %v", err)
				}
				if p.Kind != KindCommit || p.Staged == nil {
					t.Fatalf("kind = %d, staged = %v; want a staged commit", p.Kind, p.Staged)
				}
				epoch, err := g.Merge(ctx, *p.Staged)
				if err != nil {
					t.Fatalf("Merge: %v", err)
				}
				samples = append(samples, time.Since(start))

				if epoch != f.manifest.Epoch+1 {
					t.Fatalf("epoch = %d, want %d", epoch, f.manifest.Epoch+1)
				}
				if err := g.Close(ctx); err != nil {
					t.Fatalf("Close: %v", err)
				}
			}
			slices.Sort(samples)
			p50 := percentile(samples, 0.50)
			p99 := percentile(samples, 0.99)
			t.Logf("GATE commit_%s n=%d p50=%s p99=%s min=%s max=%s (R10 p50 threshold %s; gap-18 p99 GO<=100ms NO-GO>300ms)",
				name, len(samples), p50, p99, samples[0], samples[len(samples)-1], gateCommitP50)
			if p50 > gateCommitP50 {
				t.Errorf("NO-GO: commit_%s p50 %s exceeds R10's %s", name, p50, gateCommitP50)
			}
		})
	}
}

// TestGoNoGoResidentMemory measures the whole-process RSS growth across
// gateInstances instances, each holding an imported 1,500-leaf group.
//
// R10's metric is "resident memory per instance", so the baseline is taken
// BEFORE New: instantiating the pool allocates each instance's linear memory and
// wazero's own per-instance state, and a baseline taken after New would exclude
// all of it and report only the cost of PublicGroupImport. The figure therefore
// includes wazero's compiled-code pages, amortised over the instances; the report
// says so and records the two halves separately.
//
// Run it alone. Under -shuffle=on whatever ran before it varies run to run, and
// under -race the shadow-memory allocations dominate the delta:
//
//	DILLA_GATE=1 go test ./internal/mlswasi/ -run TestGoNoGoResidentMemory -v -count 1
func TestGoNoGoResidentMemory(t *testing.T) {
	requireGate(t)
	ctx := context.Background()
	f := loadDS1500(t)

	runtime.GC()
	beforeNew := residentBytes(t)

	r, err := New(ctx, loadWasm(t), Options{PoolSize: gateInstances, CacheDir: sharedCacheDir(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer r.Close(ctx)

	runtime.GC()
	afterNew := residentBytes(t)

	held := make([]*Instance, 0, gateInstances)
	groups := make([]*PublicGroup, 0, gateInstances)
	for range gateInstances {
		inst, err := r.Acquire(ctx)
		if err != nil {
			t.Fatalf("Acquire: %v", err)
		}
		held = append(held, inst)
		g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
		if err != nil {
			t.Fatalf("PublicGroupImport: %v", err)
		}
		groups = append(groups, g)
	}
	runtime.GC()
	afterImport := residentBytes(t)

	for i, g := range groups {
		if err := g.Close(ctx); err != nil {
			t.Errorf("Close group %d: %v", i, err)
		}
	}
	for _, inst := range held {
		inst.Release()
	}

	// A negative delta means the process was already above its high-water mark
	// when the baseline was taken (Go does not return freed heap promptly), so the
	// number is noise, not a NO-GO. Skip rather than fail: a NO-GO must rest on a
	// measurement, and this one is not usable.
	if afterImport < beforeNew {
		t.Skipf("resident set went %d -> %d bytes (down); the measurement is not usable in this "+
			"process — re-run alone with -count 1", beforeNew, afterImport)
	}
	// All three are uint64, so every subtraction is guarded: an unguarded one
	// underflows to a nonsense figure rather than to a negative number.
	total := (afterImport - beforeNew) / gateInstances
	instantiation := uint64(0)
	if afterNew > beforeNew {
		instantiation = (afterNew - beforeNew) / gateInstances
	}
	imports := uint64(0)
	if afterImport > afterNew {
		imports = (afterImport - afterNew) / gateInstances
	}
	t.Logf("GATE rss_per_instance=%d bytes (%.1f MiB) over %d instances "+
		"[instantiation %d B + import %d B], process %d -> %d -> %d bytes (threshold %d bytes)",
		total, float64(total)/(1<<20), gateInstances, instantiation, imports,
		beforeNew, afterNew, afterImport, gateRSSPerModule)
	if total > gateRSSPerModule {
		t.Errorf("NO-GO: %d bytes resident per instance exceeds R10's %d", total, gateRSSPerModule)
	}
}
