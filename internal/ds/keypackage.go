package ds

// keypackage.go is the delivery service's KeyPackage directory: protocol/02's role 4, endpoints 10
// (`POST /v1/keypackages`) and 11 (`GET /v1/devices/{device_id}/keypackage`).
//
// Two rules make the directory what it is. Every published package is validated INSIDE THE GUEST —
// the leaf must advertise 0xF001, the credential identity must decode and name the publishing
// device, and the lifetime must not have passed — so a package the delivery service would later
// hand a joiner is never one it has not checked. And the LAST-RESORT package is never consumed:
// once the ordinary ones are gone it is served for ever, which is what keeps a device that has run
// out of packages addable rather than unreachable.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// KeyPackage is one served package. KPRef is the RFC 9420 KeyPackageRef the GUEST computed, which
// is also the row's primary key: a client that publishes the same package twice writes one row.
type KeyPackage struct {
	Blob       []byte
	LastResort bool
	KPRef      []byte
}

// maxKeyPackagesPerDevice bounds one device's directory. It is not a literal here: the value is
// Policy's, which the composition root fills from `config.Default().Limits
// .MaxKeypackagesPerDevice`, so one number governs this refusal and the
// `limits.max_keypackages_per_device` element of `GET /v1/instance/limits`.
func (d *DS) maxKeyPackagesPerDevice() int { return d.opts.Policy.MaxKeyPackagesPerDevice }

// errTooManyKeyPackages is E_TOO_LARGE counted in PACKAGES. `errTooLarge` counts bytes of
// ciphertext and says so in its detail, which would be a lie on this route.
func errTooManyKeyPackages(n, limit int) *Error {
	return &Error{
		Code:   "E_TOO_LARGE",
		Detail: fmt.Sprintf("%d key packages in one publish, limit %d", n, limit),
		Status: http.StatusRequestEntityTooLarge,
	}
}

// errKeyPackageDirectoryFull is the same E_TOO_LARGE for the bound that actually matters: what the
// DIRECTORY holds. The detail names both numbers, because a client that gets "limit 32" back for a
// one-package publish has no way to tell otherwise that the request was fine and the shelf is full.
func errKeyPackageDirectoryFull(held int64, adding, limit int) *Error {
	return &Error{
		Code: "E_TOO_LARGE",
		Detail: fmt.Sprintf("the directory holds %d key packages and this publish adds %d, limit %d",
			held, adding, limit),
		Status: http.StatusRequestEntityTooLarge,
	}
}

// checkKeyPackageLifetime refuses a `not_after` (unix seconds, the client's) later than now plus
// the policy's maximum lifetime. The comparison is in uint64 so no value a client can send
// overflows or wraps it; `now` is a clock reading and never negative in practice, and a negative
// one is treated as zero rather than as a huge unsigned number.
func checkKeyPackageLifetime(now int64, notAfter uint64, maxLifetime time.Duration) error {
	base := uint64(0)
	if now > 0 {
		base = uint64(now)
	}
	if maxLifetime < 0 {
		maxLifetime = 0
	}
	limit := base + uint64(maxLifetime/time.Second)
	if notAfter > limit {
		return errCommitInvalid("key_package", fmt.Sprintf(
			"the package's lifetime ends beyond the instance's maximum of %s from now",
			maxLifetime.Round(time.Second)))
	}
	return nil
}

