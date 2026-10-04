// Command dilla-mediabot is the Go peer of the browser E2EE suite (task 21): it joins a LiveKit room
// as one call-group leaf, publishes the committed test media encrypted with dilla-sframe/1 through
// internal/media, decrypts what one expected device publishes, and prints one JSON report. It is a
// test tool: the release job builds cmd/dillad only, and TestDilladDoesNotImportTheMediaPackages keeps
// internal/media and internal/sframe out of dillad's graph.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"

	"github.com/jonasthim/dilla/internal/media"
	"github.com/jonasthim/dilla/internal/sframe"
)

type config struct {
	URL, Token   string
	BaseKey      [16]byte
	Leaf         uint16
	Epoch        uint64
	MinEpoch     uint64
	Roster       []sframe.RosterEntry
	Publish      []string
	Subscribe    bool
	ExpectDevice [16]byte
	Duration     time.Duration
	MediaDir     string
}

type report struct {
	Published map[string]string `json:"published"`
	Decrypted uint64            `json:"decrypted"`
	Dropped   map[string]uint64 `json:"dropped"`
}

func deviceID(s string) ([16]byte, error) {
	var d [16]byte
	if len(s) != 32 || strings.ToLower(s) != s {
		return d, fmt.Errorf("%q is not 32 lowercase hex", s)
	}
	if _, err := hex.Decode(d[:], []byte(s)); err != nil {
		return d, fmt.Errorf("%q: %w", s, err)
	}
	return d, nil
}

func parseFlags(args []string, stderr io.Writer) (config, error) {
	fs := flag.NewFlagSet("dilla-mediabot", flag.ContinueOnError)
	fs.SetOutput(stderr)
	url := fs.String("url", "", "LiveKit signalling URL (the calls route's livekit_url)")
	token := fs.String("token", "", "the room token")
	baseKey := fs.String("base-key", "", "the call group's dilla-sframe/1 base key, 32 lowercase hex")
	leaf := fs.Int("leaf", -1, "this device's leaf index")
	epoch := fs.Uint64("epoch", 0, "the epoch -base-key belongs to")
	minEpoch := fs.Uint64("min-epoch", 0, "N1: encrypt only at or after this epoch (default: -epoch)")
	roster := fs.String("roster", "", "the epoch's roster as leaf:device_hex,…")
	publish := fs.String("publish", "", "comma list of opus, vp8, h264")
	subscribe := fs.Bool("subscribe", false, "decrypt what -expect-device publishes")
	expect := fs.String("expect-device", "", "the device whose tracks are decrypted, 32 lowercase hex")
	duration := fs.Duration("duration", 10*time.Second, "how long to stay in the room after publishing")
	mediaDir := fs.String("media", filepath.Join("internal", "media", "testdata"), "directory with tone.ogg, bars.ivf and bars.h264")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	c := config{URL: *url, Token: *token, Epoch: *epoch, MinEpoch: *minEpoch, Subscribe: *subscribe, Duration: *duration, MediaDir: *mediaDir}
	if c.URL == "" || c.Token == "" {
		return config{}, errors.New("-url and -token are required")
	}
	key, err := hex.DecodeString(*baseKey)
	if err != nil || len(key) != 16 || strings.ToLower(*baseKey) != *baseKey {
		return config{}, errors.New("-base-key must be 32 lowercase hex")
	}
	copy(c.BaseKey[:], key)
	if *leaf < 0 || *leaf > 65535 {
		return config{}, errors.New("-leaf must be 0…65535")
	}
	c.Leaf = uint16(*leaf)
	if c.MinEpoch == 0 {
		c.MinEpoch = c.Epoch
	}
	if c.MinEpoch > c.Epoch {
		return config{}, errors.New("-min-epoch must not exceed -epoch")
	}
	for _, entry := range strings.Split(*roster, ",") {
		if entry == "" {
			continue
		}
		l, d, ok := strings.Cut(entry, ":")
		n, nerr := strconv.ParseUint(l, 10, 16)
		dev, derr := deviceID(d)
		if !ok || nerr != nil || derr != nil {
			return config{}, fmt.Errorf("-roster entry %q is not leaf:device_hex", entry)
		}
		c.Roster = append(c.Roster, sframe.RosterEntry{Leaf: uint16(n), Device: dev})
	}
	if len(c.Roster) == 0 {
		return config{}, errors.New("-roster is required")
	}
	for _, p := range strings.Split(*publish, ",") {
		switch p {
		case "":
		case "opus", "vp8", "h264":
			c.Publish = append(c.Publish, p)
		default:
			return config{}, fmt.Errorf("-publish: unknown %q (opus, vp8, h264)", p)
		}
	}
	if c.Subscribe {
		if *expect == "" {
			return config{}, errors.New("-subscribe needs -expect-device")
		}
		if c.ExpectDevice, err = deviceID(*expect); err != nil {
			return config{}, fmt.Errorf("-expect-device: %w", err)
		}
	}
	return c, nil
}

func codecOf(mime string) (sframe.Codec, bool) {
	switch strings.ToLower(mime) {
	case strings.ToLower(webrtc.MimeTypeOpus):
		return sframe.Opus, true
	case strings.ToLower(webrtc.MimeTypeVP8):
		return sframe.VP8, true
	case strings.ToLower(webrtc.MimeTypeVP9):
		return sframe.VP9, true
	case strings.ToLower(webrtc.MimeTypeH264):
		return sframe.H264, true
	}
	return 0, false
}

