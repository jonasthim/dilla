package ds_test

// The KeyPackage directory: protocol/02's endpoints 10 (`POST /v1/keypackages`) and 11
// (`GET /v1/devices/{device_id}/keypackage`), seen from the delivery service.
//
// Two halves, driven differently on purpose (directory_harness_test.go's header has the reasons):
// the PUBLISH side runs against the one committed KeyPackage, because validation happens inside
// the guest and only real material reaches it; the TAKE side runs against a directory seeded
// through the real store, because the rule it encodes — ordinary first, the last-resort package
// never consumed, an expired row never served — lives in SQL.

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	// The lifetime `build_key_package` gives every dilla KeyPackage:
	// `dilla_core::mls::KEY_PACKAGE_LIFETIME_DAYS`.
	keyPackageLifetime = 90 * 24 * time.Hour
	// A SHORTER lifetime for the ordinary packages of the expiry test, so the clock can cross
	// theirs while staying well inside the last-resort package's.
	shortKeyPackageLifetime = 7 * 24 * time.Hour
)

// Role 1: ordinary packages are consumed on use; the last-resort package never is.
func TestOrdinaryKeyPackagesAreConsumedAndTheLastResortIsNot(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	device := h.device(t)
	session := h.sessionOf(t, device)
	h.seedKeyPackages(t, device, 32, keyPackageLifetime)
	h.seedLastResort(t, device, keyPackageLifetime)

	seen := map[string]struct{}{}
	for i := range 32 {
		got, err := h.ds.TakeKeyPackage(ctx, session, device)
		if err != nil {
			t.Fatalf("take %d: %v", i, err)
		}
		if got.LastResort {
			t.Fatalf("take %d returned the last-resort package while ordinary ones remained", i)
		}
		if len(got.KPRef) != 32 {
			t.Fatalf("kp_ref is %d bytes, want 32", len(got.KPRef))
		}
		if _, dup := seen[string(got.KPRef)]; dup {
			t.Fatalf("take %d served a package that was already handed out", i)
		}
		seen[string(got.KPRef)] = struct{}{}
	}
	for i := range 3 {
		got, err := h.ds.TakeKeyPackage(ctx, session, device)
		if err != nil {
			t.Fatalf("take %d after exhaustion: %v", i, err)
		}
		if !got.LastResort {
			t.Fatal("with the ordinary packages consumed the last-resort one must be served")
		}
	}
	// The count the refill threshold is read against is the ORDINARY one: every ordinary package
	// is gone, and the last-resort row is still there to be served for ever.
	if left := h.ordinaryKeyPackagesLeft(t, device); left != 0 {
		t.Fatalf("%d ordinary packages remain, want 0", left)
	}
	if total := h.countRows(t, "key_packages"); total != 33 {
		t.Fatalf("%d rows in key_packages, want the 32 consumed ordinary ones and the last-resort", total)
	}
}

// The clock crosses the ORDINARY packages' expiry and stops short of the last-resort one's.
//
// `TakeKeyPackage`'s query filters `expires > ?` for every row, and a fixture whose ordinary and
// last-resort packages shared one 90-day lifetime would have no row left at all — the take would
// answer E_NOT_FOUND and the test would die on its own Fatalf rather than on the rule. So the
// ordinary packages are seeded with a SHORTER lifetime and the clock crosses that one, which is
// the expiry actually under test.
func TestAnExpiredKeyPackageIsSkipped(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	device := h.device(t)
	session := h.sessionOf(t, device)
	h.seedKeyPackages(t, device, 2, shortKeyPackageLifetime)
	h.seedLastResort(t, device, keyPackageLifetime)

	// Past the ordinary packages' 7-day expiry, well inside the last-resort package's 90 days.
	h.clk.Advance(shortKeyPackageLifetime + time.Hour)

	got, err := h.ds.TakeKeyPackage(ctx, session, device)
	if err != nil {
		t.Fatalf("TakeKeyPackage: %v", err)
	}
	if !got.LastResort {
		t.Fatal("an expired ordinary package must be skipped")
	}
	if left := h.ordinaryKeyPackagesLeft(t, device); left != 0 {
		t.Fatalf("%d ordinary packages count as available, want 0 — both have expired", left)
	}
}

