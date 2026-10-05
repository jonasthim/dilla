package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/livekit/server-sdk-go/v2/pkg/samplebuilder"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
)

// maxLate is the SDK's own TrackDecryptor default: how many packets the sample builder waits for a
// late one.
const maxLate = 150

func depacketizer(mime string) (rtp.Depacketizer, error) {
	switch strings.ToLower(mime) {
	case strings.ToLower(webrtc.MimeTypeOpus):
		return &codecs.OpusPacket{}, nil
	case strings.ToLower(webrtc.MimeTypeVP8):
		return &codecs.VP8Packet{}, nil
	case strings.ToLower(webrtc.MimeTypeVP9):
		return &codecs.VP9Packet{}, nil
	case strings.ToLower(webrtc.MimeTypeH264):
		return &codecs.H264Packet{}, nil
	}
	return nil, fmt.Errorf("media: no depacketizer for %q", mime)
}

// frameJoiner keeps all samples with one RTP timestamp together. The last frame is flushed at EOF.
// started, not a nil frame, marks an open frame, so an empty sample is still finished as a frame.
type frameJoiner struct {
	decryptor *FrameDecryptor
	frame     []byte
	timestamp uint32
	started   bool
}

func (j *frameJoiner) add(data []byte, timestamp uint32) {
	if j.started && timestamp != j.timestamp {
		j.finish()
	}
	j.frame = append(j.frame, data...)
	j.timestamp = timestamp
	j.started = true
}

func (j *frameJoiner) finish() {
	if j.started {
		_, _ = j.decryptor.DecryptFrame(j.frame) // a drop is counted inside; keep reading
		j.frame, j.started = nil, false
	}
}

// DecryptLoop reassembles track's frames and hands each to d, which counts every drop; a drop never
// stops it (SP-15: the SDK's TrackDecryptor returns on the first decrypt error). It returns
// ctx.Err() once ctx ends and nil when the track ends.
//
// Two things the sample builder alone gets wrong, both measured against the pinned SFU:
//   - It starts a new sample at every partition head, and an H.264 STAP-A (SPS+PPS) and the IDR's
//     FU-A are separate heads with one RTP timestamp, so a key access unit came out as two samples
//     (E_SFRAME_NO_VCL_NAL, then E_SFRAME_AUTH: the IDR's AAD lacks the parameter sets). Samples
//     are therefore joined by RTP timestamp, and a frame is decrypted when the next timestamp
//     begins (one frame of latency, which a rig and a bot can afford).
//   - LiveKit's probe padding (livekit-server pkg/sfu/downtrack.go WritePaddingRTP) sets the
//     padding bit and also puts its 255 padding bytes in the payload, so after pion strips the
//     padding a 255-byte zero "payload" is left that parses as a VP8 frame (E_SFRAME_UNKNOWN_KID).
//     A padded packet carries no media; it still goes in, empty, because the sample builder needs
//     its sequence number.
//
// And one thing it cannot do: an Opus packet with an empty payload (the zero-byte audio DTX frame
// of protocol/05) fails pion's OpusPacket.Unmarshal, so the builder never emits it. Such a packet is
// handed to d as its own frame, which counts it as an empty frame on a microphone or screen-audio
// track (and as a drop on any other), and still goes into the builder for its sequence number.
func DecryptLoop(ctx context.Context, track *webrtc.TrackRemote, d *FrameDecryptor) error {
	stop := context.AfterFunc(ctx, func() { _ = track.SetReadDeadline(time.Now()) })
	defer stop()
	read := func() (*rtp.Packet, error) {
		pkt, _, err := track.ReadRTP()
		return pkt, err
	}
	return decryptPackets(ctx, read, track.Codec(), d)
}

// decryptPackets is DecryptLoop over any packet source: read returns io.EOF when the track ends.
func decryptPackets(ctx context.Context, read func() (*rtp.Packet, error), c webrtc.RTPCodecParameters, d *FrameDecryptor) error {
	dep, err := depacketizer(c.MimeType)
	if err != nil {
		return err
	}
	opus := strings.EqualFold(c.MimeType, webrtc.MimeTypeOpus)
	sb := samplebuilder.New(maxLate, dep, c.ClockRate)
	joiner := frameJoiner{decryptor: d}
	for {
		pkt, err := read()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) {
				for {
					s, ts := sb.ForcePopWithTimestamp()
					if s == nil {
						break
					}
					joiner.add(s.Data, ts)
				}
				joiner.finish()
				return nil
			}
			return err
		}
		if pkt.Padding {
			pkt.Payload = nil
		} else if opus && len(pkt.Payload) == 0 {
			_, _ = d.DecryptFrame([]byte{}) // counted inside: an empty frame, or a drop off an audio slot
		}
		sb.Push(pkt)
		for {
			s, ts := sb.PopWithTimestamp()
			if s == nil {
				break
			}
			joiner.add(s.Data, ts)
		}
	}
}
