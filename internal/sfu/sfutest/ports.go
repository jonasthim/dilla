// Package sfutest is test support for packages that boot an in-process LiveKit.
//
// `go test ./...` runs package test binaries in parallel, so two packages that each pick fixed
// LiveKit ports collide. Every package outside internal/sfu takes both ports from FreePorts: it
// binds port 0, so the kernel answers from its ephemeral range (32768–60999 on Linux), which never
// overlaps the fixed ports internal/sfu's own tests use (7880–7999, one test binary, run serially).
package sfutest

import (
	"net"
	"testing"
)

// FreePorts returns an unused TCP port and an unused UDP port on 127.0.0.1 for LiveKit's signalling
// and media listeners.
func FreePorts(tb testing.TB) (tcp, udp int) {
	tb.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(tb.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("listen tcp: %v", err)
	}
	ta, ok := ln.Addr().(*net.TCPAddr)
	_ = ln.Close()
	if !ok {
		tb.Fatalf("a tcp listener answered %T", ln.Addr())
	}
	pc, err := lc.ListenPacket(tb.Context(), "udp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("listen udp: %v", err)
	}
	ua, ok := pc.LocalAddr().(*net.UDPAddr)
	_ = pc.Close()
	if !ok {
		tb.Fatalf("a udp packet conn answered %T", pc.LocalAddr())
	}
	return ta.Port, ua.Port
}
