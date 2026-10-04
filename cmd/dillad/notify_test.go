package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// dillad implements sd_notify by hand — one datagram, no dependency. Type=notify
// in the unit means systemd waits for it, so a silent failure here is a service
// that never reaches "active".
func TestNotifyReadySendsExactlyOneDatagram(t *testing.T) {
	// Unix sun_path is limited to 107 bytes on Linux. t.TempDir includes the
	// test name, which exceeds that bound under the worktree's required TMPDIR.
	dir, err := os.MkdirTemp("", "n-") //nolint:usetesting // t.TempDir exceeds Linux sun_path under the required TMPDIR.
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "n.sock")
	ln, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: sock, Net: "unixgram"})
	if err != nil {
		t.Fatalf("ListenUnixgram: %v", err)
	}
	defer ln.Close()
	t.Setenv("NOTIFY_SOCKET", sock)

	notifyReady()
	if err := ln.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	buf := make([]byte, 64)
	n, err := ln.Read(buf)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if got := string(buf[:n]); got != "READY=1" {
		t.Fatalf("datagram = %q, want READY=1", got)
	}
	// Exactly one: a second read must time out.
	_ = ln.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	if _, err := ln.Read(buf); err == nil {
		t.Fatal("notifyReady sent more than one datagram")
	}
}

func TestNotifyReadyIsANoOpWithoutTheEnvironment(t *testing.T) {
	t.Setenv("NOTIFY_SOCKET", "")
	// Nothing to assert beyond "does not panic or block": notifyReady has no
	// return value, because an absent or unreachable socket is never an error.
	done := make(chan struct{})
	go func() { defer close(done); notifyReady() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("notifyReady blocked with no NOTIFY_SOCKET; it must be a silent no-op")
	}
}
