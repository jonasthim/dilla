package livekit

import (
	"context"
	"errors"
	"sync"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/music/counter"
	"github.com/jonasthim/dilla/internal/bot/music/runtime"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/media"
	"github.com/jonasthim/dilla/internal/sframe"
)

var (
	ErrPoolClosed = errors.New("music livekit: publisher pool is closed")
	ErrPoolDead   = errors.New("music livekit: publisher room ended; explicit reset required")
	ErrPoolBusy   = errors.New("music livekit: publisher track is already active")
)

type poolRoom interface{ Disconnect() }

type poolBackend interface {
	connect(context.Context, client.Call, func()) (poolRoom, error)
	publish(poolRoom, sourceLifecycle, *sframe.Sender) (func() error, error)
}

type liveKitPoolBackend struct{}

func (liveKitPoolBackend) connect(ctx context.Context, call client.Call, disconnected func()) (poolRoom, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	room, err := lksdk.ConnectToRoomWithToken(call.LiveKitURL, call.Token,
		&lksdk.RoomCallback{OnDisconnected: disconnected}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return nil, err
	}
	return room, nil
}

func (liveKitPoolBackend) publish(room poolRoom, source sourceLifecycle, sender *sframe.Sender) (func() error, error) {
	liveRoom, ok := room.(*lksdk.Room)
	runtimeSource, sourceOK := source.(*runtime.Session)
	if !ok || !sourceOK || runtimeSource == nil || sender == nil {
		return nil, ErrBinding
	}
	publication, err := media.PublishLiveOpus(liveRoom, runtimeSource.Provider(), sender)
	if err != nil {
		return nil, err
	}
	return func() error { return liveRoom.LocalParticipant.UnpublishTrack(publication.SID()) }, nil
}

type poolBinding struct {
	callID id.ID
	group  id.ID
	url    string
}

func bindingFor(call client.Call, group id.ID) poolBinding {
	return poolBinding{callID: call.CallID, group: group, url: call.LiveKitURL}
}

type poolConnection struct {
	room poolRoom
	once sync.Once
}

func (c *poolConnection) disconnect() {
	if c != nil && c.room != nil {
		c.once.Do(c.room.Disconnect)
	}
}

// Pool reuses one authorized room across consecutive track publications. Its
// lifetime begins when the room connection starts and is never extended by
// track restarts or idle time.
type Pool struct {
	mu       sync.Mutex
	lifetime time.Duration
	backend  poolBackend

	closed      bool
	dead        bool
	deadReason  error
	connecting  bool
	bound       *poolBinding
	roomCtx     context.Context
	roomCancel  context.CancelFunc
	connection  *poolConnection
	active      *Session
	connectDone chan struct{}
	startDone   chan struct{}
	closeDone   chan struct{}
	generation  uint64
}

// NewPool creates a publisher room pool whose absolute connection lifetime is
// bounded to at most 30 minutes.
func NewPool(lifetime time.Duration) (*Pool, error) {
	if lifetime <= 0 || lifetime > maxPublisherLifetime {
		return nil, ErrBinding
	}
	return &Pool{lifetime: lifetime, backend: liveKitPoolBackend{}, closeDone: make(chan struct{})}, nil
}

// Start publishes one encoder session into the retained room. A completed
// track leaves the room connected; only explicit Reset can replace a dead room.
func (p *Pool) Start(ctx context.Context, call client.Call, boundGroup id.ID, epochs EpochSource, source *runtime.Session) (*Session, error) {
	if source == nil {
		return nil, ErrBinding
	}
	return p.startSource(ctx, call, boundGroup, epochs, source)
}

