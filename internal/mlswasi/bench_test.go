package mlswasi

import (
	"context"
	"testing"
)

// benchRuntime builds a runtime outside the measured loop. wazero's own guidance
// is to compile during initialization; CompileModule is ahead-of-time and must
// never be inside b.Loop.
func benchRuntime(b *testing.B, interpreter bool) (*Runtime, *Instance) {
	b.Helper()
	ctx := context.Background()
	r, err := New(ctx, loadWasm(b), Options{PoolSize: 1, CacheDir: sharedCacheDir(b), Interpreter: interpreter})
	if err != nil {
		b.Fatalf("New: %v", err)
	}
	inst, err := r.Acquire(ctx)
	if err != nil {
		b.Fatalf("Acquire: %v", err)
	}
	b.Cleanup(func() {
		inst.Release()
		_ = r.Close(context.Background())
	})
	return r, inst
}

// BenchmarkPublicGroupFromExternal1500 is R10's tree-import measurement and
// gap-18's gate G4.
func BenchmarkPublicGroupFromExternal1500(b *testing.B) {
	ctx := context.Background()
	f := loadDS1500(b)
	_, inst := benchRuntime(b, false)

	b.ReportAllocs()
	b.SetBytes(int64(len(f.ratchetTree) + len(f.groupInfo)))
	for b.Loop() {
		g, err := inst.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo)
		if err != nil {
			b.Fatalf("PublicGroupFromExternal: %v", err)
		}
		if err := g.Close(ctx); err != nil {
			b.Fatalf("Close: %v", err)
		}
	}
}

// BenchmarkPublicGroupImportState1500 is the subtractable baseline: every
// commit benchmark below imports the same base state before it measures, so
// commit cost = BenchmarkCommitApply1500 - this.
func BenchmarkPublicGroupImportState1500(b *testing.B) {
	ctx := context.Background()
	f := loadDS1500(b)
	_, inst := benchRuntime(b, false)

	b.ReportAllocs()
	b.SetBytes(int64(len(f.baseState)))
	for b.Loop() {
		g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
		if err != nil {
			b.Fatalf("PublicGroupImport: %v", err)
		}
		if err := g.Close(ctx); err != nil {
			b.Fatalf("Close: %v", err)
		}
	}
}

func benchCommit(b *testing.B, commitIndex int, interpreter bool) {
	ctx := context.Background()
	f := loadDS1500(b)
	_, inst := benchRuntime(b, interpreter)
	commit := f.commits[commitIndex]

	b.ReportAllocs()
	b.SetBytes(int64(len(commit)))
	for b.Loop() {
		// Each measurement runs against a freshly imported 1,500-leaf base
		// state, exactly as R10 requires: the ten commits are alternatives at
		// the same epoch, not a sequence.
		g, err := inst.PublicGroupImport(ctx, f.baseState, f.groupID)
		if err != nil {
			b.Fatalf("PublicGroupImport: %v", err)
		}
		p, err := g.Process(ctx, commit)
		if err != nil {
			b.Fatalf("Process: %v", err)
		}
		if p.Staged == nil {
			b.Fatalf("commit %02d produced no staged handle", commitIndex)
		}
		if _, err := g.Merge(ctx, *p.Staged); err != nil {
			b.Fatalf("Merge: %v", err)
		}
		if err := g.Close(ctx); err != nil {
			b.Fatalf("Close: %v", err)
		}
	}
}

// BenchmarkCommitApply1500 measures import + Process + Merge for each of the
// ten fixture commits: 00..07 are 256-Add batches, 08 is a Remove, 09 a
// self-Update.
func BenchmarkCommitApply1500(b *testing.B) {
	names := []string{
		"00_add256", "01_add256", "02_add256", "03_add256",
		"04_add256", "05_add256", "06_add256", "07_add256",
		"08_remove", "09_update",
	}
	for i, name := range names {
		b.Run(name, func(b *testing.B) { benchCommit(b, i, false) })
	}
}

// BenchmarkCommitApply1500Interpreter is the compiler-versus-interpreter ratio
// the report records. One shape is enough for the ratio.
func BenchmarkCommitApply1500Interpreter(b *testing.B) {
	b.Run("00_add256", func(b *testing.B) { benchCommit(b, 0, true) })
	b.Run("08_remove", func(b *testing.B) { benchCommit(b, 8, true) })
}
