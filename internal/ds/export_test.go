package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

// export_test.go exposes three unexported decoders and one unexported rule to the external test
// package. The two decoders are pinned against committed vectors and the rule against a channel
// shape no committed fixture can supply, which is the whole point of testing them here.

// DecodeCredentialIdentityForTest is decodeCredentialIdentity.
var DecodeCredentialIdentityForTest = decodeCredentialIdentity

// DecodeBindingForTest is decodeBinding.
func DecodeBindingForTest(b []byte) (Binding, error) { return decodeBinding(b) }

// CheckChannelModeForTest is invariant 1's rule on its own. The committed fixture is a TEXT group
// and there is no call-group fixture, so the clause that lets a call group onto a readable or
// discoverable channel is exercised here rather than through a Register no fixture can drive.
func CheckChannelModeForTest(d *DS, ctx context.Context, b Binding) error {
	return d.checkChannelMode(ctx, b)
}

// WithGroupForTest is withGroup WITHOUT the per-group lock every public read path takes first.
// Tree and Register serialise one group's work through d.lock, so the state cache's own
// concurrency — the reservation that keeps two first touches of one group from importing it
// twice, and from holding two instances out of a pool that hands back neither — can only be
// driven by calling the cache directly.
func WithGroupForTest(d *DS, ctx context.Context, groupID id.ID, fn func(*mlswasi.PublicGroup) error) error {
	return d.withGroup(ctx, groupID, fn)
}
