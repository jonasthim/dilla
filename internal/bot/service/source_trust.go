package service

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	maxSenderHistoryVersions = 1024
	maxSenderHistoryBytes    = 4 << 20
	maxSenderOuterRowBytes   = 1 << 20
	senderHistoryPageSize    = 64
)

var ErrSenderHistoryStale = errors.New("sender device-list history is stale")

type senderHistorySession interface {
	OwnDeviceList(context.Context, id.ID) ([]byte, error)
	DeviceListHistory(context.Context, id.ID, uint64) ([][]any, error)
}

type senderTrustNative interface {
	Binding() native.Binding
	PendingLeaves(context.Context) ([]native.GroupPendingLeaf, error)
	ProposedAdds(context.Context, id.ID, []byte) ([]native.GroupProposedAdd, error)
	TrustSender(context.Context, id.ID, uint64, id.ID, []byte, []byte, uint64) (native.GroupTrustVerdict, error)
	TrustProposedAdd(context.Context, id.ID, []byte, uint64, id.ID, []byte, []byte, uint64) (native.GroupTrustVerdict, error)
	RevalidateGroup(context.Context, id.ID, uint64, uint64) (uint32, error)
}

// SourceTrust reads bounded signed device-list history and delegates every signature, leaf,
// current-membership and key-binding decision to the native core.
type SourceTrust struct {
	native  senderTrustNative
	binding native.Binding
	now     func() time.Time
}

// NewSourceTrust binds trust recovery to one opened native identity.
func NewSourceTrust(n *native.Client) (*SourceTrust, error) {
	if n == nil {
		return nil, errors.New("missing native client")
	}
	return newSourceTrust(n)
}

func newSourceTrust(n senderTrustNative) (*SourceTrust, error) {
	if n == nil {
		return nil, errors.New("missing native client")
	}
	binding := n.Binding()
	if binding.Instance.IsZero() || binding.Community.IsZero() || binding.Installation.IsZero() {
		return nil, errors.New("invalid native binding")
	}
	return &SourceTrust{native: n, binding: binding, now: time.Now}, nil
}

// TrustPendingLeaves refreshes current sender trust for the helper's bounded pending-leaf list.
// It does not drain or acknowledge authenticated events.
func (t *SourceTrust) TrustPendingLeaves(ctx context.Context, session *client.Session) (uint32, error) {
	if session == nil {
		return 0, errors.New("missing device session")
	}
	return t.trustPendingLeaves(ctx, session)
}

func (t *SourceTrust) trustPendingLeaves(ctx context.Context, session senderHistorySession) (uint32, error) {
	leaves, err := t.native.PendingLeaves(ctx)
	if err != nil {
		return 0, err
	}
	var recovered uint64
	for _, leaf := range leaves {
		if err = ctx.Err(); err != nil {
			return 0, err
		}
		n, e := t.trustSender(ctx, session, leaf.Group, uint64(leaf.Leaf), leaf.User, leaf.CachedVersion)
		if e != nil {
			return 0, e
		}
		recovered += uint64(n)
		if recovered > math.MaxUint32 {
			return 0, errors.New("sender revalidation count overflow")
		}
	}
	return uint32(recovered), nil
}

// TrustSender refreshes one current leaf against a re-read current server head, then revalidates
// durable authenticated events under the new trust state.
func (t *SourceTrust) TrustSender(ctx context.Context, session *client.Session, group id.ID, leaf uint64, user id.ID, cachedVersion uint64) (uint32, error) {
	if session == nil {
		return 0, errors.New("missing device session")
	}
	return t.trustSender(ctx, session, group, leaf, user, cachedVersion)
}

func (t *SourceTrust) trustSender(ctx context.Context, session senderHistorySession, group id.ID, leaf uint64, user id.ID, cachedVersion uint64) (uint32, error) {
	if group.IsZero() || user.IsZero() || leaf > math.MaxUint32 {
		return 0, errors.New("invalid sender trust target")
	}
	history, head, _, err := readSenderHistory(ctx, session, user, cachedVersion)
	if err != nil {
		return 0, err
	}
	if _, err = t.native.TrustSender(ctx, group, leaf, user, history, head, uint64(t.now().Unix())); err != nil {
		return 0, err
	}
	return t.native.RevalidateGroup(ctx, group, leaf, 256)
}

// TrustProposedAdds validates each currently proposed Add against that user's signed list history.
// The native core remains responsible for whether the proposed key package is admissible.
func (t *SourceTrust) TrustProposedAdds(ctx context.Context, session *client.Session, group id.ID, proposals []byte) error {
	if session == nil {
		return errors.New("missing device session")
	}
	return t.trustProposedAdds(ctx, session, group, proposals)
}

func (t *SourceTrust) trustProposedAdds(ctx context.Context, session senderHistorySession, group id.ID, proposals []byte) error {
	if group.IsZero() || len(proposals) == 0 {
		return errors.New("invalid proposed-add trust target")
	}
	adds, err := t.native.ProposedAdds(ctx, group, proposals)
	if err != nil {
		return err
	}
	for _, add := range adds {
		if err = ctx.Err(); err != nil {
			return err
		}
		history, head, _, e := readSenderHistory(ctx, session, add.User, add.CachedVersion)
		if e != nil {
			return e
		}
		if _, e = t.native.TrustProposedAdd(ctx, group, proposals, uint64(add.Index), add.User, history, head, uint64(t.now().Unix())); e != nil {
			return e
		}
	}
	return nil
}

