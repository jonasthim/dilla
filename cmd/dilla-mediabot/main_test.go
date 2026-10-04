package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/sframe"
	"github.com/jonasthim/dilla/internal/sfu"
	"github.com/jonasthim/dilla/internal/sfu/sfutest"
)

const (
	keyHex = "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"
	devA   = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
	devB   = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
)

func TestFlagsParseAWellFormedCommandLine(t *testing.T) {
	c, err := parseFlags([]string{
		"-url", "ws://127.0.0.1:7880", "-token", "jwt", "-base-key", keyHex, "-leaf", "1", "-epoch", "7",
		"-roster", "0:" + devA + ",1:" + devB, "-publish", "opus,vp8,h264", "-subscribe", "-expect-device", devA,
		"-duration", "3s", "-media", "/m",
	}, &bytes.Buffer{})
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	if c.Leaf != 1 || c.Epoch != 7 || c.MinEpoch != 7 || !c.Subscribe || c.Duration != 3*time.Second || c.MediaDir != "/m" {
		t.Fatalf("config = %+v", c)
	}
	if strings.Join(c.Publish, ",") != "opus,vp8,h264" {
		t.Fatalf("publish = %v", c.Publish)
	}
	if len(c.Roster) != 2 || c.Roster[1].Leaf != 1 || hex.EncodeToString(c.Roster[1].Device[:]) != devB {
		t.Fatalf("roster = %+v", c.Roster)
	}
	if hex.EncodeToString(c.ExpectDevice[:]) != devA || c.BaseKey[0] != 0x0a {
		t.Fatalf("expect/base key = %x / %x", c.ExpectDevice, c.BaseKey)
	}
}

func TestFlagsRefuseWhatTheBotCannotUse(t *testing.T) {
	base := []string{"-url", "ws://x", "-token", "t", "-base-key", keyHex, "-leaf", "0", "-epoch", "1", "-roster", "0:" + devA}
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"no url", []string{"-token", "t", "-base-key", keyHex, "-leaf", "0", "-roster", "0:" + devA}, "-url and -token are required"},
		{"short key", append(base[:4:4], "-base-key", "0a0a", "-leaf", "0", "-roster", "0:"+devA), "-base-key must be 32 lowercase hex"},
		{"leaf range", append(append([]string{}, base...), "-leaf", "65536"), "-leaf must be 0…65535"},
		{"bad roster", append(append([]string{}, base...), "-roster", "x:"+devA), `-roster entry "x:` + devA + `"`},
		{"unknown codec", append(append([]string{}, base...), "-publish", "av1"), `-publish: unknown "av1"`},
		{"subscribe without device", append(append([]string{}, base...), "-subscribe"), "-subscribe needs -expect-device"},
		{"min epoch above epoch", append(append([]string{}, base...), "-min-epoch", "2"), "-min-epoch must not exceed -epoch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseFlags(tc.args, &bytes.Buffer{})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("parseFlags(%v) = %v, want an error containing %q", tc.args, err, tc.want)
			}
		})
	}
}

// One bot publishes Opus, VP8 and H.264 through the real in-process LiveKit; the other decrypts
// them. The ports come from sfutest.FreePorts: every LiveKit-booting package test runs in its own
// process, concurrently with the others under `go test ./...`, and only internal/sfu uses fixed ports.
func TestTwoBotsDecryptEachOtherThroughTheSFU(t *testing.T) {
	if raceEnabled {
		t.Skip("upstream livekit-server data race in updateRidsFromSDP; runs in the non-race step")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cfg := sfu.DefaultConfig()
	cfg.Port, cfg.UDPPort = sfutest.FreePorts(t)
	cfg.APISecret = strings.Repeat("m", 32)
	srv, err := sfu.Start(ctx, cfg)
	if err != nil {
		t.Fatalf("sfu.Start: %v", err)
	}
	t.Cleanup(func() { _ = srv.Stop(context.Background()) })
	const room = "mediabot-loopback"
	if err := srv.CreateRoom(ctx, room); err != nil {
		t.Fatalf("CreateRoom: %v", err)
	}
	tokA, err := srv.Token(room, devA, sfu.PublishGrant(true, true, true), nil)
	if err != nil {
		t.Fatalf("Token A: %v", err)
	}
	tokB, err := srv.Token(room, devB, sfu.PublishGrant(true, true, true), nil)
	if err != nil {
		t.Fatalf("Token B: %v", err)
	}
	a, _ := deviceID(devA)
	b, _ := deviceID(devB)
	var key [16]byte
	for i := range key {
		key[i] = 0x0a
	}
	common := config{
		URL: srv.URL(), BaseKey: key, Epoch: 1, MinEpoch: 1,
		Roster:   []sframe.RosterEntry{{Leaf: 0, Device: a}, {Leaf: 1, Device: b}},
		MediaDir: filepath.Join("..", "..", "internal", "media", "testdata"),
	}
	sub := common
	sub.Token, sub.Leaf, sub.Subscribe, sub.ExpectDevice, sub.Duration = tokB, 1, true, a, 12*time.Second
	pub := common
	pub.Token, pub.Leaf, pub.Publish, pub.Duration = tokA, 0, []string{"opus", "vp8", "h264"}, 8*time.Second

	var wg sync.WaitGroup
	var subRep report
	var subErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		subRep, subErr = run(ctx, sub)
	}()
	time.Sleep(time.Second)
	pubRep, err := run(ctx, pub)
	if err != nil {
		t.Fatalf("publisher: %v", err)
	}
	wg.Wait()
	if subErr != nil {
		t.Fatalf("subscriber: %v", subErr)
	}
	for _, what := range []string{"opus", "vp8", "h264"} {
		if !strings.HasPrefix(pubRep.Published[what], "TR_") {
			t.Errorf("published[%s] = %q, want a track sid", what, pubRep.Published[what])
		}
	}
	if subRep.Decrypted == 0 {
		t.Fatalf("the subscriber decrypted nothing: %+v", subRep)
	}
	for code, n := range subRep.Dropped {
		if code != "sif" && n > 0 {
			t.Errorf("dropped[%s] = %d; only SFU-injected SIF frames may be dropped", code, n)
		}
	}
}
