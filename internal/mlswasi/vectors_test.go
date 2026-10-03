package mlswasi

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

var updateGolden = flag.Bool("update-golden", false,
	"rewrite testdata/vectors_suites.golden from the current run")

const goldenPath = "testdata/vectors_suites.golden"

// envelopeVectors is the ONE committed vector file whose cases carry a `name`
// key, and the one Plan A's run_envelope reads that name from. The other three
// files have a different shape and are deliberately not name-compared here:
//   - franking.json cases are keyed group_id, epoch, seq, uploader_device,
//     commitment, recv_ts, tag — no name; run_franking emits "case <i>".
//   - sframe.json cases are keyed leaf_index, epoch, kid, key, salt, slot,
//     layer, seq, ctr, nonce, header — no name; run_sframe emits
//     "leaf <n> epoch <n>". Its rfc9605_c1, rfc9605_c3, media_frames and
//     escapes sections are named "c1 kid <k> ctr <c>", "c3", "frame <name>" and
//     "escape <i> seed <s>", and its rejects "sframe reject: <name>" (run_rejects);
//     the golden pins every one of those names.
//   - identity.json has no `cases` key at all; its top level is version,
//     description, safety_number, sas, recovery_key, credential_identity, and
//     run_identity emits those last four as case names.
const envelopeVectors = "../../protocol/vectors/envelope.json"

// The per-suite case counts are pinned to the native and Node runners.
// 4 envelope cases x 3 fields; 3 franking cases x 1 field plus the franking file's own envelope_cbor ->
// commitment case, sframe's 4 key-schedule cases x 6 fields plus 34 RFC 9605 C.1
// headers x 2, the C.3 frame x 5, 4 media frames x 3 and 8 escapes x 2 (125), 5
// identity fields plus the credential CBOR and the two credential signatures, and
// the 66-input reject corpus. interfaces.md §6 task 4 requires "the same per-suite
// case counts as the native and Node runs", which is exactly this table — 240
// assertions.
//
// The reject corpus went from 40 to 48 in commit 39ab8fa, which tightened the envelope limits of
// interfaces.md §2.8 and grew envelope.json's `rejects` array from one case to nine. That commit
// moved `core/dilla-core/tests/vectors_native.rs`'s own assertion to 48 and left this table and
// `testdata/vectors_suites.golden` behind, so both have been failing since; the module itself
// reports 96 passed and 0 failed, so nothing but the pins was stale.
//
// Plan B task 17 added the sixth suite: protocol/vectors/frames.json's 25 gateway-frame accept
// cases, one `frame` field each, re-encoded by the core's own deterministic-CBOR writer.
//
// The dilla-media plan's task 4 grew sframe.json by its rfc9605_c1, rfc9605_c3, media_frames,
// escapes and rejects sections: sframe 24 -> 125, rejects 48 -> 66, total 121 -> 240.
var wantSuiteCases = map[string]int{
	"envelope": 12,
	"franking": 4,
	"sframe":   125,
	"identity": 8,
	"frames":   25,
	"rejects":  66,
}

// wantTotalCases is the sum of the table above: the whole cross-target
// conformance surface in one number.
const wantTotalCases = 240

// The four case names run_identity emits, one per sub-object of identity.json.
var wantIdentityCases = []string{"credential_identity", "recovery_key", "safety_number", "sas"}

func runVectors(t *testing.T) VectorReport {
	t.Helper()
	ctx := context.Background()
	r, err := New(ctx, loadWasm(t), Options{PoolSize: 1, CacheDir: sharedCacheDir(t)})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })

	report, err := r.VectorsCheck(ctx)
	if err != nil {
		t.Fatalf("VectorsCheck: %v", err)
	}
	return report
}

func TestVectorsPassOnWasip1(t *testing.T) {
	report := runVectors(t)
	for _, suite := range report.Suites {
		for _, c := range suite.Cases {
			if !c.OK {
				t.Errorf("%s/%s field %q: expected %s, got %s",
					suite.Name, c.Case, c.Field, c.Expected, c.Actual)
			}
		}
	}
	if report.Failed != 0 {
		t.Errorf("Failed = %d, want 0", report.Failed)
	}
	if report.Passed == 0 {
		t.Error("Passed = 0: the guest reported no checked fields at all")
	}
	if !report.OK() {
		t.Error("VectorReport.OK() = false")
	}
}

