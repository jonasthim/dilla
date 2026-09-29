// Package gateway is dilla's CBOR WebSocket gateway: the four-element frame of
// protocol/02-delivery-service.md, resumable sessions with a bounded replay ring, per-connection
// fan-out and the online predicate the delivery service's invariants 5, 6 and 7 are defined over.
//
// Two counters exist and are never conflated: the per-group delivery-service seq, which is durable
// and appears inside payloads, and the per-session replay n, which lives only in memory and only
// in element 1 of a frame.
package gateway

import (
	"fmt"
	"math"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// Op is a frame opcode. The dotted names in protocol/02 are documentation labels; the wire
// carries these uints.
type Op uint8

const (
	OpHello          Op = 0
	OpIdentify       Op = 1
	OpResume         Op = 2
	OpReady          Op = 3
	OpResumed        Op = 4
	OpInvalidSession Op = 5
	OpHeartbeat      Op = 6
	OpHeartbeatAck   Op = 7
	OpReconnect      Op = 8
	OpError          Op = 9
	OpSubscribe      Op = 10
	OpUnsubscribe    Op = 11
	// OpCommitAck is the acknowledgement invariant 7 counts rounds against. Without it
	// `e.acked` is never set in production, the watchdog never increments `lost`, and the
	// three-lost-rounds Remove is dead code that only a unit test can reach. It is the one
	// client opcode that is group-scoped.
	OpCommitAck Op = 12

	OpMLSHandshake    Op = 16
	OpMLSCommitNeeded Op = 17
	OpMLSEpochChanged Op = 18
	OpMessageCT       Op = 19
	OpMLSWelcome      Op = 20
	OpMessageDeleted  Op = 21

	OpMessagePlain Op = 32
	OpInteraction  Op = 33

	OpPresence   Op = 48
	OpTyping     Op = 49
	OpVoiceState Op = 50
)

// CloseCode is a WebSocket close code from RFC 6455's private range.
type CloseCode uint16

const (
	CloseUnknown         CloseCode = 4000
	CloseNotIdentified   CloseCode = 4001
	CloseDecode          CloseCode = 4002
	CloseUnauthenticated CloseCode = 4003
	CloseSessionRevoked  CloseCode = 4004
	CloseVersion         CloseCode = 4006
	CloseInvalidN        CloseCode = 4007
	CloseRateLimited     CloseCode = 4008
	CloseSessionTimeout  CloseCode = 4009
	CloseGoingAway       CloseCode = 4010
)

// Resumable reports whether a client may reconnect with a resume frame after this close.
func (c CloseCode) Resumable() bool {
	switch c {
	case CloseUnknown, CloseRateLimited, CloseGoingAway:
		return true
	default:
		return false
	}
}

// opSpec fixes each opcode's direction, element count and whether it is group-scoped. A frame of
// the wrong element count for its opcode is E_FRAME_SHAPE; an opcode outside this table is
// E_FRAME_TYPE, never ignored.
type opSpec struct {
	elements   int
	fromClient bool
	grouped    bool
	replayable bool
}

var opSpecs = map[Op]opSpec{
	OpHello:    {elements: 9},
	OpIdentify: {elements: 5, fromClient: true},
	OpResume:   {elements: 4, fromClient: true},
	// Deviation B8: §2.3's heading says "Control (0-15) - group_id = null, n = 0", but `ready` and
	// `resumed` are the two control frames a client must be able to replay — a resumed connection
	// whose `resumed` frame was dropped has no record of the replay window it was given. They are
	// the only two exceptions.
	OpReady: {elements: 9, replayable: true},
	// `resumed` is [replayed_from, replayed_to, resume_token]: the token rotates on every resume
	// (facts-gateway-design.md §1.3), so the frame that announces one also issues the credential
	// for the next. A two-element `resumed` would cap a client at one resume per identify.
	OpResumed:        {elements: 3, replayable: true},
	OpInvalidSession: {elements: 2},
	OpHeartbeat:      {elements: 2, fromClient: true},
	OpHeartbeatAck:   {elements: 1},
	OpReconnect:      {elements: 2},
	OpError:          {elements: 3},
	OpSubscribe:      {elements: 1, fromClient: true},
	OpUnsubscribe:    {elements: 1, fromClient: true},
	OpCommitAck:      {elements: 1, fromClient: true, grouped: true},

	OpMLSHandshake:    {elements: 5, grouped: true, replayable: true},
	OpMLSCommitNeeded: {elements: 4, grouped: true},
	OpMLSEpochChanged: {elements: 2, grouped: true, replayable: true},
	OpMessageCT:       {elements: 6, grouped: true, replayable: true},
	OpMLSWelcome:      {elements: 6, grouped: true, replayable: true},
	OpMessageDeleted:  {elements: 2, grouped: true, replayable: true},

	OpMessagePlain: {elements: 7, replayable: true},
	OpInteraction:  {elements: 4, replayable: true},

	OpPresence:   {elements: 4},
	OpTyping:     {elements: 4},
	OpVoiceState: {elements: 4},
}

// FrameError is a structured refusal. Code is the E_FRAME_* string the client sees in an error
// frame; Close is the close code that follows it. A structured failure is always sent as an error
// frame before the close, because the close reason is capped at 123 bytes.
type FrameError struct {
	Code   string
	Detail string
	Close  CloseCode
}

func (e *FrameError) Error() string { return e.Code + ": " + e.Detail }

func frameErr(code, detail string, closeCode CloseCode) *FrameError {
	return &FrameError{Code: code, Detail: detail, Close: closeCode}
}

// Frame is one outbound frame. Payload is encoded once by the producer and shared by every
// connection: only element 1 (n) differs per connection, and Encode is what stamps it.
type Frame struct {
	Op      Op
	GroupID *id.ID
	Payload cbor.RawMessage
	Replay  bool
}

// Encode stamps n onto a frame. A frame with Replay false is always sent with n = 0.
func Encode(f Frame, n uint64) ([]byte, error) {
	if !f.Replay {
		n = 0
	}
	return cborx.MarshalFrame(uint64(f.Op), n, f.GroupID, f.Payload)
}

// Inbound is a decoded client-to-server frame.
type Inbound struct {
	Op      Op
	CID     uint64
	GroupID *id.ID
	Payload []cbor.RawMessage
	// handshakeToken is the Authorization bearer or the spent ticket from the HTTP upgrade, set by
	// serve before it dispatches the first frame: an identify whose token travelled on the
	// handshake carries an empty one in its payload and must still resolve. It is unexported
	// because it never comes off the wire.
	handshakeToken string
}

// Decode parses one inbound frame. maxBytes is gateway.read_limit_bytes; a longer frame is
// E_FRAME_LIMIT and is refused before the decoder allocates.
func Decode(b []byte, maxBytes int) (Inbound, error) {
	if len(b) > maxBytes {
		return Inbound{}, frameErr("E_FRAME_LIMIT",
			fmt.Sprintf("frame is %d bytes, limit %d", len(b), maxBytes), CloseRateLimited)
	}
	var elems []cbor.RawMessage
	if err := cborx.Unmarshal(b, &elems); err != nil {
		return Inbound{}, frameErr("E_FRAME_CBOR", err.Error(), CloseDecode)
	}
	if len(elems) != 4 {
		return Inbound{}, frameErr("E_FRAME_SHAPE",
			fmt.Sprintf("frame has %d elements, want 4", len(elems)), CloseDecode)
	}
	op, err := rawUint(elems[0])
	if err != nil {
		return Inbound{}, frameErr("E_FRAME_SHAPE", "op: "+err.Error(), CloseDecode)
	}
	code, spec, ok := lookupOp(op)
	if !ok || !spec.fromClient {
		return Inbound{}, frameErr("E_FRAME_TYPE",
			fmt.Sprintf("opcode %d is not a client frame in this wire_version", op), CloseDecode)
	}
	cid, err := rawUint(elems[1])
	if err != nil {
		return Inbound{}, frameErr("E_FRAME_SHAPE", "n: "+err.Error(), CloseDecode)
	}
	var gid *id.ID
	if !isNull(elems[2]) {
		var parsed id.ID
		if err := cborx.Unmarshal(elems[2], &parsed); err != nil {
			return Inbound{}, frameErr("E_FRAME_SHAPE", "group_id: "+err.Error(), CloseDecode)
		}
		gid = &parsed
	}
	if gid != nil && !spec.grouped {
		return Inbound{}, frameErr("E_FRAME_SHAPE",
			fmt.Sprintf("opcode %d is not group-scoped", op), CloseDecode)
	}
	// The other direction, which matters now that opcode 12 `commit_ack` exists: a group-scoped
	// client frame with a null group_id would otherwise reach `handle` with `in.GroupID == nil`
	// and be silently ignored, so invariant 7's acknowledgement would be lost rather than refused.
	if gid == nil && spec.grouped {
		return Inbound{}, frameErr("E_FRAME_SHAPE",
			fmt.Sprintf("opcode %d is group-scoped and carries no group_id", op), CloseDecode)
	}
	if err := cborx.ExpectMajor(elems[3], cborx.MajorArray); err != nil {
		return Inbound{}, frameErr("E_FRAME_SHAPE", "payload: "+err.Error(), CloseDecode)
	}
	var payload []cbor.RawMessage
	if err := cborx.Unmarshal(elems[3], &payload); err != nil {
		return Inbound{}, frameErr("E_FRAME_SHAPE", "payload: "+err.Error(), CloseDecode)
	}
	if len(payload) != spec.elements {
		return Inbound{}, frameErr("E_FRAME_SHAPE",
			fmt.Sprintf("opcode %d payload has %d elements, want %d", op, len(payload), spec.elements),
			CloseDecode)
	}
	return Inbound{Op: code, CID: cid, GroupID: gid, Payload: payload}, nil
}

// lookupOp resolves a wire opcode to its catalogue entry. An opcode is a uint8, so 256+6 is an
// unknown opcode and not a heartbeat that wrapped.
func lookupOp(op uint64) (Op, opSpec, bool) {
	if op > math.MaxUint8 {
		return 0, opSpec{}, false
	}
	code := Op(op)
	spec, ok := opSpecs[code]
	return code, spec, ok
}

func isClientOp(op Op) bool { return opSpecs[op].fromClient }

func isNull(raw cbor.RawMessage) bool { return len(raw) == 1 && raw[0] == 0xf6 }

func rawUint(raw cbor.RawMessage) (uint64, error) {
	if err := cborx.ExpectMajor(raw, cborx.MajorUint); err != nil {
		return 0, err
	}
	var v uint64
	if err := cborx.Unmarshal(raw, &v); err != nil {
		return 0, err
	}
	return v, nil
}

func rawText(raw cbor.RawMessage) (string, error) {
	if err := cborx.ExpectMajor(raw, cborx.MajorText); err != nil {
		return "", err
	}
	var v string
	if err := cborx.Unmarshal(raw, &v); err != nil {
		return "", err
	}
	return v, nil
}

func rawBytes(raw cbor.RawMessage) ([]byte, error) {
	if err := cborx.ExpectMajor(raw, cborx.MajorBytes); err != nil {
		return nil, err
	}
	var v []byte
	if err := cborx.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return v, nil
}
