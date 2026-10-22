package service

import (
	"container/list"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"sync"

	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	interactionStatusForbidden   = 2
	interactionStatusExpired     = 3
	interactionStatusConflict    = 4
	interactionStatusUnavailable = 5
	interactionStatusBusy        = 6
	interactionStatusInternal    = 9
	interactionReplayLimit       = 4096
)

var ErrInteractionRequestIDConflict = errors.New("bot interaction request id reused with different input")
var ErrInteractionDispatcherBusy = errors.New("bot interaction dispatcher replay cache is full")
var ErrInteractionReadReplayNotAuthorized = errors.New("interaction read replay is no longer authorized")

type interactionNative interface {
	Binding() native.Binding
	InspectGroup(context.Context, id.ID) (native.GroupInfo, error)
	InspectInteractionGroup(context.Context, native.InteractionGroupExpected, []byte) (native.InteractionGroupInspectResult, error)
}

type InteractionSnapshotProvider interface {
	InteractionSnapshot(context.Context, native.GroupEvent) (native.InteractionGroupExpected, []byte, error)
}

// InteractionActor is copied solely from the authenticated native event.
type InteractionActor struct {
	User, Device id.ID
	Kind, Tier   uint64
	Group        id.ID
	Channel      id.ID
}

type InteractionResult struct {
	Status   uint64
	Revision *uint64
	Data     []byte
}

// InteractionHandlerSpec allows mutations to check the current operator
// configuration revision before performing their effect.
type InteractionHandlerSpec struct {
	// RecomputeOnReplay marks read handlers whose authorization and response
	// must be refreshed for an exact duplicate request. Mutations must leave
	// this false so their effects remain deduplicated.
	RecomputeOnReplay bool
	// CurrentRevision is a preflight check. For mutations, Handle must
	// atomically compare Request.Revision with the current revision in the same
	// transaction as its write and return status 4 on a race.
	CurrentRevision func(context.Context, protocol.Request) (uint64, error)
	// RevisionInHandler means Handle authenticates the actor before reading
	// revision state and performs the atomic comparison itself.
	RevisionInHandler bool
	Handle            func(context.Context, InteractionActor, protocol.Request) (InteractionResult, error)
}

type interactionReplayKey struct {
	requestID   id.ID
	actorUser   id.ID
	actorDevice id.ID
	group       id.ID
	channel     id.ID
}

type interactionReplay struct {
	key         interactionReplayKey
	fingerprint [32]byte
	response    string
	done        chan struct{}
}

// InteractionDispatcher validates a native event, then passes its decoded
// request and native-derived actor to one registered handler. Dispatch trusts
// event fields only when callers obtained the event from the authenticated
// native helper; a Go GroupEvent value does not prove its own provenance.
// Replays are retained in a bounded, process-local cache.
type InteractionDispatcher struct {
	mu        sync.Mutex
	native    interactionNative
	binding   native.Binding
	now       func() uint64
	snapshots InteractionSnapshotProvider
	handlers  map[protocol.Operation]InteractionHandlerSpec
	entries   map[interactionReplayKey]*list.Element
	order     list.List
}

func NewInteractionDispatcher(n *native.Client, handlers map[protocol.Operation]InteractionHandlerSpec, now func() uint64) (*InteractionDispatcher, error) {
	return newInteractionDispatcher(n, handlers, now)
}

// NewInteractionDispatcherWithSnapshots enables kind-3 dispatch after the provider
// obtains a fresh server-signed snapshot for the event's recorded participant.
func NewInteractionDispatcherWithSnapshots(n *native.Client, handlers map[protocol.Operation]InteractionHandlerSpec, now func() uint64, snapshots InteractionSnapshotProvider) (*InteractionDispatcher, error) {
	if snapshots == nil {
		return nil, errors.New("missing interaction snapshot provider")
	}
	return newInteractionDispatcherWithSnapshots(n, handlers, now, snapshots)
}

func newInteractionDispatcher(n interactionNative, handlers map[protocol.Operation]InteractionHandlerSpec, now func() uint64) (*InteractionDispatcher, error) {
	return newInteractionDispatcherWithSnapshots(n, handlers, now, nil)
}