// A device with nothing in its directory at all is E_NOT_FOUND, not a nil package.
func TestTakingFromAnEmptyDirectoryIsNotFound(t *testing.T) {
	h := newDSHarness(t)
	device := h.device(t)
	_, err := h.ds.TakeKeyPackage(context.Background(), h.sessionOf(t, device), device)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_NOT_FOUND" {
		t.Fatalf("got %v, want E_NOT_FOUND", err)
	}
}

// keypackages_remaining in `ready` drops below the refill threshold and is reported. The
// threshold is config's own default, not a literal: one number governs the knob an operator
// writes and the count a client refills against.
func TestKeypackagesRemainingIsReportedAgainstTheRefillThreshold(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	device := h.device(t)
	session := h.sessionOf(t, device)
	h.seedKeyPackages(t, device, 10, keyPackageLifetime)

	for i := range 5 {
		if _, err := h.ds.TakeKeyPackage(ctx, session, device); err != nil {
			t.Fatalf("take %d: %v", i, err)
		}
	}
	remaining := h.readyKeypackagesRemaining(t, device)
	if remaining != 5 {
		t.Fatalf("ready reports %d remaining, want 5", remaining)
	}
	threshold := config.Default().Limits.KeypackageRefillThreshold
	if threshold != 8 {
		t.Fatalf("the refill threshold is %d, want config's 8", threshold)
	}
	if remaining >= uint64(threshold) {
		t.Fatalf("the test must drive the count below the threshold of %d", threshold)
	}
}

// ---------------------------------------------------------------- the publish side

// The one committed KeyPackage goes in, and the row is keyed by the ref the GUEST computed — not
// by anything the client sent. A client that publishes the same package twice writes one row.
func TestPublishStoresTheGuestsKeyPackageRefAndIsIdempotent(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	device, session, blob, info := h.keyPackageOwner(t)

	n, err := h.ds.PublishKeyPackages(ctx, session, [][]byte{blob}, nil)
	if err != nil {
		t.Fatalf("PublishKeyPackages: %v", err)
	}
	if n != 1 {
		t.Fatalf("stored %d packages, want 1", n)
	}
	if len(info.KPRef) != 32 {
		t.Fatalf("the guest's kp_ref is %d bytes, want 32", len(info.KPRef))
	}
	got, err := h.ds.TakeKeyPackage(ctx, session, device)
	if err != nil {
		t.Fatalf("TakeKeyPackage: %v", err)
	}
	if !bytes.Equal(got.KPRef, info.KPRef) {
		t.Fatalf("kp_ref = %x, want the guest's %x", got.KPRef, info.KPRef)
	}
	if !bytes.Equal(got.Blob, blob) {
		t.Fatal("the stored blob is not the published one")
	}
	if got.LastResort {
		t.Fatal("the fixture package carries no last_resort extension")
	}

	// Publishing it again writes no second row: the primary key is (device_id, kp_ref).
	if _, err := h.ds.PublishKeyPackages(ctx, session, [][]byte{blob}, nil); err != nil {
		t.Fatalf("republish: %v", err)
	}
	if total := h.countRows(t, "key_packages"); total != 1 {
		t.Fatalf("%d rows after republishing the same package, want 1", total)
	}
}

// A device may only publish KeyPackages for itself. Without the check, any enrolled session could
// fill another device's directory with packages only it holds the private keys for, and every Add
// of that device would then hand the joiner a KeyPackage it cannot open.
func TestPublishRefusesAKeyPackageForAnotherDevice(t *testing.T) {
	h := newDSHarness(t)
	_, _, blob, _ := h.keyPackageOwner(t)
	other := h.device(t)

	_, err := h.ds.PublishKeyPackages(context.Background(), h.sessionOf(t, other), [][]byte{blob}, nil)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_FORBIDDEN" {
		t.Fatalf("got %v, want E_FORBIDDEN", err)
	}
	if total := h.countRows(t, "key_packages"); total != 0 {
		t.Fatalf("%d rows were written for a refused publish, want 0", total)
	}
}

