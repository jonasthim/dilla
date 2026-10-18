package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/sfu"
)

type delayedRooms struct{ calls int }

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
