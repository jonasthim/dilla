//go:build spike

package sfu

// SP-15 (docs/spikes/2026-10-go-publisher.md): before internal/media exists, measure the publish
// and decrypt shapes it will take with dilla's pins and no cgo. Behind the spike tag: these tests
// measure, they do not gate, and none of them runs in CI (MD-17). Run them with
//
//	go test -tags spike -count=1 -v -run TestSpike ./internal/sfu/
//
// Without -race on purpose: (c) measures WriteSample latency, which the race detector's
// instrumentation inflates, and a video publish into the pinned LiveKit trips an upstream data race
// (livekit-server v1.13.7 pkg/rtc/participant.go:1153, updateRidsFromSDP against the signalling
// encoder) that fails whichever test is running with "race detected during execution of test".
//
// Every number the result document quotes is printed on a line that starts with "SPIKE".

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/e2ee"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// spikeMedia is task 6's committed fixtures, relative to this package.
const spikeMedia = "../media/testdata/"

// countingEncryptor passes every frame through unchanged and records what the SDK handed it: how
// often, over what span, and the first 32 payloads.
type countingEncryptor struct {
	mu     sync.Mutex
	calls  int
	first  time.Time
	last   time.Time
	frames [][]byte
}

func (e *countingEncryptor) EncryptFrame(p []byte) ([]byte, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := time.Now()
	if e.calls == 0 {
		e.first = now
	}
	e.last = now
	e.calls++
	if len(e.frames) < 32 {
		e.frames = append(e.frames, bytes.Clone(p))
	}
	return p, nil
}

func (e *countingEncryptor) snapshot() (calls int, span time.Duration, frames [][]byte) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls, e.last.Sub(e.first), slices.Clone(e.frames)
}

// passDecryptor hands every reassembled frame back unchanged.
type passDecryptor struct{}

func (passDecryptor) DecryptFrame(p []byte) ([]byte, error) { return p, nil }

// aeadEscapingEncryptor is the cost of the real thing without the real thing (internal/sframe is
// task 7): AES-128-GCM over everything after the start code and the NAL header, then libwebrtc's
// WriteRbsp escaping over the sealed bytes, all inside EncryptFrame, which the SDK calls under the
// LocalTrack mutex (localtrack.go:405-541).
type aeadEscapingEncryptor struct {
	aead cipher.AEAD
	seq  uint64
}

func newAEADEscapingEncryptor(t *testing.T) *aeadEscapingEncryptor {
	t.Helper()
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("key: %v", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("aes: %v", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	return &aeadEscapingEncryptor{aead: aead}
}

func (e *aeadEscapingEncryptor) EncryptFrame(p []byte) ([]byte, error) {
	const clearLen = 5 // 00 00 00 01 and the NAL header
	if len(p) <= clearLen {
		return p, nil
	}
	var nonce [12]byte
	binary.BigEndian.PutUint64(nonce[4:], e.seq)
	e.seq++
	sealed := e.aead.Seal(nil, nonce[:], p[clearLen:], p[:clearLen])
	return append(bytes.Clone(p[:clearLen]), writeRbsp(sealed)...), nil
}

// writeRbsp is libwebrtc's WriteRbsp (h264_common.cc:98-118): an 03 before any byte <= 03 that
// follows two zeros.
func writeRbsp(in []byte) []byte {
	out := make([]byte, 0, len(in)+len(in)/64)
	zeros := 0
	for _, b := range in {
		if b <= 3 && zeros >= 2 {
			out = append(out, 3)
			zeros = 0
		}
		out = append(out, b)
		if b == 0 {
			zeros++
		} else {
			zeros = 0
		}
	}
	return out
}

func spikeServer(t *testing.T) (*Server, Config) {
	t.Helper()
	c := testConfig()
	srv, err := Start(context.Background(), c)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := srv.Stop(ctx); err != nil {
			t.Errorf("Stop: %v", err)
		}
	})
	return srv, c
}

func spikeJoin(t *testing.T, srv *Server, room, identity string, cb *lksdk.RoomCallback) *lksdk.Room {
	t.Helper()
	tok, err := srv.Token(room, identity)
	if err != nil {
		t.Fatalf("Token(%s): %v", identity, err)
	}
	r, err := lksdk.ConnectToRoomWithToken(srv.URL(), tok, cb)
	if err != nil {
		t.Fatalf("%s join: %v", identity, err)
	}
	t.Cleanup(r.Disconnect)
	return r
}

func custom(name string, source livekit.TrackSource) *lksdk.TrackPublicationOptions {
	return &lksdk.TrackPublicationOptions{Name: name, Source: source, Encryption: livekit.Encryption_CUSTOM}
}

