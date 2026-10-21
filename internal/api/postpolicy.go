package api

import (
	"context"
	"errors"

	botaccess "github.com/jonasthim/dilla/internal/bot/access"
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
// Every upload names its class: the route refuses the two-element legacy body web3.7 accepted
// (web3.8 S1). A class other than 1 is decided as a post. A group whose channel is gone is refused
// for every class (fail closed). The wait is read from the user's durable mark, which Upload
// raises on every accepted class-0 post, so a pruned post still holds it.
func (p PostPolicy) Check(ctx context.Context, g store.GroupRow, userID id.ID, class uint8, now int64) error {
	if g.CommunityID == nil {
		bot, err := botaccess.IsBotUser(ctx, p.Repo, userID)
		if err != nil {
			return err
		}
		if bot {
			return server.Errorf(server.CodeForbidden, "managed bots cannot post outside their community")
		}
	} else {
		binding, bot, err := botaccess.ForUserCommunity(ctx, p.Repo, userID, *g.CommunityID)
		if err != nil {
			if errors.Is(err, botaccess.ErrIneligible) {
				return server.Errorf(server.CodeForbidden, "managed bot installation is not eligible for this community")
			}
			return err
		}
		if bot && (binding.State != store.BotInstallationReady || binding.CommunityID != *g.CommunityID) {
			return server.Errorf(server.CodeForbidden, "managed bot installation is not ready for sends")
		}
	}
	if g.Kind != GroupText || g.CommunityID == nil {
		return nil
	}
	ch, err := p.Repo.GetChannel(ctx, g.TargetID)
	if errors.Is(err, store.ErrNotFound) {
		// Fail closed (SB1 fix round 1): a deleted channel's group that is still open takes no
		// upload of any class. The delivery service also refuses a closed group outright.
		return server.Errorf(server.CodeForbidden, "missing permission")
	}
	if err != nil {
		return err
	}
	bits, err := p.Resolver.Resolve(ctx, userID, ch)
	if err != nil {
		return err
	}
	if class == 1 {
		return nil
	}
	if !bits.Has(PermSendMessages) {
		return server.Errorf(server.CodeForbidden, "missing permission")
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
