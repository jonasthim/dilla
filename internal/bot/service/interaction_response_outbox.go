package service

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	interactionResponseOutboxArea    = uint64(3)
	interactionResponseOutboxVersion = uint64(1)
	interactionResponseOutboxPrefix  = "dilla.bot.interaction-response.v1/"
	maxInteractionResponseBody       = 64 << 10
)

var (
	ErrInteractionResponseConflict = errors.New("interaction event already has a different request identity")
	ErrInteractionResponseState    = errors.New("interaction response outbox state is invalid or changed")
)

type interactionResponseOutboxNative interface {
	Binding() native.Binding
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}

// InteractionResponseOutbox durably records an event's exact response body and
// send identity before invoking the send coordinator. Callers must still make
// handler effects idempotent: a crash after a handler's side effect but before
// this record is committed can cause that handler to run again on redelivery.
type InteractionResponseOutbox struct {
	native  interactionResponseOutboxNative
	session *client.Session
	binding native.Binding
	sendFn  func(context.Context, SendInput) (protocol.SendReceipt, error)
}

// NewInteractionResponseOutbox wires the durable response outbox to the
// existing native state store and SendCoordinator.
func NewInteractionResponseOutbox(n *native.Client, coordinator *SendCoordinator, session *client.Session) (*InteractionResponseOutbox, error) {
	if n == nil || coordinator == nil || session == nil {
		return nil, errors.New("missing interaction response outbox dependency")
	}
	o, err := newInteractionResponseOutbox(n, nil)
	if err != nil {
		return nil, err
	}
	o.sendFn = func(ctx context.Context, in SendInput) (protocol.SendReceipt, error) {
		return coordinator.Send(ctx, session, in)
	}
	return o, nil
}

func newInteractionResponseOutbox(n interactionResponseOutboxNative, send func(context.Context, SendInput) (protocol.SendReceipt, error)) (*InteractionResponseOutbox, error) {
	if n == nil {
		return nil, errors.New("missing interaction response outbox state")
	}
	b := n.Binding()
	if b.Instance.IsZero() || b.Community.IsZero() || b.Installation.IsZero() {
		return nil, errors.New("invalid interaction response outbox binding")
	}
	return &InteractionResponseOutbox{native: n, binding: b, sendFn: send}, nil
}

type interactionResponseRecord struct {
	EventFingerprint   [32]byte
	RequestFingerprint [32]byte
	Group              id.ID
	ResponseBody       []byte
	OperationID        id.ID
	AttemptID          id.ID
	OriginalNow        uint64
	ExpectedGeneration uint64
}

// InteractionResponse is a copy of the durable response and its immutable send
// coordinates. It lets an event consumer resume delivery without re-running a
// handler after the response record has been committed.
type InteractionResponse struct {
	Body               []byte
	OperationID        id.ID
	AttemptID          id.ID
	Group              id.ID
	OriginalNow        uint64
	ExpectedGeneration uint64
}

// Send persists a response before sending it. If the event already has a
// matching request identity, the previously persisted response and send IDs
// are used verbatim, even if this invocation generated a different candidate
// response. Reuse of the event delivery ID for different event/request content
// fails closed.
func (o *InteractionResponseOutbox) Send(ctx context.Context, event native.GroupEvent, responseBody []byte, operationID, attemptID id.ID, originalNow, expectedGeneration uint64) (protocol.SendReceipt, error) {
	if o == nil || ctx == nil || o.sendFn == nil || event.DeliveryID == 0 || event.Community != o.binding.Community || event.Group.IsZero() || event.Channel.IsZero() || event.SenderUser.IsZero() || event.SenderDevice.IsZero() || event.Body == nil || operationID.IsZero() || attemptID.IsZero() || len(responseBody) == 0 || len(responseBody) > maxInteractionResponseBody || originalNow > math.MaxInt64 || expectedGeneration == 0 || expectedGeneration > math.MaxInt64 {
		return protocol.SendReceipt{}, errors.New("invalid interaction response outbox input")
	}
	request, err := protocol.DecodeRequest(*event.Body)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	canonicalRequest, err := protocol.EncodeRequest(request)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	requestFingerprint := sha256.Sum256([]byte(canonicalRequest))
	eventFingerprint, err := interactionResponseEventFingerprint(event)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	key := interactionResponseOutboxKey(o.binding.Installation, event.DeliveryID)
	record, err := o.loadOrCreate(ctx, key, interactionResponseRecord{
		EventFingerprint: eventFingerprint, RequestFingerprint: requestFingerprint,
		Group: event.Group, ResponseBody: append([]byte(nil), responseBody...),
		OperationID: operationID, AttemptID: attemptID, OriginalNow: originalNow,
		ExpectedGeneration: expectedGeneration,
	})
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	input := SendInput{OperationID: record.OperationID, AttemptID: record.AttemptID, GroupID: record.Group,
		RequestBody: append([]byte(nil), record.ResponseBody...), OriginalNow: record.OriginalNow,
		ExpectedGeneration: record.ExpectedGeneration}
	return o.sendFn(ctx, input)
}

