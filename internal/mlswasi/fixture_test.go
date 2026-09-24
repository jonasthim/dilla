package mlswasi

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fixtureDir is testkit/fixtures/ds-1500 relative to internal/mlswasi.
const fixtureDir = "../../testkit/fixtures/ds-1500"

// wasmPath is the wasm32-wasip1 build of dilla-core-wasi. CI supplies it by
// downloading the `dilla-core-wasi` artifact of the `rust-wasi` job into
// internal/mlswasi/testdata.
const wasmPath = "testdata/dilla_core_wasi.wasm"

// fixtureManifest mirrors testkit's FixtureManifest (interfaces.md 2.12). The
// key spelling is serde's default, i.e. the Rust field names verbatim.
type fixtureManifest struct {
	Leaves         int    `json:"leaves"`
	Epoch          uint64 `json:"epoch"`
	GroupIDHex     string `json:"group_id_hex"`
	TreeHashHex    string `json:"tree_hash_hex"`
	NotAfter       uint64 `json:"not_after"`
	OpenMLSVersion string `json:"openmls_version"`
	Files          []struct {
		Path      string `json:"path"`
		SHA256Hex string `json:"sha256_hex"`
		Bytes     uint64 `json:"bytes"`
	} `json:"files"`
}

type fixture struct {
	manifest    fixtureManifest
	groupID     []byte
	treeHash    []byte
	ratchetTree []byte
	groupInfo   []byte
	baseState   []byte
	commits     [][]byte // commits/00.mls .. commits/09.mls, in file order
}

// TestMain removes the shared wazero compilation cache after the package's tests
// have finished.
func TestMain(m *testing.M) {
	code := m.Run()
	if cacheDir != "" {
		_ = os.RemoveAll(cacheDir)
	}
	os.Exit(code)
}

var (
	cacheOnce sync.Once
	cacheDir  string
	cacheErr  error
)

// sharedCacheDir returns one wazero compilation-cache directory for the whole
// package. Every Runtime in these tests uses it, so the large OpenMLS module is
// compiled ahead of time once per `go test` run instead of once per test: with a
// per-test t.TempDir() the package pays that cost roughly sixteen times, and
// gap-31 §5 records wazero's compile time on a large OpenMLS module as
// unmeasured, so it is not a cost to pay blind.
func sharedCacheDir(tb testing.TB) string {
	tb.Helper()
	cacheOnce.Do(func() { cacheDir, cacheErr = os.MkdirTemp("", "mlswasi-cache-") })
	if cacheErr != nil {
		tb.Fatalf("create the shared wazero compilation cache: %v", cacheErr)
	}
	return cacheDir
}

// loadWasm returns the wasi module, failing loudly (never skipping) when it is
// absent: an absent core means the cross-target conformance leg did not run.
func loadWasm(tb testing.TB) []byte {
	tb.Helper()
	b, err := os.ReadFile(wasmPath)
	if err != nil {
		tb.Fatalf("%s is missing: build it with\n"+
			"  cargo build -p dilla-core-wasi --target wasm32-wasip1 --release --locked\n"+
			"or download the `dilla-core-wasi` artifact of the CI job `rust-wasi` into\n"+
			"internal/mlswasi/testdata. Underlying error: %v", wasmPath, err)
	}
	return b
}

// loadDS1500 reads the committed 1,500-leaf fixture and refuses to run once its
// KeyPackage lifetimes have expired, because PublicGroup::from_external
// validates every leaf's lifetime and would otherwise fail with an opaque MLS
// error (gap-18 item 10).
func loadDS1500(tb testing.TB) fixture {
	tb.Helper()

	raw, err := os.ReadFile(filepath.Join(fixtureDir, "manifest.json"))
	if err != nil {
		tb.Fatalf("%s/manifest.json is missing: regenerate it with\n"+
			"  cargo run -p dilla-testkit --bin dilla-testkit -- gen-public-group --leaves 1500 --out testkit/fixtures/ds-1500/\n"+
			"Underlying error: %v", fixtureDir, err)
	}
	var m fixtureManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		tb.Fatalf("manifest.json: %v", err)
	}
	for key, ok := range map[string]bool{
		"leaves":        m.Leaves > 0,
		"group_id_hex":  m.GroupIDHex != "",
		"tree_hash_hex": m.TreeHashHex != "",
		"not_after":     m.NotAfter > 0,
	} {
		if !ok {
			tb.Fatalf("manifest.json: field %q missing or zero", key)
		}
	}
	if now := uint64(time.Now().Unix()); now >= m.NotAfter {
		tb.Fatalf("fixture expired at %s (now %s), run\n"+
			"  cargo run -p dilla-testkit --bin dilla-testkit -- gen-public-group --leaves 1500 --out testkit/fixtures/ds-1500/",
			time.Unix(int64(m.NotAfter), 0).UTC(), time.Unix(int64(now), 0).UTC())
	}

	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join(fixtureDir, name))
		if err != nil {
			tb.Fatalf("fixture %s: %v", name, err)
		}
		return b
	}
	unhex := func(name, s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			tb.Fatalf("manifest.json %s is not hex: %v", name, err)
		}
		return b
	}

	f := fixture{
		manifest:    m,
		groupID:     unhex("group_id_hex", m.GroupIDHex),
		treeHash:    unhex("tree_hash_hex", m.TreeHashHex),
		ratchetTree: read("ratchet_tree.mls"),
		groupInfo:   read("group_info.mls"),
		baseState:   read("public_group_state.bin"),
	}
	for i := range 10 {
		f.commits = append(f.commits, read(filepath.Join("commits", []string{
			"00.mls", "01.mls", "02.mls", "03.mls", "04.mls",
			"05.mls", "06.mls", "07.mls", "08.mls", "09.mls",
		}[i])))
	}
	return f
}
