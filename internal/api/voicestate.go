package api

import (
	"context"

	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// VoiceGateway is where voice_state frames go; *gateway.Gateway is one.
type VoiceGateway interface {
	DeliverUser(userID id.ID, f gateway.Frame)
}

// The voice_state flag bits (protocol/02 § Gateway frames, DEV-60, ruling F10). The instance sets
// bits 0, 3 and 4 from what its SFU reports; bits 1 and 2 are reserved for the client-reported mute
// and deafen state no client→server path carries yet (follow-up card 11).
const (
	VoiceInCall   uint64 = 1 << 0
	VoiceSelfMute uint64 = 1 << 1
	VoiceSelfDeaf uint64 = 1 << 2
	VoiceVideo    uint64 = 1 << 3
	VoiceScreen   uint64 = 1 << 4
)

// announce sends one voice_state to every device of every user who may view ch (MD-11): the
// resolver's view_channel holders of a community channel, a DM's participants. The gateway delivers
// to the users' live connections only, so an offline user receives nothing.
func (c *CallEvents) announce(ctx context.Context, ch store.ChannelRow, callID, user, dev id.ID, flags uint64) {
	if c.gw == nil {
		return
	}
	payload, err := gateway.VoiceStatePayload(user, dev, callID, flags)
	if err != nil {
		c.log.ErrorContext(ctx, "encoding a voice_state failed", "err", err)
		return
	}
	audience, err := EligibleUsers(ctx, c.repo, ch)
	if err != nil {
		c.log.ErrorContext(ctx, "resolving a voice channel's audience failed", "channel_id", ch.ID.String(), "err", err)
		return
	}
	f := gateway.Frame{Op: gateway.OpVoiceState, Payload: payload}
	for _, u := range audience {
		c.gw.DeliverUser(u, f)
	}
}