// (a) One EncryptFrame per Ogg packet (20 ms) once the track is bound, and the publication is
// CUSTOM in LiveKit's own state.
func TestSpikeAnOggOpusFileTrackEncryptsOncePerPacket(t *testing.T) {
	srv, c := spikeServer(t)
	const room = "sp15-opus"
	alice := spikeJoin(t, srv, room, "alice", &lksdk.RoomCallback{})
	enc := &countingEncryptor{}
	track, err := lksdk.NewLocalFileTrack(spikeMedia+"tone.ogg",
		lksdk.ReaderTrackWithSampleOptions(lksdk.WithFrameEncryptor(enc)))
	if err != nil {
		t.Fatalf("NewLocalFileTrack: %v", err)
	}
	if _, err := alice.LocalParticipant.PublishTrack(track, custom("mic", livekit.TrackSource_MICROPHONE)); err != nil {
		t.Fatalf("PublishTrack: %v", err)
	}
	time.Sleep(4 * time.Second)
	calls, span, _ := enc.snapshot()
	if calls < 2 {
		t.Fatalf("EncryptFrame ran %d times in 4 s: the track never bound", calls)
	}
	rate := float64(calls-1) / span.Seconds()
	t.Logf("SPIKE opus_encrypt_calls=%d opus_encrypt_span=%s opus_encrypt_calls_per_second=%.1f", calls, span, rate)
	if rate < 40 || rate > 60 {
		t.Errorf("%.1f EncryptFrame calls per second, want 50 (one per 20 ms packet)", rate)
	}

	res, err := lksdk.NewRoomServiceClient(srv.HTTPURL(), c.APIKey, c.APISecret).
		ListParticipants(context.Background(), &livekit.ListParticipantsRequest{Room: room})
	if err != nil {
		t.Fatalf("ListParticipants: %v", err)
	}
	seen := 0
	for _, p := range res.Participants {
		if p.Identity != "alice" {
			continue
		}
		for _, tr := range p.Tracks {
			seen++
			t.Logf("SPIKE opus_track_encryption=%s", tr.Encryption)
			if tr.Encryption != livekit.Encryption_CUSTOM {
				t.Errorf("alice's track is %s in LiveKit's state, want CUSTOM", tr.Encryption)
			}
		}
	}
	if seen == 0 {
		t.Fatal("ListParticipants shows no track for alice")
	}
}

// (b) A single-layer VP8 IVF publication reaches a Go subscriber through the SDK's TrackDecryptor
// with a pass-through decryptor, key frames included.
func TestSpikeASingleLayerVP8PublicationDecryptsInAGoSubscriber(t *testing.T) {
	srv, _ := spikeServer(t)
	const room = "sp15-vp8"
	var frames, keyFrames atomic.Int64
	var encryption atomic.Int32
	encryption.Store(-1)
	bobCB := &lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
			encryption.Store(int32(pub.TrackInfo().GetEncryption()))
			go func() {
				td := e2ee.NewTrackDecryptor(track, passDecryptor{})
				for {
					s, err := td.ReadSample()
					if err != nil {
						return
					}
					frames.Add(1)
					// A key frame is P = 0 and the start code 9d 01 2a (RFC 6386 §9.1). The P bit alone
					// also matches LiveKit's probe padding, which reaches ReadSample as a zero-filled
					// "frame" under the pinned modules (task 7's DecryptLoop explains and drops it).
					if len(s.Data) >= 10 && s.Data[0]&1 == 0 && bytes.Equal(s.Data[3:6], []byte{0x9d, 0x01, 0x2a}) {
						keyFrames.Add(1)
					}
				}
			}()
		},
	}}
	spikeJoin(t, srv, room, "bob", bobCB)
	alice := spikeJoin(t, srv, room, "alice", &lksdk.RoomCallback{})
	// The frame duration is fixed: with the SDK's IVF-timestamp-derived duration the writer stalled
	// on this fixture under the pinned SDK (6 frames in 4 s, nothing forwarded to bob; plan review
	// 2026-10-03), which is why task 7's ivfProvider sets its own duration too.
	track, err := lksdk.NewLocalFileTrack(spikeMedia+"bars.ivf",
		lksdk.ReaderTrackWithSampleOptions(lksdk.WithFrameEncryptor(&countingEncryptor{})),
		lksdk.ReaderTrackWithFrameDuration(time.Second/30))
	if err != nil {
		t.Fatalf("NewLocalFileTrack: %v", err)
	}
	if _, err := alice.LocalParticipant.PublishTrack(track, custom("camera", livekit.TrackSource_CAMERA)); err != nil {
		t.Fatalf("PublishTrack: %v", err)
	}
	time.Sleep(5 * time.Second)
	t.Logf("SPIKE vp8_frames_read=%d vp8_key_frames_read=%d vp8_subscriber_sees_encryption=%s",
		frames.Load(), keyFrames.Load(), livekit.Encryption_Type(encryption.Load()))
	if frames.Load() < 60 {
		t.Errorf("the Go subscriber read %d VP8 frames in 5 s, want at least 60 of the 150 sent", frames.Load())
	}
	if keyFrames.Load() == 0 {
		t.Error("no key frame reached the subscriber")
	}
	if livekit.Encryption_Type(encryption.Load()) != livekit.Encryption_CUSTOM {
		t.Errorf("the subscriber sees %s, want CUSTOM", livekit.Encryption_Type(encryption.Load()))
	}
}

