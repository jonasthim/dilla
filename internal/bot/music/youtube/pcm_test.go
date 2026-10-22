package youtube

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func TestBoundedPCMReaderStopsAtByteLimit(t *testing.T) {
	r, err := NewBoundedPCMReader(context.Background(), io.NopCloser(strings.NewReader("abcdef")), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	got, err := io.ReadAll(r)
	if !errors.Is(err, ErrPCMTooLarge) {
		t.Fatalf("ReadAll error = %v, want ErrPCMTooLarge", err)
	}
	if string(got) != "abcd" {
		t.Fatalf("ReadAll = %q, want exactly the bounded PCM prefix", got)
	}
}

func TestBoundedPCMReaderAllowsEOFAtLimit(t *testing.T) {
	r, err := NewBoundedPCMReader(context.Background(), io.NopCloser(strings.NewReader("abcd")), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()

	got, err := io.ReadAll(r)
	if err != nil || string(got) != "abcd" {
		t.Fatalf("ReadAll = %q, %v; want exact-boundary EOF", got, err)
	}
}

func TestBoundedPCMReaderCancellationClosesBlockedSource(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	source := &blockingPCMSource{closed: make(chan struct{})}
	r, err := NewBoundedPCMReader(ctx, source, 1024)
	if err != nil {
		t.Fatal(err)
	}

	readDone := make(chan error, 1)
	go func() {
		_, readErr := r.Read(make([]byte, 8))
		readDone <- readErr
	}()
	cancel()

	select {
	case err := <-readDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Read error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Read remained blocked after context cancellation")
	}
	select {
	case <-source.closed:
	case <-time.After(time.Second):
		t.Fatal("source was not closed after context cancellation")
	}
	_ = r.Close()
}

type blockingPCMSource struct{ closed chan struct{} }

func (s *blockingPCMSource) Read([]byte) (int, error) {
	<-s.closed
	return 0, errors.New("source closed")
}

func (s *blockingPCMSource) Close() error {
	select {
	case <-s.closed:
	default:
		close(s.closed)
	}
	return nil
}