func (p *Pool) startSource(ctx context.Context, call client.Call, boundGroup id.ID, epochs EpochSource, source sourceLifecycle) (*Session, error) {
	if ctx == nil || source == nil || epochs == nil || call.CallID.IsZero() || call.GroupID.IsZero() || boundGroup.IsZero() ||
		call.GroupID != boundGroup || call.LiveKitURL == "" || call.Token == "" {
		if source != nil {
			_ = source.Close()
		}
		return nil, ErrBinding
	}
	initial, err := epochs.CallMediaEpoch(ctx, boundGroup)
	if err != nil {
		_ = source.Close()
		return nil, errors.New("music livekit: call media key lookup failed")
	}
	if err := validateSenderEpoch(initial); err != nil {
		_ = source.Close()
		return nil, err
	}
	state, ok := epochs.(counter.State)
	if !ok {
		_ = source.Close()
		return nil, ErrBinding
	}
	sender, err := senderForReservedEpoch(ctx, state, boundGroup, initial)
	if err != nil {
		_ = source.Close()
		return nil, err
	}

	binding := bindingFor(call, boundGroup)
	roomCtx, conn, generation, err := p.acquireRoom(ctx, call, binding)
	if err != nil {
		_ = source.Close()
		return nil, err
	}
	if err := revalidateEpoch(roomCtx, boundGroup, epochs, initial); err != nil {
		_ = source.Close()
		p.markDead(generation, err)
		return nil, err
	}

	trackCtx, trackCancel := context.WithCancel(roomCtx)
	stopParent := context.AfterFunc(ctx, trackCancel)
	p.mu.Lock()
	if p.closed || p.dead || p.generation != generation || p.connection != conn {
		p.mu.Unlock()
		stopParent()
		trackCancel()
		_ = source.Close()
		return nil, p.currentError()
	}
	if p.active != nil || p.connecting {
		p.mu.Unlock()
		stopParent()
		trackCancel()
		_ = source.Close()
		return nil, ErrPoolBusy
	}
	p.connecting = true // reserves the single publication slot during PublishTrack.
	startDone := make(chan struct{})
	p.startDone = startDone
	p.mu.Unlock()
	if err := trackCtx.Err(); err != nil {
		stopParent()
		trackCancel()
		_ = source.Close()
		terminal := p.lifecycleError(err)
		p.finishStarting(generation, startDone)
		return nil, terminal
	}

	unpublish, err := p.backend.publish(conn.room, source, sender)
	if err != nil {
		stopParent()
		trackCancel()
		_ = source.Close()
		p.markDead(generation, errors.New("track publication failed"))
		p.finishStarting(generation, startDone)
		return nil, errors.New("music livekit: track publication failed")
	}
	if err := trackCtx.Err(); err != nil {
		_ = unpublish()
		stopParent()
		trackCancel()
		_ = source.Close()
		p.markDead(generation, err)
		terminal := p.lifecycleError(err)
		p.finishStarting(generation, startDone)
		return nil, terminal
	}
	s := &Session{
		source: source, cancel: trackCancel, done: make(chan struct{}),
		unpublish: unpublish, pool: p, generation: generation, sender: sender,
		stopParent: stopParent,
	}
	p.mu.Lock()
	if p.closed || p.dead || p.generation != generation || p.connection != conn {
		p.mu.Unlock()
		s.finish(ErrPoolDead)
		terminal := p.lifecycleError(ErrPoolDead)
		close(s.done)
		p.finishStarting(generation, startDone)
		return nil, terminal
	}
	p.active = s
	p.finishStartingLocked(generation, startDone)
	p.mu.Unlock()
	go s.monitorPooled(trackCtx, boundGroup, epochs, initial)
	return s, nil
}

func (p *Pool) acquireRoom(ctx context.Context, call client.Call, binding poolBinding) (context.Context, *poolConnection, uint64, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, nil, 0, ErrPoolClosed
	}
	if p.dead {
		p.mu.Unlock()
		return nil, nil, 0, ErrPoolDead
	}
	if p.bound != nil && *p.bound != binding {
		gen := p.generation
		p.mu.Unlock()
		p.markDead(gen, ErrBinding)
		return nil, nil, 0, ErrBinding
	}
	if p.active != nil || p.connecting {
		p.mu.Unlock()
		return nil, nil, 0, ErrPoolBusy
	}
	if p.connection != nil {
		ctx := p.roomCtx
		conn := p.connection
		gen := p.generation
		p.mu.Unlock()
		return ctx, conn, gen, nil
	}
	if p.bound == nil {
		b := binding
		p.bound = &b
	}
	roomCtx, cancel := context.WithTimeout(context.Background(), p.lifetime)
	p.roomCtx, p.roomCancel = roomCtx, cancel
	p.generation++
	gen := p.generation
	p.connecting = true
	connectDone := make(chan struct{})
	p.connectDone = connectDone
	p.mu.Unlock()

	connectCtx, cancelConnect := context.WithCancel(roomCtx)
	stopParentCancel := context.AfterFunc(ctx, cancelConnect)
	room, err := p.backend.connect(connectCtx, call, func() { p.markDead(gen, ErrPoolDead) })
	connectErr := connectCtx.Err()
	stopParentCancel()
	cancelConnect()
	p.mu.Lock()
	if err != nil {
		if p.generation == gen {
			p.connecting = false
		}
		p.finishConnectLocked(gen, connectDone)
		p.mu.Unlock()
		p.markDead(gen, ErrRoomConnection)
		return nil, nil, 0, ErrRoomConnection
	}
	conn := &poolConnection{room: room}
	if p.closed || p.dead || p.generation != gen || roomCtx.Err() != nil || connectErr != nil {
		p.connecting = false
		p.mu.Unlock()
		conn.disconnect()
		p.mu.Lock()
		p.finishConnectLocked(gen, connectDone)
		p.mu.Unlock()
		if connectErr != nil {
			if lifecycleErr := p.lifecycleError(connectErr); !errors.Is(lifecycleErr, connectErr) {
				return nil, nil, 0, lifecycleErr
			}
			p.markDead(gen, connectErr)
			return nil, nil, 0, connectErr
		}
		return nil, nil, 0, p.currentError()
	}
	p.connection = conn
	p.connecting = false
	p.finishConnectLocked(gen, connectDone)
	p.mu.Unlock()
	go func() {
		<-roomCtx.Done()
		p.markDead(gen, roomCtx.Err())
	}()
	return roomCtx, conn, gen, nil
}

