package youtube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const (
	DefaultMaxPCMBytes = 512 << 20
	maxProcessStderr   = 64 << 10
	maxPCMTimeout      = 4 * time.Hour
)

var (
	ErrPCMLimit       = errors.New("youtube: decoded PCM exceeds limit")
	ErrPCMStart       = errors.New("youtube: audio process failed")
	ErrPCMTooLarge    = ErrPCMLimit
	ErrPCMReaderInput = errors.New("youtube: invalid bounded PCM reader input")
)

// BoundedPCMReader limits bytes read from a streaming decoder and closes the
// source when its context is canceled. Reads must be made by one goroutine.
type BoundedPCMReader struct {
	ctx       context.Context
	source    io.ReadCloser
	limit     int64
	read      int64
	closeOnce sync.Once
	done      chan struct{}
	closeErr  error
}

// NewBoundedPCMReader wraps a decoder's PCM stream. It returns ErrPCMTooLarge
// only if the source has bytes beyond maxBytes.
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
	r.closeOnce.Do(func() { close(r.done); r.closeErr = r.source.Close() })
	return r.closeErr
}

// PCMStarter streams one validated YouTube video's decoded audio as 44.1 kHz,
// stereo signed 16-bit little-endian PCM. It requires trusted, configured
// executable paths for yt-dlp and ffmpeg.
//
// This implementation does not provide an OS-level network sandbox. The
// yt-dlp invocation is constrained to a canonical YouTube video URL, but the
// host must enforce outbound network policy if egress isolation is required.
type PCMStarter struct {
	YTDLP       string
	FFmpeg      string
	Timeout     time.Duration
	MaxPCMBytes int64
}

func (s PCMStarter) Start(ctx context.Context, source string) (io.ReadCloser, error) {
	if ctx == nil || s.YTDLP == "" || s.FFmpeg == "" {
		return nil, ErrPCMStart
	}
	kind, canonical, err := NormalizeInput(source)
	if err != nil || kind != "video" || canonical != source {
		return nil, ErrInvalidInput
	}
	timeout := s.Timeout
	if timeout <= 0 || timeout > maxPCMTimeout {
		timeout = maxPCMTimeout
	}
	limit := s.MaxPCMBytes
	if limit <= 0 || limit > DefaultMaxPCMBytes {
		limit = DefaultMaxPCMBytes
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	ytArgs := []string{
		"--ignore-config", "--no-plugin-dirs", "--no-remote-components", "--no-playlist",
		"--no-warnings", "--no-progress", "--color", "never", "--socket-timeout", "10",
		"--extractor-retries", "1", "--format", "bestaudio", "--output", "-", "--", canonical,
	}
	yt := process(ctx, s.YTDLP, ytArgs)
	ytout, err := yt.StdoutPipe()
	if err != nil {
		cancel()
		return nil, ErrPCMStart
	}
	ytErr := &limitedBuffer{limit: maxProcessStderr}
	yt.Stderr = ytErr
	ffmpegArgs := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0",
		"-f", "s16le", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "pipe:1",
	}
	ff := process(ctx, s.FFmpeg, ffmpegArgs)
	ff.Stdin = ytout
	ffout, ffoutWriter, err := os.Pipe()
	if err != nil {
		cancel()
		return nil, ErrPCMStart
	}
	ff.Stdout = ffoutWriter
	ffErr := &limitedBuffer{limit: maxProcessStderr}
	ff.Stderr = ffErr

	if err := yt.Start(); err != nil {
		cancel()
		return nil, ErrPCMStart
	}
	if err := ff.Start(); err != nil {
		_ = ffout.Close()
		_ = ffoutWriter.Close()
		_ = ytout.Close()
		_ = yt.Cancel()
		_ = yt.Wait()
		cancel()
		return nil, ErrPCMStart
	}
	_ = ffoutWriter.Close()
	stream := &pcmStream{reader: ffout, cancel: cancel, done: make(chan struct{})}
	go func() {
		ffWait := ff.Wait()
		ytWait := yt.Wait()
		if ffErr.exceeded || ytErr.exceeded {
			stream.setErr(ErrMetadataTooLarge)
		} else if ctx.Err() != nil {
			stream.setErr(ctx.Err())
		} else if ffWait != nil || ytWait != nil {
			stream.setErr(fmt.Errorf("%w: yt-dlp=%v ffmpeg=%v", ErrPCMStart, ytWait, ffWait))
		}
		close(stream.done)
	}()
	return &boundedPCM{pcmStream: stream, remaining: limit}, nil
}

func process(ctx context.Context, executable string, args []string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, executable, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

type pcmStream struct {
	reader io.ReadCloser
	cancel context.CancelFunc
	done   chan struct{}
	once   sync.Once
	mu     sync.Mutex
	err    error
}

func (s *pcmStream) setErr(err error) {
	s.mu.Lock()
	if s.err == nil {
		s.err = err
	}
	s.mu.Unlock()
}
func (s *pcmStream) waitErr() error {
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}
func (s *pcmStream) close() error {
	s.once.Do(func() {
		s.cancel()
		_ = s.reader.Close()
	})
	<-s.done
	return s.waitErr()
}

type boundedPCM struct {
	*pcmStream
	remaining int64
	finished  bool
}

func (r *boundedPCM) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if r.finished {
		if err := r.waitErr(); err != nil {
			return 0, err
		}
		return 0, io.EOF
	}
	if r.remaining == 0 {
		var probe [1]byte
		n, err := r.reader.Read(probe[:])
		if n > 0 {
			r.finished = true
			r.setErr(ErrPCMLimit)
			r.cancel()
			return 0, ErrPCMLimit
		}
		if err != nil {
			r.finished = true
			if errors.Is(err, io.EOF) {
				if waitErr := r.waitErr(); waitErr != nil {
					return 0, waitErr
				}
			}
			return 0, err
		}
		return 0, nil
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	if errors.Is(err, io.EOF) {
		r.finished = true
		if waitErr := r.waitErr(); waitErr != nil {
			return n, waitErr
		}
	}
	return n, err
}

func (r *boundedPCM) Close() error { return r.pcmStream.close() }
