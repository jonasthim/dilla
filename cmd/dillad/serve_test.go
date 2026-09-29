package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/config"
)

// syncBuffer is an io.Writer the serving goroutine writes to while the test
// goroutine reads it. A bare bytes.Buffer would be a data race under -race.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// bootstrapServeConfig runs `dillad init` into a temporary directory and
// rewrites server.listen so the kernel picks the port; runServe then prints the
// chosen address, which is the only place to read it from.
func bootstrapServeConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if _, _, err := run(t, "init", "--agree-tos", "--data-dir="+dir,
		"--domain=chat.example", "--public-ip=203.0.113.7"); err != nil {
		t.Fatalf("init: %v", err)
	}
	cfgPath := filepath.Join(dir, "dilla.toml")
	c, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	c.Server.Listen = "127.0.0.1:0"
	f, err := os.OpenFile(cfgPath, os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatalf("reopen dilla.toml: %v", err)
	}
	if err := c.WriteConfig(f); err != nil {
		f.Close()
		t.Fatalf("rewrite dilla.toml: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close dilla.toml: %v", err)
	}
	return cfgPath
}

// `dillad serve` must not return while the graceful drain is still running.
// http.Server.Shutdown closes the LISTENER first, which makes the inner
// Serve(ln) return ErrServerClosed at once; if the shutdown goroutine is never
// awaited, runServe returns while requests are still in flight, `defer
// repo.Close()` closes the database underneath them, and the process exits
// before the drain finishes — shutdown_grace is then effectively zero and the
// binary does not do the graceful shutdown it claims.
//
// The in-flight request is a POST whose headers are complete and whose body is
// not: server.DecodeBody is blocked in io.ReadAll, so net/http holds the
// connection in StateActive and Server.Shutdown will not call the server
// quiescent. Sending the body afterwards lets the handler answer, which is what
// a drain is for, and only then may serve return.
func TestServeDoesNotReturnUntilTheDrainFinishes(t *testing.T) {
	cfgPath := bootstrapServeConfig(t)

	var stdout, stderr syncBuffer
	served := make(chan error, 1)
	go func() { served <- dispatch([]string{"serve", "--config=" + cfgPath}, &stdout, &stderr) }()

	addr := waitForListenAddr(t, &stdout, served)

	// One complete request first. It answers only once runServe has reached
	// srv.Serve, which is after signal.NotifyContext registered the handlers —
	// signalling before that would terminate the whole test binary.
	if err := probe(addr); err != nil {
		t.Fatalf("probe /healthz: %v", err)
	}

	inflight, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer inflight.Close()
	if _, err := fmt.Fprintf(inflight,
		"POST /v1/accounts HTTP/1.1\r\nHost: %s\r\nContent-Type: application/cbor\r\nContent-Length: 1\r\n\r\n",
		addr); err != nil {
		t.Fatalf("write the request head: %v", err)
	}
	// Let the server accept the connection, read the head and enter the
	// handler, which then blocks on the body that has not been sent.
	time.Sleep(250 * time.Millisecond)

	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("SIGTERM: %v", err)
	}

	select {
	case err := <-served:
		t.Fatalf("serve returned (%v) while a request was still in flight: the drain was never awaited", err)
	case <-time.After(500 * time.Millisecond):
	}

	// Send the body. The handler can finish now, and only now.
	if _, err := inflight.Write([]byte{0xff}); err != nil {
		t.Fatalf("send the body: %v", err)
	}
	if err := inflight.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("SetReadDeadline: %v", err)
	}
	res, err := http.ReadResponse(bufio.NewReader(inflight), nil)
	if err != nil {
		t.Fatalf("the in-flight request was cut off instead of drained: %v", err)
	}
	io.Copy(io.Discard, res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("the drained POST /v1/accounts answered %d, want 400 for a one-byte body", res.StatusCode)
	}
	inflight.Close()

	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("serve never returned after the drain finished")
	}
}

// waitForListenAddr reads the address runServe prints when server.listen ends
// in :0.
func waitForListenAddr(t *testing.T, stdout *syncBuffer, served <-chan error) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-served:
			t.Fatalf("serve exited before it printed its address: %v", err)
		default:
		}
		if line, _, ok := strings.Cut(stdout.String(), "\n"); ok {
			return strings.TrimSpace(line)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("serve never printed its listen address")
	return ""
}

// probe runs one complete request to confirm the server is serving.
func probe(addr string) error {
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+addr+"/healthz", nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	io.Copy(io.Discard, res.Body)
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET /healthz = %d", res.StatusCode)
	}
	return nil
}
