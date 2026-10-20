package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/exit"
	"github.com/jonasthim/dilla/internal/sfu"
)

type delayedRooms struct{ calls int }

func (d *delayedRooms) Participants(context.Context, string) ([]*livekit.ParticipantInfo, error) {
	return nil, nil
}

func (d *delayedRooms) Rooms(context.Context) ([]string, error) {
	d.calls++
	if d.calls < 3 {
		return nil, errors.New("not listening yet")
	}
	return nil, nil
}

func TestWaitRemoteSFURetriesUntilRoomServiceIsReady(t *testing.T) {
	remote := &delayedRooms{}
	if err := waitRemoteSFU(t.Context(), remote, time.Second); err != nil {
		t.Fatal(err)
	}
	if remote.calls != 3 {
		t.Fatalf("probes = %d, want 3", remote.calls)
	}
}

func TestMediaRunsSeparatelyAndTheAPIControlsItsRooms(t *testing.T) {
	fd := sfuDeps(t, func(lk *config.LiveKit) { lk.Mode = "sidecar" })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveMedia(ctx, fd.cfg, &bytes.Buffer{}, &bytes.Buffer{}) }()
	addr := net.JoinHostPort(fd.cfg.LiveKit.BindAddress, strconv.Itoa(fd.cfg.LiveKit.Port))
	deadline := time.Now().Add(10 * time.Second)
	for {
		conn, err := (&net.Dialer{Timeout: 100 * time.Millisecond}).DialContext(ctx, "tcp", addr)
		if err == nil {
			_ = conn.Close()
			break
		}
		select {
		case err := <-done:
			t.Fatalf("media exited before it was ready: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("media did not open %s: %v", addr, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	secret, err := os.ReadFile(fd.cfg.LiveKit.APISecretFile)
	if err != nil {
		t.Fatal(err)
	}
	remote := sfu.NewRemote(sfuConfig(fd.cfg.LiveKit, string(secret)))
	if err := waitRemoteSFU(t.Context(), remote, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := remote.CreateRoom(t.Context(), "sidecar-test"); err != nil {
		t.Fatal(err)
	}
	rooms, err := remote.Rooms(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(rooms) != 1 || rooms[0] != "sidecar-test" {
		t.Fatalf("remote rooms = %v", rooms)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("media shutdown: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatal("media did not stop")
	}
}

type fakeLister struct {
	rooms        map[string][]string
	roomsErr     error
	participants error
}

func (f fakeLister) Rooms(context.Context) ([]string, error) {
	if f.roomsErr != nil {
		return nil, f.roomsErr
	}
	out := make([]string, 0, len(f.rooms))
	for r := range f.rooms {
		out = append(out, r)
	}
	return out, nil
}

func (f fakeLister) Participants(_ context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	if f.participants != nil {
		return nil, f.participants
	}
	var out []*livekit.ParticipantInfo
	for _, id := range f.rooms[room] {
		out = append(out, &livekit.ParticipantInfo{Identity: id})
	}
	return out, nil
}

func TestMediaRoomsListsRoomsAndParticipantsSorted(t *testing.T) {
	var out bytes.Buffer
	remote := fakeLister{rooms: map[string][]string{"room-b": nil, "room-a": {"zed", "amy"}}}
	if err := mediaRooms(t.Context(), remote, &out, time.Second); err != nil {
		t.Fatal(err)
	}
	want := "room-a\t2 participants\n  amy\n  zed\nroom-b\t0 participants\n"
	if out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
}

func TestMediaRoomsEmptySFU(t *testing.T) {
	var out bytes.Buffer
	if err := mediaRooms(t.Context(), fakeLister{}, &out, time.Second); err != nil {
		t.Fatal(err)
	}
	if out.String() != "no live rooms\n" {
		t.Fatalf("output = %q", out.String())
	}
}

func TestMediaRoomsUnavailableWhenTheSidecarDoesNotAnswer(t *testing.T) {
	remote := fakeLister{roomsErr: errors.New("down")}
	err := mediaRooms(t.Context(), remote, &bytes.Buffer{}, 300*time.Millisecond)
	if !errors.Is(err, exit.Unavailable) {
		t.Fatalf("err = %v, want exit.Unavailable", err)
	}
}

func TestMediaProbeAndRoomsAreExclusive(t *testing.T) {
	var stderr bytes.Buffer
	err := runMedia([]string{"--probe", "--rooms"}, &bytes.Buffer{}, &stderr)
	if !errors.Is(err, exit.Usage) {
		t.Fatalf("err = %v, want exit.Usage", err)
	}
	if !strings.Contains(stderr.String(), "media: --probe and --rooms are exclusive") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestMediaProbeNamesTheRoomCount(t *testing.T) {
	var out bytes.Buffer
	remote := fakeLister{rooms: map[string][]string{"a": nil, "b": nil}}
	if err := mediaProbe(t.Context(), remote, &out, time.Second); err != nil {
		t.Fatal(err)
	}
	if out.String() != "media probe: ok, 2 live rooms\n" {
		t.Fatalf("output = %q", out.String())
	}
}