// PublishKeyPackages validates every package inside the guest and stores it with the guest's own
// kp_ref. It returns how many rows the publish covers; republishing a package the directory
// already holds is not an error and writes no second row.
func (d *DS) PublishKeyPackages(ctx context.Context, s Session, packages [][]byte, lastResort []byte) (int, error) {
	// A provisional session exists to bring ONE device into ONE pairing group, so it may publish
	// the single KeyPackage that group's Welcome will consume and nothing more. The route accepts
	// a provisional session (interfaces §5.1 row 10); this is what makes that safe. It is checked
	// FIRST, before the cap and before the guest, because it is the cheapest refusal and the one
	// an unenrolled caller is most likely to reach for.
	if s.Scope == auth.ScopeProvisional {
		if s.PairingGroup == nil {
			return 0, errProvisionalOutsidePairing("this provisional session is bound to no pairing group")
		}
		if len(packages) > 1 || lastResort != nil {
			return 0, errProvisionalOutsidePairing(
				"a provisional session may publish exactly one pairing KeyPackage and no last-resort package")
		}
	}
	// The cap is checked BEFORE the guest is asked for anything. A caller that cannot exceed it
	// can still make the instance run one RFC 9420 validation per submitted blob by trying, and
	// validation is the expensive half of this route.
	if len(packages) > d.maxKeyPackagesPerDevice() {
		return 0, errTooManyKeyPackages(len(packages), d.maxKeyPackagesPerDevice())
	}
	if len(packages) == 0 && lastResort == nil {
		return 0, nil
	}
	// And the cap is a bound on the DIRECTORY, not on one request. A per-request bound is no bound:
	// nothing consumes an ordinary package except an Add, so a device that publishes the cap in a
	// loop grows `key_packages` without end, each row a full KeyPackage blob held for its 90-day
	// lifetime — and a provisional session, limited to one package per call, stocks the same
	// directory one call at a time. `CountKeyPackages` is the same count `ready` reports: the
	// UNCONSUMED, UNEXPIRED ordinary rows, so a consumed or expired package makes room again.
	//
	// The count is deliberately taken before validation and before any dedupe: a republish of a
	// package the directory already holds writes no row, but the delivery service cannot know that
	// without validating the blob first, and the conservative refusal costs a full client only a
	// take away from the boundary.
	//
	// It covers the ORDINARY half only, and that is the whole of what it must cover: a last-resort
	// publish writes no ordinary row, and the last-resort half is bounded at ONE row per device by
	// the store, which drops the previous fallback package when a new one is written (protocol/01
	// § Joining: "32 ordinary KeyPackages plus 1 last-resort KeyPackage"; the adapters' comment on
	// `PutKeyPackages` and internal/store's TestANewLastResortKeyPackageReplacesTheOldOne). Without
	// that rule this `len(packages) > 0` gate would be a hole in the bound, since a publish shaped
	// `{packages: [], last_resort: <fresh blob>}` reaches SQL without ever being counted.
	if len(packages) > 0 {
		held, err := d.opts.Store.CountKeyPackages(ctx, s.DeviceID, d.now())
		if err != nil {
			return 0, err
		}
		if held+int64(len(packages)) > int64(d.maxKeyPackagesPerDevice()) {
			return 0, errKeyPackageDirectoryFull(held, len(packages), d.maxKeyPackagesPerDevice())
		}
	}

	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer inst.Release()

	rows := make([]store.KeyPackageRow, 0, len(packages)+1)
	add := func(blob []byte, last bool) error {
		info, err := inst.ValidateKeyPackage(ctx, blob)
		if err != nil {
			return errCommitInvalid("key_package", err.Error())
		}
		if string(info.DeviceID) != string(s.DeviceID[:]) {
			return errForbidden("a device may only publish KeyPackages for itself")
		}
		if info.LastResort != last {
			return errCommitInvalid("key_package",
				"the package's last_resort extension disagrees with where it was published")
		}
		// not_after is the client's. The guest only checks it is in the future, so a lifetime is
		// bounded HERE, and only then converted: an unbounded uint64 wraps negative as an int64.
		if err := checkKeyPackageLifetime(d.now(), info.NotAfter, d.opts.Policy.MaxKeyPackageLifetime); err != nil {
			return err
		}
		var lr uint8
		if last {
			lr = 1
		}
		rows = append(rows, store.KeyPackageRow{
			DeviceID:   s.DeviceID,
			KPRef:      info.KPRef,
			Blob:       blob,
			LastResort: lr,
			// G115: checkKeyPackageLifetime above refused every not_after past now plus
			// MaxKeyPackageLifetime, which is far below 2^63.
			Expires: int64(info.NotAfter), //nolint:gosec // bounded by checkKeyPackageLifetime
			Created: d.now(),
		})
		return nil
	}
	// Nothing is written until every package has passed: a publish is all or nothing, so a client
	// that sent one bad blob in a batch of thirty-two is not left guessing which of them landed.
	for _, blob := range packages {
		if err := add(blob, false); err != nil {
			return 0, err
		}
	}
	if lastResort != nil {
		if err := add(lastResort, true); err != nil {
			return 0, err
		}
	}
	if err := d.opts.Store.PutKeyPackages(ctx, s.DeviceID, rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// TakeKeyPackage serves one package for a target device: an unconsumed, unexpired ORDINARY one if
// there is any, otherwise the last-resort package, which is served repeatedly and never consumed.
//
// The choice is the store's, not this function's: the SQL orders by `last_resort ASC, expires` and
// marks `consumed_at` only on an ordinary row, and a Go-side "take one, and if it is the
// last-resort put it back" would race every concurrent joiner.
func (d *DS) TakeKeyPackage(ctx context.Context, s Session, target id.ID) (KeyPackage, error) {
	// Row 11 is enrolled-only. A provisional session is a device that is not yet a member of
	// anything; handing it the directory of an arbitrary device would let it learn which devices
	// exist and burn their packages.
	if s.Scope != auth.ScopeEnrolled {
		return KeyPackage{}, errForbidden("taking a KeyPackage needs an enrolled session")
	}
	row, err := d.opts.Store.TakeKeyPackage(ctx, target, d.now())
	if errors.Is(err, store.ErrNotFound) {
		return KeyPackage{}, errNotFound("key package")
	}
	if err != nil {
		return KeyPackage{}, err
	}
	return KeyPackage{Blob: row.Blob, LastResort: row.LastResort == 1, KPRef: row.KPRef}, nil
}

// KeyPackagesRemaining is what the gateway's `ready` frame reports so a client knows to refill. It
// counts the ORDINARY packages only: the last-resort one is the fallback, not a package a client
// should stop refilling because of.
func (d *DS) KeyPackagesRemaining(ctx context.Context, deviceID id.ID) (uint64, error) {
	n, err := d.opts.Store.CountKeyPackages(ctx, deviceID, d.now())
	if err != nil {
		return 0, err
	}
	if n < 0 {
		return 0, nil
	}
	return uint64(n), nil
}
