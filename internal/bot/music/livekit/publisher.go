// Package livekit joins a call as an audio-only LiveKit music publisher.
package livekit

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
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
	ErrBinding      = errors.New("music livekit: call media binding rejected")
	ErrEpochChanged = errors.New("music livekit: call media epoch changed")
)

const epochPollInterval = 2 * time.Second
const maxPublisherLifetime = 30 * time.Minute

// EpochSource fetches the helper's current call media epoch. Implementations
// must return errors without including key material in diagnostics.
type EpochSource interface {
	CallMediaEpoch(context.Context, id.ID) (native.CallMediaEpoch, error)
}

type publisherRoom interface{ Disconnect() }

type sourceLifecycle interface {
	Done() <-chan struct{}
	Wait() error
	Close() error
}

// Session owns a LiveKit connection and the bounded music encoder session.
// It ends when the parent context is cancelled, its lifetime expires, the
// encoder ends, or the call's MLS epoch changes.
type Session struct {
	room   publisherRoom
	source sourceLifecycle
	cancel context.CancelFunc
	done   chan struct{}
	mu     sync.RWMutex
	err    error
	once   sync.Once
}

// Start validates the call/group binding, obtains the current MLS sender,
// connects with auto-subscribe disabled, and publishes the source's bounded
// Opus provider. lifetime is mandatory to bound credential and key exposure.
func Start(ctx context.Context, call client.Call, boundGroup id.ID, epochs EpochSource, source *runtime.Session, lifetime time.Duration) (*Session, error) {
	if ctx == nil || epochs == nil || source == nil || lifetime <= 0 || lifetime > maxPublisherLifetime || call.CallID.IsZero() || call.GroupID.IsZero() ||
		boundGroup.IsZero() || call.GroupID != boundGroup || call.LiveKitURL == "" || call.Token == "" {
		return nil, ErrBinding
	}
	epoch, err := epochs.CallMediaEpoch(ctx, boundGroup)
	if err != nil {
		_ = source.Close()
		return nil, errors.New("music livekit: call media key lookup failed")
	}
	if err := validateSenderEpoch(epoch); err != nil {
		_ = source.Close()
		return nil, err
	}
	state, ok := epochs.(counter.State)
	if !ok {
		_ = source.Close()
		return nil, ErrBinding
	}
	sender, err := senderForReservedEpoch(ctx, state, boundGroup, epoch)
	if err != nil {
		_ = source.Close()
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		_ = source.Close()
		return nil, err
	}
	runCtx, cancel := context.WithCancel(ctx)
	callback := publisherRoomCallback(cancel)
	room, err := lksdk.ConnectToRoomWithToken(call.LiveKitURL, call.Token, callback, lksdk.WithAutoSubscribe(false))
	if err != nil {
		cancel()
		_ = source.Close()
		return nil, errors.New("music livekit: room connection failed")
	}
	if err := runCtx.Err(); err != nil {
		room.Disconnect()
		cancel()
		_ = source.Close()
		return nil, err
	}
	if err := revalidateEpoch(runCtx, boundGroup, epochs, epoch); err != nil {
		room.Disconnect()
		cancel()
		_ = source.Close()
		return nil, err
	}
	if _, err := media.PublishLiveOpus(room, source.Provider(), sender); err != nil {
		room.Disconnect()
		cancel()
		_ = source.Close()
		return nil, errors.New("music livekit: track publication failed")
	}
	if err := runCtx.Err(); err != nil {
		room.Disconnect()
		cancel()
		_ = source.Close()
		return nil, err
	}
	s := &Session{room: room, source: source, cancel: cancel, done: make(chan struct{})}
	go s.monitor(runCtx, boundGroup, epochs, epoch, lifetime)
	return s, nil
}

func senderForEpoch(epoch native.CallMediaEpoch) (*sframe.Sender, error) {
	if err := validateSenderEpoch(epoch); err != nil {
		return nil, err
	}
	sender, err := sframe.NewSender(epoch.BaseKey, uint16(epoch.OwnLeaf), epoch.Epoch, epoch.Epoch)
	if err != nil {
		return nil, fmt.Errorf("music livekit: sender initialization failed: %w", err)
	}
	return sender, nil
}

