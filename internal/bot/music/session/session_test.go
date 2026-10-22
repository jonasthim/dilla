package session

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/bot/music/livekit"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type leaseStub struct{ released atomic.Int32 }

func (l *leaseStub) Release() error { l.released.Add(1); return nil }

type pcmStub struct{ closed atomic.Int32 }

func (p *pcmStub) Read([]byte) (int, error) { return 0, io.EOF }
func (p *pcmStub) Close() error             { p.closed.Add(1); return nil }

type pcmStart struct {
	lease *leaseStub
	calls atomic.Int32
	fail  bool
}

type plainPCMStart struct{ source *pcmStub }

func (p plainPCMStart) Start(context.Context, string) (io.ReadCloser, error) { return p.source, nil }

func (p *pcmStart) Start(context.Context, string) (io.ReadCloser, error) {
	p.calls.Add(1)
	if p.lease.released.Load() != 0 {
		panic("lease already released")
	}
	if p.fail {
		return nil, errors.New("pcm")
	}
	return &pcmStub{}, nil
}

type encoderStub struct {
	done   chan struct{}
	closed atomic.Int32
}

func (e *encoderStub) Done() <-chan struct{} { return e.done }
func (e *encoderStub) Wait() error           { return nil }
func (e *encoderStub) Close() error          { e.closed.Add(1); return nil }

type encStart struct {
	enc  *encoderStub
	fail bool
}

func (e encStart) Start(context.Context, io.ReadCloser) (Encoder, error) {
	if e.fail {
		return nil, errors.New("encoder")
	}
	return e.enc, nil
}

type pubStub struct {
	done   chan struct{}
	closed atomic.Int32
}

func (p *pubStub) Done() <-chan struct{} { return p.done }
func (p *pubStub) Wait() error           { return nil }
func (p *pubStub) Close() error          { p.closed.Add(1); return nil }

type pubStart struct {
	pub  *pubStub
	fail bool
}

func (p pubStart) Start(context.Context, client.Call, id.ID, livekit.EpochSource, Encoder) (Publisher, error) {
	if p.fail {
		return nil, errors.New("publisher")
	}
	return p.pub, nil
}

type epochStub struct{}

func (epochStub) CallMediaEpoch(context.Context, id.ID) (native.CallMediaEpoch, error) {
	return native.CallMediaEpoch{}, nil
}

func options(pcm *pcmStart, enc *encoderStub, pub *pubStub, lease *leaseStub) Options {
	return Options{Community: id.New(), Channel: id.New(), Track: "spotify:track:123", Call: client.Call{CallID: id.New(), GroupID: id.New()}, Group: id.New(), Acquire: func(id.ID, id.ID) (Lease, error) { return lease, nil }, PCM: pcm, Encoder: encStart{enc: enc}, Publisher: pubStart{pub: pub}, Epochs: epochStub{}}
}

func TestStartAcquiresLeaseBeforeAudioAndReleasesAfterCompletion(t *testing.T) {
	lease := &leaseStub{}
	pcm := &pcmStart{lease: lease}
	enc := &encoderStub{done: make(chan struct{})}
	pub := &pubStub{done: make(chan struct{})}
	o := options(pcm, enc, pub, lease)
	o.Call.GroupID = o.Group
	s, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if pcm.calls.Load() != 1 {
		t.Fatalf("PCM starts=%d", pcm.calls.Load())
	}
	if lease.released.Load() != 0 {
		t.Fatal("lease released before playback ended")
	}
	close(pub.done)
	if err := s.Wait(); err != nil {
		t.Fatal(err)
	}
	if lease.released.Load() != 1 || enc.closed.Load() != 1 || pub.closed.Load() != 1 {
		t.Fatalf("cleanup lease=%d encoder=%d publisher=%d", lease.released.Load(), enc.closed.Load(), pub.closed.Load())
	}
}

