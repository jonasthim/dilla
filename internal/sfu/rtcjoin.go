package sfu

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/livekit/livekit-server/pkg/service"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"
)

// ErrBadJoinRequest is a join_request LiveKit itself refuses with 400 before any session starts: not
// base64url, not a WrappedJoinRequest, a JoinRequest that does not decode, or one larger than
// http.DefaultMaxHeaderBytes (raw, or once decompressed).
var ErrBadJoinRequest = errors.New("sfu: malformed join_request")

// JoinIsResume reads a signalling request's query exactly as livekit-server v1.13.7 does
// (pkg/service/rtcservice.go:155-160, 175-213, 238-239, 289) and answers whether LiveKit will treat
// it as a resume of a participant it already holds:
//
//   - without join_request (the v0 form) a resume is reconnect "1" or "true" (utils.go boolValue);
//   - with join_request (the v1 form, which /rtc accepts too) it is the JoinRequest's own Reconnect
//     flag, inside a base64url WrappedJoinRequest whose payload is uncompressed or gzip — with
//     LiveKit's bounds: an uncompressed payload over http.DefaultMaxHeaderBytes, or a gzip payload
//     that decompresses past it (service.DecompressGzip, the function LiveKit calls), is refused. A
//     compression value LiveKit does not know leaves the JoinRequest empty, a fresh join, as LiveKit
//     does.
//
// Anything LiveKit would refuse is ErrBadJoinRequest. Both sides read the first value of the same
// url.ParseQuery of the URL (the proxy admits only GET, so FormValue reads no body).
func JoinIsResume(q url.Values) (bool, error) {
	wrapped := q.Get("join_request")
	if wrapped == "" {
		v := q.Get("reconnect")
		return v == "1" || v == "true", nil
	}
	raw, err := base64.URLEncoding.DecodeString(wrapped)
	if err != nil {
		return false, fmt.Errorf("%w: cannot base64 decode wrapped join request", ErrBadJoinRequest)
	}
	w := &livekit.WrappedJoinRequest{}
	if err := proto.Unmarshal(raw, w); err != nil {
		return false, fmt.Errorf("%w: cannot unmarshal wrapped join request", ErrBadJoinRequest)
	}
	jr := &livekit.JoinRequest{}
	switch w.GetCompression() {
	case livekit.WrappedJoinRequest_NONE:
		if len(w.GetJoinRequest()) > http.DefaultMaxHeaderBytes {
			return false, fmt.Errorf("%w: join request too large", ErrBadJoinRequest)
		}
		if err := proto.Unmarshal(w.GetJoinRequest(), jr); err != nil {
			return false, fmt.Errorf("%w: cannot unmarshal join request", ErrBadJoinRequest)
		}
	case livekit.WrappedJoinRequest_GZIP:
		plain, err := service.DecompressGzip(w.GetJoinRequest())
		if err != nil {
			return false, fmt.Errorf("%w: %w", ErrBadJoinRequest, err)
		}
		if err := proto.Unmarshal(plain, jr); err != nil {
			return false, fmt.Errorf("%w: cannot unmarshal join request", ErrBadJoinRequest)
		}
	}
	return jr.GetReconnect(), nil
}