// The committed package carries no last_resort extension, so publishing it AS the last-resort one
// is a contradiction the directory must not store: the row would be served for ever, and
// `TakeKeyPackage` would hand the same package to every joiner.
func TestPublishRefusesAPackageWhoseLastResortExtensionDisagrees(t *testing.T) {
	h := newDSHarness(t)
	_, session, blob, _ := h.keyPackageOwner(t)

	_, err := h.ds.PublishKeyPackages(context.Background(), session, nil, blob)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want E_COMMIT_INVALID", err)
	}
	if total := h.countRows(t, "key_packages"); total != 0 {
		t.Fatalf("%d rows were written for a refused publish, want 0", total)
	}
}

func TestPublishRefusesAKeyPackageThatDoesNotValidate(t *testing.T) {
	h := newDSHarness(t)
	device := h.device(t)
	_, err := h.ds.PublishKeyPackages(context.Background(), h.sessionOf(t, device),
		[][]byte{{0x00, 0x01}}, nil)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_COMMIT_INVALID" {
		t.Fatalf("got %v, want E_COMMIT_INVALID", err)
	}
}

// One device's directory is bounded by config's `limits.max_keypackages_per_device`, and the cap
// is checked BEFORE the guest is asked to validate anything: a caller that could not exceed the
// cap can still make the instance run 10 000 validations by trying.
func TestPublishRefusesMoreThanThePolicyCap(t *testing.T) {
	h := newDSHarness(t)
	device := h.device(t)
	limit := ds.PolicyForTest(h.ds).MaxKeyPackagesPerDevice
	if limit != config.Default().Limits.MaxKeypackagesPerDevice {
		t.Fatalf("the policy cap is %d, want config's %d",
			limit, config.Default().Limits.MaxKeypackagesPerDevice)
	}
	before := h.wasmCalls("validate_key_package")

	packages := make([][]byte, limit+1)
	for i := range packages {
		packages[i] = []byte{0x00, byte(i)}
	}
	_, err := h.ds.PublishKeyPackages(context.Background(), h.sessionOf(t, device), packages, nil)
	var dsErr *ds.Error
	if !errors.As(err, &dsErr) || dsErr.Code != "E_TOO_LARGE" {
		t.Fatalf("got %v, want E_TOO_LARGE", err)
	}
	if got := h.wasmCalls("validate_key_package") - before; got != 0 {
		t.Fatalf("the guest was asked to validate %d packages over the cap, want 0", got)
	}
}

// Rows 10, 15 and 16 accept a provisional session, and the restriction that makes that safe is
// enforced, not assumed: a provisional session is bound to ONE pairing group and may publish the
// one KeyPackage for it, nothing else. Without the check a session issued before enrolment can
// stock a whole directory — and, on the Welcome side, harvest every group its device was ever
// added to, which is the escalation interfaces §2.2 point 4 forbids.
func TestAProvisionalSessionMayPublishOnlyItsOnePairingKeyPackage(t *testing.T) {
	h := newDSHarness(t)
	ctx := context.Background()
	device, _, blob, _ := h.keyPackageOwner(t)
	provisional := h.provisionalSessionOf(t, device, id.New())

	// One package is the pairing package, and it is accepted.
	if _, err := h.ds.PublishKeyPackages(ctx, provisional, [][]byte{blob}, nil); err != nil {
		t.Fatalf("a provisional session must be able to publish its one pairing KeyPackage: %v", err)
	}

	var dsErr *ds.Error
	_, err := h.ds.PublishKeyPackages(ctx, provisional, [][]byte{blob, blob, blob, blob}, nil)
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PROVISIONAL_OUTSIDE_PAIRING" {
		t.Fatalf("got %v, want E_PROVISIONAL_OUTSIDE_PAIRING for a bulk publish", err)
	}
	_, err = h.ds.PublishKeyPackages(ctx, provisional, nil, blob)
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PROVISIONAL_OUTSIDE_PAIRING" {
		t.Fatalf("got %v, want E_PROVISIONAL_OUTSIDE_PAIRING for a last-resort publish", err)
	}

	// A provisional session bound to NO pairing group reaches nothing at all.
	unbound := h.provisionalSessionOf(t, device, id.New())
	unbound.PairingGroup = nil
	_, err = h.ds.PublishKeyPackages(ctx, unbound, [][]byte{blob}, nil)
	if !errors.As(err, &dsErr) || dsErr.Code != "E_PROVISIONAL_OUTSIDE_PAIRING" {
		t.Fatalf("got %v, want E_PROVISIONAL_OUTSIDE_PAIRING for a session bound to no group", err)
	}
}