// Resume sends the saved response for an event, or returns found=false when
// no response has been committed yet. A found record is identity-checked
// against the redelivered event before any send occurs.
func (o *InteractionResponseOutbox) Resume(ctx context.Context, event native.GroupEvent) (receipt protocol.SendReceipt, found bool, err error) {
	if o == nil || ctx == nil || o.sendFn == nil {
		return protocol.SendReceipt{}, false, errors.New("invalid interaction response outbox")
	}
	record, found, err := o.lookup(ctx, event)
	if err != nil || !found {
		return protocol.SendReceipt{}, found, err
	}
	input := SendInput{OperationID: record.OperationID, AttemptID: record.AttemptID, GroupID: record.Group,
		RequestBody: append([]byte(nil), record.ResponseBody...), OriginalNow: record.OriginalNow,
		ExpectedGeneration: record.ExpectedGeneration}
	receipt, err = o.sendFn(ctx, input)
	return receipt, true, err
}

// Lookup returns a previously committed response without sending it.
func (o *InteractionResponseOutbox) Lookup(ctx context.Context, event native.GroupEvent) (InteractionResponse, bool, error) {
	if o == nil || ctx == nil {
		return InteractionResponse{}, false, errors.New("invalid interaction response outbox")
	}
	r, found, err := o.lookup(ctx, event)
	if err != nil || !found {
		return InteractionResponse{}, found, err
	}
	return InteractionResponse{Body: append([]byte(nil), r.ResponseBody...), OperationID: r.OperationID,
		AttemptID: r.AttemptID, Group: r.Group, OriginalNow: r.OriginalNow,
		ExpectedGeneration: r.ExpectedGeneration}, true, nil
}

func (o *InteractionResponseOutbox) lookup(ctx context.Context, event native.GroupEvent) (interactionResponseRecord, bool, error) {
	if event.DeliveryID == 0 || event.Community != o.binding.Community || event.Group.IsZero() || event.Channel.IsZero() || event.SenderUser.IsZero() || event.SenderDevice.IsZero() || event.Body == nil {
		return interactionResponseRecord{}, false, errors.New("invalid interaction response event")
	}
	request, err := protocol.DecodeRequest(*event.Body)
	if err != nil {
		return interactionResponseRecord{}, false, err
	}
	canonical, err := protocol.EncodeRequest(request)
	if err != nil {
		return interactionResponseRecord{}, false, err
	}
	requestFingerprint := sha256.Sum256([]byte(canonical))
	eventFingerprint, err := interactionResponseEventFingerprint(event)
	if err != nil {
		return interactionResponseRecord{}, false, err
	}
	current, err := o.native.StateGet(ctx, interactionResponseOutboxArea, interactionResponseOutboxKey(o.binding.Installation, event.DeliveryID))
	if err != nil {
		return interactionResponseRecord{}, false, err
	}
	if current.Tombstone {
		return interactionResponseRecord{}, false, ErrInteractionResponseState
	}
	if current.Revision == 0 {
		return interactionResponseRecord{}, false, nil
	}
	r, err := decodeInteractionResponseRecord(current.Value)
	if err != nil {
		return interactionResponseRecord{}, false, ErrInteractionResponseState
	}
	if r.EventFingerprint != eventFingerprint || r.RequestFingerprint != requestFingerprint || r.Group != event.Group {
		return interactionResponseRecord{}, false, ErrInteractionResponseConflict
	}
	return r, true, nil
}

func (o *InteractionResponseOutbox) loadOrCreate(ctx context.Context, key []byte, candidate interactionResponseRecord) (interactionResponseRecord, error) {
	want, err := encodeInteractionResponseRecord(candidate)
	if err != nil {
		return interactionResponseRecord{}, err
	}
	for tries := 0; tries < 4; tries++ {
		current, err := o.native.StateGet(ctx, interactionResponseOutboxArea, key)
		if err != nil {
			return interactionResponseRecord{}, err
		}
		if current.Tombstone {
			return interactionResponseRecord{}, ErrInteractionResponseState
		}
		if current.Revision != 0 {
			record, decodeErr := decodeInteractionResponseRecord(current.Value)
			if decodeErr != nil {
				return interactionResponseRecord{}, ErrInteractionResponseState
			}
			if record.EventFingerprint != candidate.EventFingerprint || record.RequestFingerprint != candidate.RequestFingerprint || record.Group != candidate.Group {
				return interactionResponseRecord{}, ErrInteractionResponseConflict
			}
			return record, nil
		}
		_, txErr := o.native.StateTransaction(ctx, id.New(), []native.StateChange{{Area: interactionResponseOutboxArea, Key: key, ExpectedRevision: current.Revision, Value: want}})
		if txErr == nil {
			return candidate, nil
		}
		// A transaction error can mean a revision race or a lost reply after
		// commit. Re-read: only a matching durable record authorizes sending.
		actual, readErr := o.native.StateGet(ctx, interactionResponseOutboxArea, key)
		if readErr != nil {
			return interactionResponseRecord{}, errors.Join(txErr, readErr)
		}
		if actual.Revision != 0 && !actual.Tombstone {
			record, decodeErr := decodeInteractionResponseRecord(actual.Value)
			if decodeErr != nil {
				return interactionResponseRecord{}, ErrInteractionResponseState
			}
			if record.EventFingerprint != candidate.EventFingerprint || record.RequestFingerprint != candidate.RequestFingerprint || record.Group != candidate.Group {
				return interactionResponseRecord{}, ErrInteractionResponseConflict
			}
			return record, nil
		}
	}
	return interactionResponseRecord{}, fmt.Errorf("%w: compare-and-set retries exhausted", ErrInteractionResponseState)
}

