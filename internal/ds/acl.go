package ds

import (
	"context"

	"github.com/jonasthim/dilla/internal/id"
)

// PermissiveChannels is the Plan-1 stand-in for the channel-mode source of invariant 1. It
// reports "no channel row" for every target, which is the honest answer while the `channels`
// table does not exist: Plan 2 task 2 creates it (`006_structure.sql`) and replaces this with the
// real `store.Structure`, which is when the mode rule starts refusing anything in production.
// NV-B5 tracks the hand-over.
//
// It is NOT a mock of the delivery service. `checkChannelMode` — the rule itself — runs against
// it exactly as it runs against Plan 2's implementation; only the data source differs.
type PermissiveChannels struct{}

func (PermissiveChannels) Channel(_ context.Context, _ id.ID) (visibility, mode uint8, err error) {
	return 0, 0, ErrNoChannel
}