// Every suite named in interfaces.md 2.9 must be present with the per-suite case
// count the native and Node runs report (interfaces.md 6 task 4). A silently
// shrinking vector set is the failure this catches.
func TestSuiteCaseCountsMatchTheNativeAndNodeRuns(t *testing.T) {
	report := runVectors(t)

	counts := map[string]int{}
	names := map[string][]string{}
	total := 0
	for _, suite := range report.Suites {
		counts[suite.Name] = len(suite.Cases)
		total += len(suite.Cases)
		seen := map[string]bool{}
		for _, c := range suite.Cases {
			if !seen[c.Case] {
				seen[c.Case] = true
				names[suite.Name] = append(names[suite.Name], c.Case)
			}
		}
		slices.Sort(names[suite.Name])
	}

	for suite, want := range wantSuiteCases {
		got, ok := counts[suite]
		if !ok {
			t.Errorf("vectors_check reported no suite named %q; interfaces.md 2.9 names the "+
				"suites envelope, franking, sframe, identity and rejects, Plan B task 17 adds "+
				"frames, and the Rust SuiteReport.name values must be exactly those strings "+
				"(NV2)", suite)
			continue
		}
		if got != want {
			t.Errorf("suite %q reported %d cases, want %d — the same count Plan A task 8's "+
				"each_suite_reports_the_expected_number_of_cases asserts natively and under Node",
				suite, got, want)
		}
	}
	if len(report.Suites) != 6 {
		t.Errorf("vectors_check reported %d suites, want 6", len(report.Suites))
	}
	if total != wantTotalCases {
		t.Errorf("vectors_check reported %d cases in total, want %d", total, wantTotalCases)
	}
	if int(report.Passed+report.Failed) != wantTotalCases {
		t.Errorf("vectors_check counted %d passed + %d failed = %d, want %d",
			report.Passed, report.Failed, report.Passed+report.Failed, wantTotalCases)
	}

	// envelope.json is the one file whose cases carry a `name`, and the one
	// Plan A's run_envelope reads it from, so its names are comparable directly.
	raw, err := os.ReadFile(envelopeVectors)
	if err != nil {
		t.Fatalf("read %s: %v", envelopeVectors, err)
	}
	var file struct {
		Cases []struct {
			Name string `json:"name"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("%s: %v", envelopeVectors, err)
	}
	if len(file.Cases) == 0 {
		t.Fatalf("%s declares no cases; the committed vector file is empty or has changed shape",
			envelopeVectors)
	}
	wantEnvelope := make([]string, 0, len(file.Cases))
	for _, c := range file.Cases {
		if c.Name == "" {
			t.Fatalf("%s has a case with an empty `name`; run_envelope keys its CaseReports on it",
				envelopeVectors)
		}
		wantEnvelope = append(wantEnvelope, c.Name)
	}
	slices.Sort(wantEnvelope)
	if !slices.Equal(names["envelope"], wantEnvelope) {
		t.Errorf("suite \"envelope\" covers %v, but %s declares %v",
			names["envelope"], envelopeVectors, wantEnvelope)
	}

	// identity.json has no `cases` array; run_identity emits one case per
	// sub-object of the file, so the four names are the contract.
	if !slices.Equal(names["identity"], wantIdentityCases) {
		t.Errorf("suite \"identity\" covers %v, want %v — run_identity emits one case per "+
			"sub-object of protocol/vectors/identity.json", names["identity"], wantIdentityCases)
	}
}

// The golden file records every suite/case/field triple the guest checks, so a
// vector that quietly stops being verified fails the build rather than passing.
func TestVectorSuiteGolden(t *testing.T) {
	report := runVectors(t)

	lines := make([]string, 0, report.Passed+report.Failed)
	for _, suite := range report.Suites {
		for _, c := range suite.Cases {
			lines = append(lines, fmt.Sprintf("%s\t%s\t%s", suite.Name, c.Case, c.Field))
		}
	}
	slices.Sort(lines)
	current := strings.Join(lines, "\n") + "\n"

	if *updateGolden {
		if err := os.MkdirAll(filepath.Dir(goldenPath), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(goldenPath, []byte(current), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %s with %d triples", goldenPath, len(lines))
		return
	}

	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("%s is missing; regenerate it with\n"+
			"  go test ./internal/mlswasi/ -run TestVectorSuiteGolden -update-golden\n"+
			"Underlying error: %v", goldenPath, err)
	}
	if string(want) != current {
		t.Errorf("the set of checked vector fields changed.\n"+
			"golden has %d triples, this run has %d.\n"+
			"If the change is intended, regenerate with -update-golden and review the diff.",
			strings.Count(string(want), "\n"), len(lines))
	}
}