func newInteractionDispatcherWithSnapshots(n interactionNative, handlers map[protocol.Operation]InteractionHandlerSpec, now func() uint64, snapshots InteractionSnapshotProvider) (*InteractionDispatcher, error) {
	if n == nil || now == nil {
		return nil, errors.New("missing interaction dispatcher dependency")
	}
	binding := n.Binding()
	if binding.Instance.IsZero() || binding.Community.IsZero() || binding.Installation.IsZero() {
		return nil, errors.New("invalid interaction dispatcher binding")
	}
	registered := make(map[protocol.Operation]InteractionHandlerSpec, len(handlers))
	for operation, handler := range handlers {
		if handler.Handle == nil {
			return nil, errors.New("interaction handler is missing")
		}
		registered[operation] = handler
	}
	return &InteractionDispatcher{native: n, binding: binding, now: now, snapshots: snapshots, handlers: registered, entries: make(map[interactionReplayKey]*list.Element)}, nil
}

// Register adds or replaces a handler. Missing operations return the protocol's
// unavailable status, so unfinished features remain explicitly unavailable.
func (d *InteractionDispatcher) Register(operation protocol.Operation, handler InteractionHandlerSpec) error {
	if d == nil || handler.Handle == nil {
		return errors.New("invalid interaction handler")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.handlers[operation] = handler
	return nil
}

func (d *InteractionDispatcher) Dispatch(ctx context.Context, event native.GroupEvent) (string, error) {
	if d == nil || event.DeliveryID == 0 || event.Group.IsZero() || event.Community.IsZero() || event.Channel.IsZero() || event.SourceSequence == 0 || event.SenderUser.IsZero() || event.SenderDevice.IsZero() || event.SenderKind != 0 || event.SenderTier > 1 || event.EnvelopeType != 0 || event.Body == nil {
		return "", protocol.ErrInvalid
	}
	if event.Community != d.binding.Community {
		return "", protocol.ErrContext
	}
	group, err := d.native.InspectGroup(ctx, event.Group)
	if err != nil {
		return "", err
	}
	// GroupEvent fields alone do not prove a kind-3 installation or participant
	// binding. Require a fresh signed context and native MLS inspection first.
	if group.ID != event.Group || group.State != 2 || group.Community == nil || *group.Community != d.binding.Community || group.Target != event.Channel {
		return "", protocol.ErrContext
	}
	if group.Kind == 3 {
		if d.snapshots == nil || event.SenderKind != 0 {
			return "", protocol.ErrContext
		}
		expected, snapshot, snapshotErr := d.snapshots.InteractionSnapshot(ctx, event)
		if snapshotErr != nil || len(snapshot) == 0 || expected.Instance != d.binding.Instance || expected.Installation != d.binding.Installation || expected.Community != d.binding.Community || expected.Group != event.Group || expected.ParticipantUser != event.SenderUser || expected.ParticipantDevice != event.SenderDevice {
			return "", protocol.ErrContext
		}
		inspected, inspectErr := d.native.InspectInteractionGroup(ctx, expected, snapshot)
		if inspectErr != nil || inspected.Binding.Instance != expected.Instance || inspected.Binding.Installation != expected.Installation || inspected.Binding.Community != expected.Community || inspected.Binding.BotUser != expected.BotUser || inspected.BotDevice != expected.BotDevice || inspected.Binding.ParticipantUser != expected.ParticipantUser || inspected.Binding.ParticipantDevice != expected.ParticipantDevice || inspected.Binding.PolicyVersion != expected.PolicyVersion || inspected.Binding.E2EEVersion != 1 || inspected.Binding.MediaVersion != 0 || inspected.Epoch == 0 || inspected.State != 2 {
			return "", protocol.ErrContext
		}
	} else if group.Kind != 0 {
		return "", protocol.ErrContext
	}
	request, err := protocol.DecodeRequest(*event.Body)
	if err != nil {
		return "", err
	}
	encoded, err := protocol.EncodeRequest(request)
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	handler, ok := d.handlers[request.Operation]
	d.mu.Unlock()
	response := protocol.Response{RequestID: request.RequestID, CommunityID: d.binding.Community, Data: []byte{}}
	key := interactionReplayKey{requestID: request.RequestID, actorUser: event.SenderUser, actorDevice: event.SenderDevice, group: event.Group, channel: event.Channel}
	fingerprint := interactionFingerprint(encoded)
	entry, owner, err := d.begin(ctx, key, fingerprint)
	if err != nil {
		if errors.Is(err, ErrInteractionDispatcherBusy) {
			response.Status = interactionStatusBusy
			return protocol.EncodeResponse(response)
		}
		return "", err
	}
	if !owner {
		if !ok || !handler.RecomputeOnReplay {
			select {
			case <-entry.done:
				return entry.response, nil
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		select {
		case <-entry.done:
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	finish := func() (string, error) {
		body, encodeErr := protocol.EncodeResponse(response)
		if encodeErr != nil {
			response.Status = interactionStatusInternal
			response.Revision = nil
			response.Data = []byte{}
			body, encodeErr = protocol.EncodeResponse(response)
		}
		if encodeErr != nil {
			return "", encodeErr
		}
		if owner {
			d.complete(entry, body)
		}
		return body, nil
	}

	if request.CommunityID != d.binding.Community {
		response.Status = interactionStatusForbidden
		return finish()
	}
	if err := protocol.ValidateRequestContext(request, d.binding.Community, d.now()); err != nil {
		if errors.Is(err, protocol.ErrExpired) {
			response.Status = interactionStatusExpired
			return finish()
		}
		response.Status = interactionStatusForbidden
		return finish()
	}
	if request.ChannelID != nil && *request.ChannelID != event.Channel {
		response.Status = interactionStatusForbidden
		return finish()
	}

	if !ok {
		response.Status = interactionStatusUnavailable
		return finish()
	}
	actor := InteractionActor{User: event.SenderUser, Device: event.SenderDevice, Kind: event.SenderKind, Tier: event.SenderTier, Group: event.Group, Channel: event.Channel}
	if request.Revision != nil {
		if handler.CurrentRevision == nil && !handler.RevisionInHandler {
			response.Status = interactionStatusUnavailable
			return finish()
		}
		if handler.CurrentRevision != nil {
			current, revisionErr := handler.CurrentRevision(ctx, request)
			if revisionErr != nil || current > math.MaxInt64 {
				response.Status = interactionStatusInternal
				return finish()
			}
			if *request.Revision != current {
				response.Status = interactionStatusConflict
				response.Revision = &current
				return finish()
			}
		}
	}
	result, handlerErr := handler.Handle(ctx, actor, request)
	if handlerErr != nil || result.Status > 9 || result.Revision != nil && *result.Revision > math.MaxInt64 {
		response.Status = interactionStatusInternal
		return finish()
	}
	response.Status = result.Status
	response.Revision = result.Revision
	response.Data = append([]byte{}, result.Data...)
	return finish()
}

// ReauthorizeReadReplay reruns a registered read handler and discards its
// response. It is used before resuming a durable response whose send has not
// yet been accepted, so revoked or expired reads remain pending without
// changing the response already bound to that event.
func (d *InteractionDispatcher) ReauthorizeReadReplay(ctx context.Context, event native.GroupEvent) error {
	if d == nil || event.Body == nil {
		return protocol.ErrInvalid
	}
	request, err := protocol.DecodeRequest(*event.Body)
	if err != nil {
		return err
	}
	d.mu.Lock()
	handler, ok := d.handlers[request.Operation]
	d.mu.Unlock()
	if !ok || !handler.RecomputeOnReplay {
		return nil
	}
	body, err := d.Dispatch(ctx, event)
	if err != nil {
		return err
	}
	response, err := protocol.DecodeResponse(body)
	if err != nil {
		return err
	}
	if response.RequestID != request.RequestID || response.CommunityID != d.binding.Community || response.Status != 0 {
		return ErrInteractionReadReplayNotAuthorized
	}
	return nil
}

func (d *InteractionDispatcher) begin(ctx context.Context, key interactionReplayKey, fingerprint [32]byte) (*interactionReplay, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if element := d.entries[key]; element != nil {
		entry := element.Value.(*interactionReplay)
		if entry.fingerprint != fingerprint {
			return nil, false, ErrInteractionRequestIDConflict
		}
		return entry, false, nil
	}
	for d.order.Len() >= interactionReplayLimit {
		oldest := d.order.Front()
		if oldest == nil {
			break
		}
		entry := oldest.Value.(*interactionReplay)
		select {
		case <-entry.done:
			d.order.Remove(oldest)
			delete(d.entries, entry.key)
		default:
			return nil, false, ErrInteractionDispatcherBusy
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	entry := &interactionReplay{key: key, fingerprint: fingerprint, done: make(chan struct{})}
	d.entries[key] = d.order.PushBack(entry)
	return entry, true, nil
}

func (d *InteractionDispatcher) complete(entry *interactionReplay, response string) {
	d.mu.Lock()
	entry.response = response
	close(entry.done)
	d.mu.Unlock()
}

func interactionFingerprint(body string) [32]byte {
	return sha256.Sum256([]byte(body))
}