func (p *Pool) finishConnectLocked(generation uint64, done chan struct{}) {
	if p.generation == generation && p.connectDone == done {
		p.connectDone = nil
		close(done)
	}
}

func (p *Pool) finishStarting(generation uint64, done chan struct{}) {
	p.mu.Lock()
	p.finishStartingLocked(generation, done)
	p.mu.Unlock()
}

func (p *Pool) finishStartingLocked(generation uint64, done chan struct{}) {
	if p.generation == generation && p.startDone == done {
		p.startDone = nil
		p.connecting = false
		close(done)
	}
}

func (p *Pool) markDead(generation uint64, cause error) {
	p.mu.Lock()
	if p.generation != generation || p.closed || p.dead {
		p.mu.Unlock()
		return
	}
	p.dead = true
	p.deadReason = cause
	conn, cancel := p.connection, p.roomCancel
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if conn != nil {
		conn.disconnect()
	}
}

func (p *Pool) currentError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrPoolClosed
	}
	return ErrPoolDead
}

func (p *Pool) lifecycleError(fallback error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrPoolClosed
	}
	if p.dead {
		return ErrPoolDead
	}
	return fallback
}

// Reset is deliberately a no-op while the room is healthy. A dead or expired
// room is fully torn down before the next explicit Start may connect again.
func (p *Pool) Reset() error {
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return ErrPoolClosed
		}
		if !p.dead {
			p.mu.Unlock()
			return nil
		}
		if pending := p.connectDone; pending != nil {
			p.mu.Unlock()
			<-pending
			continue
		}
		if pending := p.startDone; pending != nil {
			p.mu.Unlock()
			<-pending
			continue
		}
		gen, active, conn, cancel := p.generation, p.active, p.connection, p.roomCancel
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if active != nil {
			_ = active.Close()
		}
		if conn != nil {
			conn.disconnect()
		}
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return ErrPoolClosed
		}
		if p.generation == gen && p.dead && p.connectDone == nil {
			p.connection, p.roomCtx, p.roomCancel, p.bound = nil, nil, nil, nil
			p.active, p.connecting, p.dead, p.deadReason = nil, false, false, nil
			// Invalidate the old room's deadline watcher and disconnect callback.
			p.generation++
		}
		p.mu.Unlock()
	}
}

// Close permanently closes the pool and waits for any active track cleanup.
func (p *Pool) Close() error {
	p.mu.Lock()
	if p.closed {
		done := p.closeDone
		p.mu.Unlock()
		if done != nil {
			<-done
		}
		return nil
	}
	p.closed, p.dead = true, true
	active, cancel, connectDone, startDone := p.active, p.roomCancel, p.connectDone, p.startDone
	p.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if active != nil {
		_ = active.Close()
	}
	if connectDone != nil {
		<-connectDone
	}
	if startDone != nil {
		<-startDone
	}
	p.mu.Lock()
	active, conn := p.active, p.connection
	p.mu.Unlock()
	if active != nil {
		_ = active.Close()
	}
	if conn != nil {
		conn.disconnect()
	}
	close(p.closeDone)
	return nil
}

func (p *Pool) releaseTrack(s *Session) {
	p.mu.Lock()
	if p.active == s && p.generation == s.generation {
		p.active = nil
	}
	p.mu.Unlock()
}

func (s *Session) monitorPooled(ctx context.Context, groupID id.ID, epochs EpochSource, initial native.CallMediaEpoch) {
	defer close(s.done)
	defer s.pool.releaseTrack(s)
	ticker := time.NewTicker(epochPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			s.finish(s.pool.deadCause(s.generation, ctx.Err()))
			return
		case <-s.source.Done():
			s.finish(s.source.Wait())
			return
		case <-ticker.C:
			if err := revalidateEpoch(ctx, groupID, epochs, initial); err != nil {
				s.pool.markDead(s.generation, err)
				s.finish(err)
				return
			}
		}
	}
}

func (p *Pool) deadCause(generation uint64, fallback error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.generation == generation && p.deadReason != nil {
		return p.deadReason
	}
	return fallback
}