func senderForReservedEpoch(ctx context.Context, state counter.State, group id.ID, epoch native.CallMediaEpoch) (*sframe.Sender, error) {
	if ctx == nil || state == nil || group.IsZero() {
		return nil, ErrBinding
	}
	if err := validateSenderEpoch(epoch); err != nil {
		return nil, err
	}
	reserved, err := counter.Reserve(ctx, state, group, epoch.Epoch, uint16(epoch.OwnLeaf))
	if err != nil {
		return nil, errors.New("music livekit: sender counter reservation failed")
	}
	sender, err := sframe.NewSenderRange(epoch.BaseKey, uint16(epoch.OwnLeaf), epoch.Epoch, reserved.Start, reserved.End)
	if err != nil {
		return nil, fmt.Errorf("music livekit: sender range initialization failed: %w", err)
	}
	return sender, nil
}

func validateSenderEpoch(epoch native.CallMediaEpoch) error {
	if epoch.OwnLeaf > uint64(^uint16(0)) || allZero(epoch.BaseKey[:]) {
		return ErrBinding
	}
	found := false
	for _, member := range epoch.Roster {
		if member.Leaf == epoch.OwnLeaf {
			if found {
				return ErrBinding
			}
			found = true
		}
	}
	if !found {
		return ErrBinding
	}
	return nil
}

func (s *Session) monitor(ctx context.Context, groupID id.ID, epochs EpochSource, initial native.CallMediaEpoch, lifetime time.Duration) {
	defer close(s.done)
	ticker := time.NewTicker(epochPollInterval)
	defer ticker.Stop()
	timer := time.NewTimer(lifetime)
	defer timer.Stop()
	var terminal error
	finished := false
	for !finished {
		select {
		case <-ctx.Done():
			terminal = ctx.Err()
			finished = true
		case <-timer.C:
			terminal = context.DeadlineExceeded
			finished = true
		case <-s.source.Done():
			terminal = s.source.Wait()
			finished = true
		case <-ticker.C:
			terminal = revalidateEpoch(ctx, groupID, epochs, initial)
			finished = terminal != nil
		}
	}
	s.finish(terminal)
}

func revalidateEpoch(ctx context.Context, callID id.ID, epochs EpochSource, initial native.CallMediaEpoch) error {
	current, err := epochs.CallMediaEpoch(ctx, callID)
	if err != nil {
		return errors.New("music livekit: call media key lookup failed")
	}
	return epochStillBound(current, initial)
}

func publisherRoomCallback(cancel context.CancelFunc) *lksdk.RoomCallback {
	return &lksdk.RoomCallback{OnDisconnected: cancel}
}

func epochStillBound(current, initial native.CallMediaEpoch) error {
	if current.Epoch != initial.Epoch || current.OwnLeaf != initial.OwnLeaf ||
		subtle.ConstantTimeCompare(current.BaseKey[:], initial.BaseKey[:]) != 1 {
		return ErrEpochChanged
	}
	if err := validateSenderEpoch(current); err != nil {
		return err
	}
	return nil
}

func (s *Session) finish(err error) {
	s.once.Do(func() {
		s.mu.Lock()
		s.err = err
		s.mu.Unlock()
		s.cancel()
		s.room.Disconnect()
		_ = s.source.Close()
	})
}

// Done closes after room and encoder cleanup have completed.
func (s *Session) Done() <-chan struct{} { return s.done }

// Wait blocks until cleanup completes and returns the terminal reason.
func (s *Session) Wait() error {
	<-s.done
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

// Close immediately stops publishing and waits for cleanup.
func (s *Session) Close() error {
	s.finish(context.Canceled)
	<-s.done
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.err
}

func allZero(b []byte) bool {
	var v byte
	for _, x := range b {
		v |= x
	}
	return v == 0
}
