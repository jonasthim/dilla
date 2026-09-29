package mlswasi

import (
	"bytes"
	"encoding/binary"
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
	Leaves      int    `json:"leaves"`
	Epoch       uint64 `json:"epoch"`
	GroupIDHex  string `json:"group_id_hex"`
	TreeHashHex string `json:"tree_hash_hex"`
	// GroupInfoSignerLeaf and KeyPackageRefHex are ABI v2 scalars: the generator
	// records the leaf that signed group_info.mls (public_group_group_info_validate
	// takes it as an argument, because VerifiableGroupInfo::signer() is pub(crate)
	// in OpenMLS 0.9.0) and the KeyPackageRef of key_package.mls.
	GroupInfoSignerLeaf uint32 `json:"group_info_signer_leaf"`
	KeyPackageRefHex    string `json:"key_package_ref_hex"`
	NotAfter            uint64 `json:"not_after"`
	OpenMLSVersion      string `json:"openmls_version"`
	Files               []struct {
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
	cacheOnce.Do(func() {
		cacheDir, cacheErr = os.MkdirTemp("", "mlswasi-cache-") //nolint:usetesting // shared by the whole package, removed by TestMain
	})
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

// fixtureSignerLeaf is the leaf that signed the committed group_info.mls, recorded in the
// fixture manifest by the testkit generator (ABI v2 §3.2 takes the signer leaf as an argument).
func fixtureSignerLeaf(tb testing.TB) uint32 {
	tb.Helper()
	return loadDS1500(tb).manifest.GroupInfoSignerLeaf
}

// loadKeyPackageFixture reads the committed KeyPackage the ABI v2 validate_key_package tests use.
// Task 15 step 9 commits it under testkit/fixtures/ds-1500/, so its absence is a real failure —
// the generator step did not run — and never a reason to skip. A skip here would make the one
// test of the injectable wasm clock (gap-33 §4.3) silently pass in CI.
func loadKeyPackageFixture(tb testing.TB) []byte {
	tb.Helper()
	path := filepath.Join(fixtureDir, "key_package.mls")
	raw, err := os.ReadFile(path)
	if err != nil {
		tb.Fatalf("KeyPackage fixture absent (%v); regenerate with "+
			"`cargo run -p dilla-testkit -- gen-public-group --leaves 1500 "+
			"--out testkit/fixtures/ds-1500`", err)
	}
	return raw
}

// loadRemoveProposalFixture reads the committed external Remove proposal against leaf 0. The
// fixture group carries an ExternalSenders extension naming the instance, which is what makes it
// queueable at all (testkit/src/fixtures.rs:121). It is what gives ProposalInspect something to
// inspect; like the KeyPackage its absence is a generator failure, never a reason to skip.
func loadRemoveProposalFixture(tb testing.TB) []byte {
	tb.Helper()
	path := filepath.Join(fixtureDir, "remove_leaf0.mls")
	raw, err := os.ReadFile(path)
	if err != nil {
		tb.Fatalf("Remove proposal fixture absent (%v); regenerate with "+
			"`cargo run -p dilla-testkit -- gen-public-group --leaves 1500 "+
			"--out testkit/fixtures/ds-1500`", err)
	}
	return raw
}

// privateMessageFixture builds the RFC 9420 §6.3.2 framing the guest parses, with n bytes of
// authenticated_data. The DS never builds a PrivateMessage in production; this is the one place
// Go writes the framing, so the guest's parser is exercised from both sides.
func privateMessageFixture(tb testing.TB, n int) []byte {
	tb.Helper()
	return privateMessageFixtureOfType(tb, n, 1)
}

// privateMessageFixtureOfType is privateMessageFixture with the content_type byte chosen.
func privateMessageFixtureOfType(tb testing.TB, n int, contentType byte) []byte {
	tb.Helper()
	var out []byte
	out = binary.BigEndian.AppendUint16(out, 1) // protocol_version: MLS 1.0
	out = binary.BigEndian.AppendUint16(out, 2) // wire_format: PrivateMessage
	out = appendVLBytes(out, []byte("group-id"))
	out = binary.BigEndian.AppendUint64(out, 7) // epoch
	out = append(out, contentType)              // content_type: 1 application
	out = appendVLBytes(out, bytes.Repeat([]byte{5}, n))
	out = appendVLBytes(out, bytes.Repeat([]byte{7}, 16))
	out = appendVLBytes(out, bytes.Repeat([]byte{9}, 64))
	return out
}

// appendVLBytes writes the RFC 9420 §2.1.3 variable-length header. Only the one- and two-byte
// forms are needed here (payloads stay under 2^14 bytes).
func appendVLBytes(dst, v []byte) []byte {
	switch {
	case len(v) < 64:
		dst = append(dst, byte(len(v)))
	case len(v) < 16384:
		dst = binary.BigEndian.AppendUint16(dst, uint16(len(v))|0x4000)
	default:
		panic("appendVLBytes: payload too long for the test helper")
	}
	return append(dst, v...)
}

// stripExport rewrites the module's export section so one named export is absent, without
// touching anything else: the name's first byte is changed, which keeps every section length and
// every LEB128 header intact, so wazero still validates the result and New's export assertion is
// what fails.
//
// Deviation from the brief, forced by the measured artifact. The brief searched the whole file for
// the name and asserted it occurs exactly once, with a Fatalf saying that if it does not, "the
// build now emits a name section, so stripExport must parse the export section instead of
// searching the whole file". It does not: `private_message_aad` occurs **five** times in the
// release module with no `name` custom section, because the guest carries each export name as a
// data-section string too (`exports.rs` dispatches on the name and quotes it in its error detail).
// So this is the export-section parse that branch demands.
func stripExport(tb testing.TB, wasm []byte, name string) []byte {
	tb.Helper()
	out := bytes.Clone(wasm)
	out[exportNameOffset(tb, out, name)] = 'z'
	return out
}

// exportNameOffset returns the offset of the first byte of name inside the module's export
// section (section id 7 of the WebAssembly 2.0 binary format, §5.5.10).
func exportNameOffset(tb testing.TB, wasm []byte, name string) int {
	tb.Helper()
	const headerLen = 8 // the 4-byte magic and the 4-byte version
	if len(wasm) < headerLen {
		tb.Fatal("the module is shorter than its own header")
	}
	for i := headerLen; i < len(wasm); {
		id := wasm[i]
		size, j := varUint32(tb, wasm, i+1)
		end := j + int(size)
		if end > len(wasm) {
			tb.Fatalf("section %d declares %d bytes, %d remain", id, size, len(wasm)-j)
		}
		if id == 7 {
			count, k := varUint32(tb, wasm, j)
			for range count {
				var nameLen uint32
				nameLen, k = varUint32(tb, wasm, k)
				if k+int(nameLen) > end {
					tb.Fatal("an export name runs past the export section")
				}
				if string(wasm[k:k+int(nameLen)]) == name {
					return k
				}
				k += int(nameLen)
				k++                           // the export kind byte
				_, k = varUint32(tb, wasm, k) // the index into the kind's space
			}
		}
		i = end
	}
	tb.Fatalf("the module exports nothing named %q", name)
	return 0
}

// varUint32 decodes the LEB128 u32 at p[i:] and returns it with the offset just past it.
func varUint32(tb testing.TB, p []byte, i int) (uint32, int) {
	tb.Helper()
	var v uint32
	for shift := uint(0); ; shift += 7 {
		if i >= len(p) {
			tb.Fatal("the module ends inside a LEB128 integer")
		}
		if shift > 28 {
			tb.Fatal("a LEB128 integer is longer than a u32")
		}
		b := p[i]
		i++
		v |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return v, i
		}
	}
}