// readSenderHistory returns the encoded outer history rows and the candidate head's INNER signed
// list. The candidate is re-read after collection to bound head races and prevent stale trust.
func readSenderHistory(ctx context.Context, session senderHistorySession, user id.ID, cachedVersion uint64) ([]byte, []byte, uint64, error) {
	if session == nil || user.IsZero() || cachedVersion > math.MaxInt64 {
		return nil, nil, 0, ErrSenderHistoryStale
	}
	var rowsUsed, bytesUsed uint64
	for attempt := 0; attempt < 2; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, nil, 0, err
		}
		candidateRaw, err := session.OwnDeviceList(ctx, user)
		if err != nil {
			return nil, nil, 0, err
		}
		candidate, version, err := decodeSenderOuter(candidateRaw)
		if err != nil || version < cachedVersion || version-cachedVersion > maxSenderHistoryVersions {
			return nil, nil, 0, ErrSenderHistoryStale
		}
		if uint64(len(candidateRaw)) > maxSenderOuterRowBytes {
			return nil, nil, 0, ErrSenderHistoryStale
		}
		candidateBytes := uint64(len(candidateRaw))
		if bytesUsed+candidateBytes > maxSenderHistoryBytes {
			return nil, nil, 0, ErrSenderHistoryStale
		}
		bytesUsed += candidateBytes
		collected := make([]any, 0, version-cachedVersion+1)
		after := uint64(0)
		if cachedVersion > 0 {
			after = cachedVersion - 1
		}
		overranCandidate := false
		if version == cachedVersion {
			collected = append(collected, candidate)
			rowsUsed++
		} else {
			for after < version {
				if err = ctx.Err(); err != nil {
					return nil, nil, 0, err
				}
				page, pageErr := session.DeviceListHistory(ctx, user, after)
				if pageErr != nil {
					return nil, nil, 0, pageErr
				}
				if len(page) == 0 || len(page) > senderHistoryPageSize {
					return nil, nil, 0, ErrSenderHistoryStale
				}
				for _, row := range page {
					rowVersion, rowRaw, rowErr := encodeSenderOuter(row)
					if rowErr != nil || rowVersion != after+1 {
						return nil, nil, 0, ErrSenderHistoryStale
					}
					if rowVersion > version {
						overranCandidate = true
						break
					}
					rowsUsed++
					bytesUsed += uint64(len(rowRaw))
					if rowsUsed > maxSenderHistoryVersions || bytesUsed > maxSenderHistoryBytes {
						return nil, nil, 0, ErrSenderHistoryStale
					}
					collected = append(collected, row)
					after = rowVersion
				}
				if overranCandidate {
					break
				}
			}
		}
		if rowsUsed > maxSenderHistoryVersions || bytesUsed > maxSenderHistoryBytes {
			return nil, nil, 0, ErrSenderHistoryStale
		}
		if !overranCandidate {
			if len(collected) == 0 {
				return nil, nil, 0, ErrSenderHistoryStale
			}
			lastRow, ok := collected[len(collected)-1].([]any)
			if !ok {
				return nil, nil, 0, ErrSenderHistoryStale
			}
			lastVersion, lastRaw, lastErr := encodeSenderOuter(lastRow)
			if lastErr != nil || lastVersion != version || !bytesEqual(lastRaw, candidateRaw) {
				return nil, nil, 0, ErrSenderHistoryStale
			}
		}
		currentRaw, readErr := session.OwnDeviceList(ctx, user)
		if readErr != nil {
			return nil, nil, 0, readErr
		}
		current, currentVersion, decodeErr := decodeSenderOuter(currentRaw)
		if decodeErr == nil && currentVersion == version && bytesEqual(currentRaw, candidateRaw) && !overranCandidate {
			innerValue, ok := candidate[1].([]byte)
			if !ok {
				return nil, nil, 0, ErrSenderHistoryStale
			}
			inner := append([]byte(nil), innerValue...)
			body, marshalErr := cborx.Marshal(collected)
			if marshalErr != nil || len(body) > maxSenderHistoryBytes {
				return nil, nil, 0, ErrSenderHistoryStale
			}
			return body, inner, version, nil
		}
		// Only a moving forward head justifies the one bounded retry. A rollback, malformed head,
		// or changed bytes at the same version is stale and must never be trusted.
		if decodeErr != nil || currentVersion <= version {
			return nil, nil, 0, ErrSenderHistoryStale
		}
		_ = current
	}
	return nil, nil, 0, ErrSenderHistoryStale
}

func decodeSenderOuter(raw []byte) ([]any, uint64, error) {
	if len(raw) == 0 || len(raw) > maxSenderOuterRowBytes {
		return nil, 0, ErrSenderHistoryStale
	}
	var row []any
	if err := cborx.Unmarshal(raw, &row); err != nil {
		return nil, 0, ErrSenderHistoryStale
	}
	version, _, err := encodeSenderOuter(row)
	if err != nil {
		return nil, 0, err
	}
	return row, version, nil
}

func encodeSenderOuter(row []any) (uint64, []byte, error) {
	if len(row) != 4 {
		return 0, nil, ErrSenderHistoryStale
	}
	version, ok := row[0].(uint64)
	if !ok || version == 0 || version > math.MaxInt64 {
		return 0, nil, ErrSenderHistoryStale
	}
	if _, ok = row[1].([]byte); !ok {
		return 0, nil, ErrSenderHistoryStale
	}
	signature, ok := row[2].([]byte)
	if !ok || len(signature) != 64 {
		return 0, nil, ErrSenderHistoryStale
	}
	previous, ok := row[3].([]byte)
	if !ok || len(previous) != 32 {
		return 0, nil, ErrSenderHistoryStale
	}
	raw, err := cborx.Marshal(row)
	if err != nil || len(raw) > maxSenderOuterRowBytes {
		return 0, nil, ErrSenderHistoryStale
	}
	return version, raw, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