func TestStartFailuresReleaseLeaseAndPartialResources(t *testing.T) {
	t.Run("lease", func(t *testing.T) {
		lease := &leaseStub{}
		p := &pcmStart{lease: lease}
		e := &encoderStub{done: make(chan struct{})}
		pub := &pubStub{done: make(chan struct{})}
		o := options(p, e, pub, lease)
		o.Call.GroupID = o.Group
		o.Acquire = func(id.ID, id.ID) (Lease, error) { return nil, errors.New("busy") }
		if _, err := Start(context.Background(), o); err == nil {
			t.Fatal("expected error")
		}
		if p.calls.Load() != 0 {
			t.Fatal("audio started without lease")
		}
	})
	t.Run("PCM", func(t *testing.T) {
		lease := &leaseStub{}
		p := &pcmStart{lease: lease, fail: true}
		e := &encoderStub{done: make(chan struct{})}
		pub := &pubStub{done: make(chan struct{})}
		o := options(p, e, pub, lease)
		o.Call.GroupID = o.Group
		if _, err := Start(context.Background(), o); err == nil {
			t.Fatal("expected error")
		}
		if lease.released.Load() != 1 || p.calls.Load() != 1 {
			t.Fatal("lease/PCM cleanup mismatch")
		}
	})
	t.Run("publisher", func(t *testing.T) {
		lease := &leaseStub{}
		p := &pcmStart{lease: lease}
		e := &encoderStub{done: make(chan struct{})}
		o := options(p, e, &pubStub{done: make(chan struct{})}, lease)
		o.Call.GroupID = o.Group
		o.Publisher = pubStart{fail: true}
		if _, err := Start(context.Background(), o); err == nil {
			t.Fatal("expected error")
		}
		if lease.released.Load() != 1 || e.closed.Load() != 1 {
			t.Fatal("partial resources not closed")
		}
	})
}

func TestConcurrentCloseReleasesLeaseOnce(t *testing.T) {
	lease := &leaseStub{}
	p := &pcmStart{lease: lease}
	e := &encoderStub{done: make(chan struct{})}
	pub := &pubStub{done: make(chan struct{})}
	o := options(p, e, pub, lease)
	o.Call.GroupID = o.Group
	s, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = s.Close() }()
	}
	wg.Wait()
	if lease.released.Load() != 1 {
		t.Fatalf("lease releases=%d", lease.released.Load())
	}
}

func TestYouTubeSessionDoesNotAcquireInstallationSpotifyLease(t *testing.T) {
	lease := &leaseStub{}
	enc := &encoderStub{done: make(chan struct{})}
	pub := &pubStub{done: make(chan struct{})}
	o := options(&pcmStart{lease: lease}, enc, pub, lease)
	o.Provider = "youtube"
	o.Acquire = nil
	o.PCM = plainPCMStart{source: &pcmStub{}}
	o.Call.GroupID = o.Group
	s, err := Start(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if lease.released.Load() != 0 {
		t.Fatal("YouTube session touched Spotify lease")
	}
	_ = s.Close()
}

func TestQueueStarterRejectsProviderMismatchBeforePlayback(t *testing.T) {
	called := false
	lease := &leaseStub{}
	enc := &encoderStub{done: make(chan struct{})}
	pub := &pubStub{done: make(chan struct{})}
	starter := QueueStarter{OptionsFor: func(context.Context, music.Track) (Options, error) {
		called = true
		o := options(&pcmStart{lease: lease}, enc, pub, lease)
		o.Provider = music.ProviderYouTube
		o.Acquire = nil
		o.PCM = plainPCMStart{source: &pcmStub{}}
		o.Call.GroupID = o.Group
		return o, nil
	}}
	playback, err := starter.Start(context.Background(), music.Track{Provider: music.ProviderSpotify, CanonicalID: "track"})
	if playback != nil {
		_ = playback.Close()
	}
	if !called || !errors.Is(err, ErrInvalid) {
		t.Fatalf("mismatched provider was accepted: called=%v err=%v", called, err)
	}
}