func slotOf(s livekit.TrackSource) (sframe.Slot, bool) {
	switch s {
	case livekit.TrackSource_MICROPHONE:
		return sframe.Mic, true
	case livekit.TrackSource_CAMERA:
		return sframe.Camera, true
	case livekit.TrackSource_SCREEN_SHARE:
		return sframe.ScreenVideo, true
	case livekit.TrackSource_SCREEN_SHARE_AUDIO:
		return sframe.ScreenAudio, true
	}
	return 0, false
}

// publishRetrying retries a video publication for up to 20 s: camera and screen need the call's
// publisher lease (task 10), which the test takes for this device after it has connected.
func publishRetrying(ctx context.Context, publish func() (*lksdk.LocalTrackPublication, error)) (*lksdk.LocalTrackPublication, error) {
	var last error
	for range 40 {
		p, err := publish()
		if err == nil {
			return p, nil
		}
		last = err
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return nil, last
}

// The /calls token contains only the base grant. The browser driver POSTs /share after the bot
// appears in the room; wait for dillad's permission push before attempting a video publication.
func waitPublishSource(ctx context.Context, room *lksdk.Room, source livekit.TrackSource) error {
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		perm := room.LocalParticipant.Permissions()
		for _, allowed := range perm.GetCanPublishSources() {
			if allowed == source {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("no permission to publish %s after 15s", source)
		case <-tick.C:
		}
	}
}

func run(ctx context.Context, c config) (report, error) {
	sender, err := sframe.NewSender(c.BaseKey, c.Leaf, c.Epoch, c.MinEpoch)
	if err != nil {
		return report{}, fmt.Errorf("sender: %w", err)
	}
	ring := sframe.NewKeyRing(time.Now)
	ring.InstallEpoch(c.Epoch, c.BaseKey, c.Roster, int(c.Leaf))
	counters := &media.Counters{}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var mu sync.Mutex
	var room *lksdk.Room
	ready := make(chan struct{})
	cb := &lksdk.RoomCallback{ParticipantCallback: lksdk.ParticipantCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, rp *lksdk.RemoteParticipant) {
			if !c.Subscribe {
				return
			}
			dev, err := deviceID(rp.Identity())
			if err != nil || dev != c.ExpectDevice {
				return
			}
			codec, ok := codecOf(track.Codec().MimeType)
			slot, ok2 := slotOf(pub.Source())
			if !ok || !ok2 {
				return
			}
			go func() {
				// The SIF trailer is the room's, known once the join completed.
				select {
				case <-ready:
				case <-ctx.Done():
					return
				}
				mu.Lock()
				sif := room.SifTrailer()
				mu.Unlock()
				_ = media.DecryptLoop(ctx, track, media.NewFrameDecryptor(ring, codec, dev, slot, sif, counters))
			}()
		},
	}}
	r, err := lksdk.ConnectToRoomWithToken(c.URL, c.Token, cb, lksdk.WithAutoSubscribe(c.Subscribe))
	if err != nil {
		return report{}, fmt.Errorf("connect: %w", err)
	}
	mu.Lock()
	room = r
	mu.Unlock()
	close(ready)
	defer r.Disconnect()

	published := map[string]string{}
	for _, what := range c.Publish {
		var p *lksdk.LocalTrackPublication
		switch what {
		case "opus":
			p, err = media.PublishOpusOgg(r, filepath.Join(c.MediaDir, "tone.ogg"),
				media.NewFrameEncryptor(sender, sframe.Opus, sframe.Mic, 0))
		case "vp8":
			if err = waitPublishSource(ctx, r, livekit.TrackSource_CAMERA); err != nil {
				return report{}, err
			}
			p, err = publishRetrying(ctx, func() (*lksdk.LocalTrackPublication, error) {
				return media.PublishVP8IVF(r, filepath.Join(c.MediaDir, "bars.ivf"),
					media.NewFrameEncryptor(sender, sframe.VP8, sframe.Camera, 0), livekit.TrackSource_CAMERA)
			})
		case "h264":
			if err = waitPublishSource(ctx, r, livekit.TrackSource_SCREEN_SHARE); err != nil {
				return report{}, err
			}
			p, err = publishRetrying(ctx, func() (*lksdk.LocalTrackPublication, error) {
				return media.PublishH264(r, filepath.Join(c.MediaDir, "bars.h264"),
					media.NewFrameEncryptor(sender, sframe.H264, sframe.ScreenVideo, 0), livekit.TrackSource_SCREEN_SHARE)
			})
		}
		if err != nil {
			return report{}, fmt.Errorf("publish %s: %w", what, err)
		}
		published[what] = p.SID()
	}

	select {
	case <-ctx.Done():
	case <-time.After(c.Duration):
	}
	decrypted, dropped := counters.Snapshot()
	return report{Published: published, Decrypted: decrypted, Dropped: dropped}, nil
}

func main() {
	c, err := parseFlags(os.Args[1:], os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(0)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dilla-mediabot:", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	rep, err := run(ctx, c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "dilla-mediabot:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(rep); err != nil {
		fmt.Fprintln(os.Stderr, "dilla-mediabot:", err)
		os.Exit(1)
	}
}
