package api

import (
	"context"
	"log/slog"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// memberPage is how many members one read of the notifier takes; the member route pages at 200.
// A variable only so a test can lower it and reach the second page without 200 members.
var memberPage int32 = 200

// StructureNotifier tells a community's members that its structure changed: op 54
// community_changed `[community_id]` (protocol/02 § Gateway frames) to every live connection of
// every member, after the commit of a channel create, update or delete and of a community PATCH.
// The frame names only the community; a client re-reads what it may see through the routes that
// check its permissions. A nil *StructureNotifier sends nothing.
type StructureNotifier struct {
	gw   VoiceGateway
	repo store.Repository
	log  *slog.Logger
}

// NewStructureNotifier delivers through gw (*gateway.Gateway is one) to the members repo lists.
func NewStructureNotifier(gw VoiceGateway, repo store.Repository, log *slog.Logger) *StructureNotifier {
	return &StructureNotifier{gw: gw, repo: repo, log: log}
}

// Changed sends community_changed for cid to every member. A failure is logged, not answered: the
// change is committed, and a client that missed the frame still re-reads on focus and on reconnect.
func (n *StructureNotifier) Changed(ctx context.Context, cid id.ID) {
	if n == nil || n.gw == nil {
		return
	}
	p, err := gateway.CommunityChangedPayload(cid)
	if err != nil {
		n.log.ErrorContext(ctx, "encoding a community_changed failed", "err", err)
		return
	}
	f := gateway.Frame{Op: gateway.OpCommunityChanged, Payload: p}
	after := id.ID{}
	for {
		page, err := n.repo.ListMembersOfCommunity(ctx, cid, after, memberPage)
		if err != nil {
			n.log.ErrorContext(ctx, "listing members for community_changed failed", "community", cid, "err", err)
			return
		}
		for _, m := range page {
			n.gw.DeliverUser(m.UserID, f)
		}
		if len(page) < int(memberPage) {
			return
		}
		after = page[len(page)-1].UserID
	}
}
