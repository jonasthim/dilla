package youtube

import (
	"context"
	"errors"
	"io"
	"sync"
)

var (
	ErrPCMTooLarge    = errors.New("youtube: decoded PCM exceeds limit")
	ErrPCMReaderInput = errors.New("youtube: invalid bounded PCM reader input")
)

// BoundedPCMReader limits bytes read from a streaming decoder and closes the
// source when its context is canceled. Reads must be made by one goroutine.
type BoundedPCMReader struct {
	ctx    context.Context
	source io.ReadCloser
	limit  int64
	read   int64

	closeOnce sync.Once
	done      chan struct{}
	closeErr  error
}

// NewBoundedPCMReader wraps a decoder's PCM stream. The reader returns at most
// maxBytes; it returns ErrPCMTooLarge only if the source has additional bytes.
func NewBoundedPCMReader(ctx context.Context, source io.ReadCloser, maxBytes int64) (*BoundedPCMReader, error) {
	if ctx == nil || source == nil || maxBytes <= 0 {
		return nil, ErrPCMReaderInput
	}
	r := &BoundedPCMReader{ctx: ctx, source: source, limit: maxBytes, done: make(chan struct{})}
	go func() {
		select {
		case <-ctx.Done():
			_ = r.Close()
		case <-r.done:
		}
	}()
	return r, nil
}

func (r *BoundedPCMReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	remaining := r.limit - r.read
	if remaining == 0 {
		var extra [1]byte
		n, err := r.source.Read(extra[:])
		if n > 0 {
			return 0, ErrPCMTooLarge
		}
		if ctxErr := r.ctx.Err(); ctxErr != nil {
			return 0, ctxErr
		}
		return 0, err
	}
	if int64(len(p)) > remaining {
		p = p[:remaining]
	}
	n, err := r.source.Read(p)
	r.read += int64(n)
	if ctxErr := r.ctx.Err(); ctxErr != nil {
		return n, ctxErr
	}
	return n, err
}

func (r *BoundedPCMReader) Close() error {
	r.closeOnce.Do(func() {
		close(r.done)
		r.closeErr = r.source.Close()
	})
	return r.closeErr
}
