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

// ACLForTest and DeviceListsForTest are the seams New defaulted, which is the only way to see
// that a DS built without them is built with the conservative Plan-1 stubs rather than with
// nothing at all.
func ACLForTest(d *DS) ACL { return d.opts.ACL }

func DeviceListsForTest(d *DS) DeviceLists { return d.opts.DeviceLists }

// WithGroupForTest is withGroup WITHOUT the per-group lock every public read path takes first.
// Tree and Register serialise one group's work through d.lock, so the state cache's own
// concurrency — the reservation that keeps two first touches of one group from importing it
// twice, and from holding two instances out of a pool that hands back neither — can only be
// driven by calling the cache directly.
func WithGroupForTest(d *DS, ctx context.Context, groupID id.ID, fn func(*mlswasi.PublicGroup) error) error {
	return d.withGroup(ctx, groupID, fn)
}

// CommitExternalForTest is `commit` on the EXTERNAL path — the one tasks 24 and 25 turn on. No
// caller sets commitOptions.external in task 20, so the two branches that separate a member commit
// from an external one (the structural sender check, and the staged-handle release that has to
// cover it) have no entry point from the public surface. They are reachable code in the shipped
// binary the moment task 24 lands, and a handle leak on that path is driven by any enrolled
// device, so they are tested here rather than left for the task that turns the flag on.
func CommitExternalForTest(d *DS, ctx context.Context, s Session, groupID id.ID, c CommitRequest) (CommitResult, error) {
	return d.commit(ctx, s, groupID, c, commitOptions{external: true})
}

// QueueMemberProposalForTest is queueMemberProposal: the guest-side half of `Proposal`, from the
// put into the PublicGroup's queue to the shape decision. It is exported because the leaf check
// above it refuses every proposal this repository holds — the fixture's one proposal has an
// external sender — so the refusals that happen AFTER the queue has been written cannot be reached
// through `Proposal` with committed material.
func QueueMemberProposalForTest(d *DS, ctx context.Context, g *mlswasi.PublicGroup, s Session, groupID id.ID, blob []byte) ([]byte, mlswasi.ProposalDetail, error) {
	return d.queueMemberProposal(ctx, g, s, groupID, blob)
}
