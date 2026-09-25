package ds

import "context"

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
