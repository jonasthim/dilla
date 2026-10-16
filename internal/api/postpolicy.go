package api

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// PostPolicy is the delivery service's ds.PostPolicy (web3.7 SB1, protocol/02 § Upload class): the
// host's two rules for an end-to-end encrypted upload into a community text group. A class-0
// upload (a post) needs send_messages in the channel, else 403 E_FORBIDDEN, and waits out the
// channel's slow mode since the user's last class-0 upload into any of its text groups, from any
// device, unless they hold bypass_slowmode, else 429 E_RATE_LIMITED. A class-1 upload (an edit,
// delete, reaction, pin or other fold) is never checked. Direct messages and call groups are
// unchecked.
type PostPolicy struct {
	Repo     store.Repository
	Resolver *Resolver
}

// Check decides one upload of class by userID into g at now (unix seconds). The delivery service
// calls it under the group lock, before the store transaction, and returns its error unchanged.
//
// A nil class is a legacy two-element upload (web3.7 only, R28): the host cannot tell its type, so
// it is checked for send_messages whatever it carries, and never slowed.
func (p PostPolicy) Check(ctx context.Context, g store.GroupRow, userID id.ID, class *uint8, now int64) error {
	if g.Kind != GroupText || g.CommunityID == nil {
		return nil
	}
	ch, err := p.Repo.GetChannel(ctx, g.TargetID)
	if errors.Is(err, store.ErrNotFound) {
		return nil // the delivery service decides about a deleted channel's group
	}
	if err != nil {
		return err
	}
	bits, err := p.Resolver.Resolve(ctx, userID, ch)
	if err != nil {
		return err
	}
	if class != nil && *class == 1 {
		return nil
	}
	if !bits.Has(PermSendMessages) {
		return server.Errorf(server.CodeForbidden, "missing permission")
	}
	if class == nil {
		return nil // a legacy upload is never slowed (R28)
	}
	if ch.SlowmodeSeconds == 0 || bits.Has(PermBypassSlowmode) {
		return nil
	}
	last, err := p.Repo.LastClassZeroUploadAt(ctx, ch.ID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return slowmodeWait(ch.SlowmodeSeconds, last, now)
}