// (c) WriteSample latency at 2 Mbps H.264 with stdlib AES-GCM and RBSP escaping inside the
// encryptor, which runs under the track mutex.
func TestSpikeWriteSampleLatencyAtTwoMegabitsWithAEADAndEscaping(t *testing.T) {
	srv, _ := spikeServer(t)
	alice := spikeJoin(t, srv, "sp15-h264-cost", "alice", &lksdk.RoomCallback{})
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000},
		lksdk.WithFrameEncryptor(newAEADEscapingEncryptor(t)))
	if err != nil {
		t.Fatalf("NewLocalTrack: %v", err)
	}
	bound := make(chan struct{})
	var once sync.Once
	track.OnBind(func() { once.Do(func() { close(bound) }) })
	if _, err := alice.LocalParticipant.PublishTrack(track, custom("camera", livekit.TrackSource_CAMERA)); err != nil {
		t.Fatalf("PublishTrack: %v", err)
	}
	select {
	case <-bound:
	case <-time.After(15 * time.Second):
		t.Fatal("the track never bound")
	}
	// 2 Mbps at 30 fps is 8,333 bytes a frame.
	frame := make([]byte, 8333)
	copy(frame, []byte{0, 0, 0, 1, 0x65})
	if _, err := rand.Read(frame[5:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	took := make([]time.Duration, 0, 300)
	for range 300 {
		start := time.Now()
		if err := track.WriteSample(media.Sample{Data: frame, Duration: time.Second / 30}, nil); err != nil {
			t.Fatalf("WriteSample: %v", err)
		}
		took = append(took, time.Since(start))
		time.Sleep(time.Second / 30)
	}
	slices.Sort(took)
	p50, p99, worst := took[len(took)/2], took[len(took)*99/100], took[len(took)-1]
	t.Logf("SPIKE writesample_frame_bytes=%d writesample_p50=%s writesample_p99=%s writesample_max=%s",
		len(frame), p50, p99, worst)
	if p99 > time.Second/30 {
		t.Errorf("WriteSample p99 %s exceeds one 30 fps frame interval", p99)
	}
}

// (d) What the SDK's H.264 file reader hands an encryptor: one bare NAL per sample, no start
// code (readersampleprovider.go:355-417), which decides whether task 7 needs its own
// access-unit builder.
func TestSpikeTheH264FileReaderHandsTheEncryptorBareNALs(t *testing.T) {
	srv, _ := spikeServer(t)
	alice := spikeJoin(t, srv, "sp15-h264-file", "alice", &lksdk.RoomCallback{})
	enc := &countingEncryptor{}
	track, err := lksdk.NewLocalFileTrack(spikeMedia+"bars.h264",
		lksdk.ReaderTrackWithSampleOptions(lksdk.WithFrameEncryptor(enc)))
	if err != nil {
		t.Fatalf("NewLocalFileTrack: %v", err)
	}
	if _, err := alice.LocalParticipant.PublishTrack(track, custom("camera", livekit.TrackSource_CAMERA)); err != nil {
		t.Fatalf("PublishTrack: %v", err)
	}
	time.Sleep(3 * time.Second)
	_, _, frames := enc.snapshot()
	if len(frames) == 0 {
		t.Fatal("the H.264 file track never called EncryptFrame")
	}
	withStartCode := 0
	var types []byte
	for _, f := range frames {
		if bytes.HasPrefix(f, []byte{0, 0, 1}) || bytes.HasPrefix(f, []byte{0, 0, 0, 1}) {
			withStartCode++
		}
		if len(f) > 0 {
			types = append(types, f[0]&0x1f)
		}
	}
	t.Logf("SPIKE h264_file_samples=%d h264_file_samples_with_start_code=%d h264_file_first_nal_types=%v",
		len(frames), withStartCode, types)
}

// (e) The spike's own build graph, tests included, holds no cgo media package.
func TestSpikeTheSpikeBuildPullsNoCgoMediaPackage(t *testing.T) {
	goTool, err := exec.LookPath("go")
	if err != nil {
		root := os.Getenv("GOROOT")
		if root == "" {
			t.Fatalf("cannot locate the go tool: %v", err)
		}
		goTool = filepath.Join(root, "bin", "go")
	}
	cmd := exec.CommandContext(t.Context(), goTool, "list", "-deps", "-test", "-tags", "spike", "./internal/sfu/")
	cmd.Dir = "../.."
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	bad := 0
	for _, line := range strings.Split(string(out), "\n") {
		path, _, _ := strings.Cut(strings.TrimSpace(line), " ")
		for _, forbidden := range []string{
			"github.com/livekit/media-sdk",
			"gopkg.in/hraban/opus.v2",
			"github.com/livekit/server-sdk-go/v2/pkg/media",
		} {
			if path == forbidden || strings.HasPrefix(path, forbidden+"/") {
				bad++
				t.Errorf("%s is in the spike's import graph", path)
			}
		}
	}
	t.Logf("SPIKE cgo_media_packages_in_spike_graph=%d", bad)
}