func interactionResponseOutboxKey(installation id.ID, delivery uint64) []byte {
	key := make([]byte, len(interactionResponseOutboxPrefix)+id.Size+8)
	copy(key, interactionResponseOutboxPrefix)
	copy(key[len(interactionResponseOutboxPrefix):], installation[:])
	binary.BigEndian.PutUint64(key[len(interactionResponseOutboxPrefix)+id.Size:], delivery)
	return key
}

func interactionResponseEventFingerprint(e native.GroupEvent) ([32]byte, error) {
	var body any
	if e.Body != nil {
		body = *e.Body
	}
	var reply, thread any
	if e.ReplyTo != nil {
		reply = *e.ReplyTo
	}
	if e.Thread != nil {
		thread = *e.Thread
	}
	encoded, err := cborx.Marshal([]any{e.DeliveryID, e.Group, e.Community, e.Channel, e.SourceSequence, e.Epoch, e.ReceivedAt,
		e.SenderUser, e.SenderDevice, e.SenderKind, e.SenderTier, uint64(e.SenderLeaf), e.Message, e.EnvelopeType, body, reply, thread})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(encoded), nil
}

func encodeInteractionResponseRecord(r interactionResponseRecord) ([]byte, error) {
	if r.Group.IsZero() || r.OperationID.IsZero() || r.AttemptID.IsZero() || len(r.ResponseBody) == 0 || len(r.ResponseBody) > maxInteractionResponseBody || r.ExpectedGeneration == 0 || r.ExpectedGeneration > math.MaxInt64 || r.OriginalNow > math.MaxInt64 {
		return nil, ErrInteractionResponseState
	}
	return cborx.Marshal([]any{interactionResponseOutboxVersion, r.EventFingerprint[:], r.RequestFingerprint[:], r.Group,
		append([]byte(nil), r.ResponseBody...), r.OperationID, r.AttemptID, r.OriginalNow, r.ExpectedGeneration})
}

func decodeInteractionResponseRecord(encoded []byte) (interactionResponseRecord, error) {
	var r interactionResponseRecord
	var n []any
	if err := cborx.Unmarshal(encoded, &n); err != nil || len(n) != 9 {
		return r, ErrInteractionResponseState
	}
	version, ok := n[0].(uint64)
	if !ok || version != interactionResponseOutboxVersion {
		return r, ErrInteractionResponseState
	}
	eventHash, ok := n[1].([]byte)
	if !ok || len(eventHash) != len(r.EventFingerprint) {
		return r, ErrInteractionResponseState
	}
	copy(r.EventFingerprint[:], eventHash)
	requestHash, ok := n[2].([]byte)
	if !ok || len(requestHash) != len(r.RequestFingerprint) {
		return r, ErrInteractionResponseState
	}
	copy(r.RequestFingerprint[:], requestHash)
	if r.Group, ok = outboxID(n[3]); !ok {
		return r, ErrInteractionResponseState
	}
	if r.ResponseBody, ok = n[4].([]byte); !ok {
		return r, ErrInteractionResponseState
	}
	r.ResponseBody = append([]byte(nil), r.ResponseBody...)
	if r.OperationID, ok = outboxID(n[5]); !ok {
		return r, ErrInteractionResponseState
	}
	if r.AttemptID, ok = outboxID(n[6]); !ok {
		return r, ErrInteractionResponseState
	}
	if r.OriginalNow, ok = n[7].(uint64); !ok {
		return r, ErrInteractionResponseState
	}
	if r.ExpectedGeneration, ok = n[8].(uint64); !ok {
		return r, ErrInteractionResponseState
	}
	if _, err := encodeInteractionResponseRecord(r); err != nil {
		return r, ErrInteractionResponseState
	}
	return r, nil
}

func outboxID(value any) (id.ID, bool) {
	var result id.ID
	if typed, ok := value.(id.ID); ok {
		return typed, true
	}
	bytes, ok := value.([]byte)
	if !ok || len(bytes) != len(result) {
		return result, false
	}
	copy(result[:], bytes)
	return result, true
}
