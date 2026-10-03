package sfu

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"

	"github.com/jonasthim/dilla/internal/id"
)

// ErrNoParticipant is UpdatePermission's answer for an identity the room does not hold (LiveKit's
// "participant does not exist", twirp not_found). The publisher lease rolls back on it.
var ErrNoParticipant = errors.New("sfu: participant does not exist")

// The room timeouts CreateRoom applies when Config leaves them at zero: LiveKit's own defaults
// (livekit-server v1.13.7 pkg/config/config.go) — departure_timeout once anyone has joined, and
// empty_timeout for a room nobody ever joined (rtc/room.go:774-808 CloseIfEmpty).
const (
	createRoomEmptyTimeout     uint32 = 300
	createRoomDepartureTimeout uint32 = 20
)

// PublishGrant is the one mapping from dilla's speak, video and screen_share bits to a LiveKit
// permission, used both to mint a token and to push a live change (gap G26), so the two cannot
// drift. It is always fully populated, because UpdateFromPermission overwrites every field and a
// zero CanSubscribe would drop every subscription the participant has:
//
//   - subscribe always, no data (DEV-61), never hidden, no metadata or metrics or agent rights;
//   - the sources in the fixed order [MICROPHONE, CAMERA, SCREEN_SHARE, SCREEN_SHARE_AUDIO], filtered
//     to the held bits (screen_share carries its audio; screen_share_audio never stands alone);
//   - no bit at all is CanPublish false with NO source list: LiveKit reads an empty list as every
//     source (auth/grants.go GetCanPublishSource), so "none" is never spelled [].
//
// The caller decides video and screen: a device holds the camera and screen sources only while it
// holds a sharing slot (api.shareLeases, ruling F1).
func PublishGrant(speak, video, screen bool) *livekit.ParticipantPermission {
	var sources []livekit.TrackSource
	if speak {
		sources = append(sources, livekit.TrackSource_MICROPHONE)
	}
	if video {
		sources = append(sources, livekit.TrackSource_CAMERA)
	}
	if screen {
		sources = append(sources, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	}
	return &livekit.ParticipantPermission{
		CanSubscribe:          true,
		CanPublish:            len(sources) > 0,
		CanPublishData:        false,
		CanPublishSources:     sources,
		Hidden:                false,
		CanUpdateMetadata:     false,
		CanSubscribeMetrics:   false,
		CanManageAgentSession: false,
	}
}

// roomServiceFor is a RoomService client over the loopback HTTP port, carrying a one-minute token
// with grant: RoomCreate for CreateRoom, a room-scoped RoomAdmin for the participant calls
// (livekit-server pkg/service/auth.go:184-195 requires RoomAdmin && Room == req.Room).
func (s *Server) roomServiceFor(ctx context.Context, grant *auth.VideoGrant) (livekit.RoomService, context.Context, error) {
	tok, err := auth.NewAccessToken(s.cfg.APIKey, s.cfg.APISecret).
		SetVideoGrant(grant).
		SetValidFor(adminTokenTTL).
		ToJWT()
	if err != nil {
		return nil, nil, fmt.Errorf("sfu: room service token: %w", err)
	}
	h := make(http.Header)
	h.Set("Authorization", "Bearer "+tok)
	ctx, err = twirp.WithHTTPRequestHeaders(ctx, h)
	if err != nil {
		return nil, nil, fmt.Errorf("sfu: room service headers: %w", err)
	}
	return livekit.NewRoomServiceProtobufClient(s.HTTPURL(), http.DefaultClient), ctx, nil
}

func isTwirpNotFound(err error) bool {
	var te twirp.Error
	return errors.As(err, &te) && te.Code() == twirp.NotFound
}

// CreateRoom opens room in the SFU before a token for it is handed out. room.auto_create is false
// (DEV-44), so LiveKit refuses a join to a room it does not hold with 404 "requested room does not
// exist": a refreshed token cannot resurrect a room the instance deleted. LiveKit's CreateRoom does
// not check auto_create and is idempotent on a live room (roomallocator.go:60-90), so every call
// start may call it.
func (s *Server) CreateRoom(ctx context.Context, room string) error {
	if room == "" {
		return errors.New("sfu: room must be set")
	}
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	empty, departure := s.cfg.EmptyTimeout, s.cfg.DepartureTimeout
	if empty == 0 {
		empty = createRoomEmptyTimeout
	}
	if departure == 0 {
		departure = createRoomDepartureTimeout
	}
	if _, err := rs.CreateRoom(ctx, &livekit.CreateRoomRequest{
		Name: room, MaxParticipants: s.cfg.MaxParticipants, EmptyTimeout: empty, DepartureTimeout: departure,
	}); err != nil {
		return fmt.Errorf("sfu: create room %q: %w", room, err)
	}
	return nil
}

// UpdatePermission replaces identity's permission in room with perm, which must be complete
// (PublishGrant): LiveKit unpublishes every track whose source perm no longer allows and pushes a
// refreshed token carrying it at once (participant.go:849-906, roommanager.go:622-627). An identity
// the room does not hold is ErrNoParticipant.
func (s *Server) UpdatePermission(ctx context.Context, room, identity string, perm *livekit.ParticipantPermission) error {
	if room == "" || identity == "" || perm == nil {
		return errors.New("sfu: room, identity and permission must all be set")
	}
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	if _, err := rs.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: room, Identity: identity, Permission: perm,
	}); err != nil {
		if isTwirpNotFound(err) {
			return ErrNoParticipant
		}
		return fmt.Errorf("sfu: update the permission of %q in %q: %w", identity, room, err)
	}
	return nil
}

// Participants is LiveKit's participant list of room (the local store's snapshot), empty for a room
// it does not hold.
func (s *Server) Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	if room == "" {
		return nil, errors.New("sfu: room must be set")
	}
	rs, ctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return nil, err
	}
	res, err := rs.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		if isTwirpNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("sfu: list the participants of %q: %w", room, err)
	}
	return res.GetParticipants(), nil
}

// RemoveParticipants disconnects device from room: the participant whose identity is the device id
// and every "<device id>#…" shadow LiveKit's publish parameter could have created (gap G29). A
// participant that left in the meantime is not an error.
func (s *Server) RemoveParticipants(ctx context.Context, room string, device id.ID) error {
	parts, err := s.Participants(ctx, room)
	if err != nil {
		return err
	}
	rs, rctx, err := s.roomServiceFor(ctx, &auth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	dev := device.String()
	var errs []error
	for _, p := range parts {
		identity := p.GetIdentity()
		if identity != dev && !strings.HasPrefix(identity, dev+"#") {
			continue
		}
		if _, err := rs.RemoveParticipant(rctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity}); err != nil && !isTwirpNotFound(err) {
			errs = append(errs, fmt.Errorf("sfu: remove %q from %q: %w", identity, room, err))
		}
	}
	return errors.Join(errs...)
}

// VerifyToken checks that token is a room-join token this server signed and answers its identity and
// room: the /rtc proxy's join gate (DEV-25) reads both before LiveKit ever sees the request.
func (s *Server) VerifyToken(token string) (identity, room string, err error) {
	if token == "" {
		return "", "", errors.New("sfu: no access token")
	}
	v, err := auth.ParseAPIToken(token)
	if err != nil {
		return "", "", fmt.Errorf("sfu: parse the access token: %w", err)
	}
	if v.APIKey() != s.cfg.APIKey {
		return "", "", errors.New("sfu: the access token names another API key")
	}
	_, grants, err := v.Verify(s.cfg.APISecret)
	if err != nil {
		return "", "", fmt.Errorf("sfu: verify the access token: %w", err)
	}
	if grants.Video == nil || !grants.Video.RoomJoin || grants.Video.Room == "" {
		return "", "", errors.New("sfu: not a room-join token")
	}
	return grants.Identity, grants.Video.Room, nil
}
