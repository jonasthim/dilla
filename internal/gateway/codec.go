package gateway

import (
	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// payload encodes a fixed-position payload array once. Every producer in the delivery service
// calls one of the helpers below, so no call site hand-rolls an array length.
func payload(items ...any) (cbor.RawMessage, error) {
	b, err := cborx.Marshal(items)
	if err != nil {
		return nil, err
	}
	return cbor.RawMessage(b), nil
}

// HelloPayload is the first frame the instance sends on every connection.
func HelloPayload(wire, e2ee, media []uint64, heartbeatMS, maxFrameBytes uint64, instanceID id.ID, generation uint64) (cbor.RawMessage, error) {
	return payload(wire, e2ee, media, heartbeatMS, maxFrameBytes, instanceID, generation)
}

// GroupDigest is one entry of ready's per-group catch-up list.
type GroupDigest struct {
	GroupID              id.ID
	Epoch                uint64
	LastSeq              uint64
	ProposalsOutstanding uint64
}

func ReadyPayload(deviceID, userID id.ID, generation uint64, resumeToken []byte, wire, e2ee, media uint64, keypackagesRemaining uint64, groups []GroupDigest) (cbor.RawMessage, error) {
	rows := make([]any, 0, len(groups))
	for _, g := range groups {
		rows = append(rows, []any{g.GroupID, g.Epoch, g.LastSeq, g.ProposalsOutstanding})
	}
	return payload(deviceID, userID, generation, resumeToken, wire, e2ee, media, keypackagesRemaining, rows)
}

// ResumedPayload answers a resume. resumeToken is the ROTATED token, not the one the client just
// spent: the instance discards a token the moment it is used, so this frame is the only place a
// client learns the credential its next resume must carry.
func ResumedPayload(from, to uint64, resumeToken []byte) (cbor.RawMessage, error) {
	return payload(from, to, resumeToken)
}

func InvalidSessionPayload(resumable bool, reason string) (cbor.RawMessage, error) {
	return payload(boolUint(resumable), reason)
}

func HeartbeatAckPayload(serverTS uint64) (cbor.RawMessage, error) { return payload(serverTS) }

func ReconnectPayload(reason string, afterMS uint64) (cbor.RawMessage, error) {
	return payload(reason, afterMS)
}

func ErrorPayload(cid uint64, code, detail string) (cbor.RawMessage, error) {
	return payload(cid, code, detail)
}

// HandshakePayload is op 16. sender is the leaf index, or nil for the instance's external sender
// (protocol/02, "Handshake records").
func HandshakePayload(seq, epoch uint64, kind uint8, sender *uint32, blob []byte) (cbor.RawMessage, error) {
	return payload(seq, epoch, uint64(kind), optUint(sender), blob)
}

// CommitNeededPayload is op 17. deadlineMS is relative to the moment the frame reaches the
// connection's writer; the writer re-bases it (R31, interfaces §0.1 D11).
func CommitNeededPayload(epoch uint64, refs [][]byte, deadlineMS, round uint64) (cbor.RawMessage, error) {
	return payload(epoch, refs, deadlineMS, round)
}

func EpochChangedPayload(epoch, seq uint64) (cbor.RawMessage, error) { return payload(epoch, seq) }

func MessageCTPayload(seq, epoch uint64, uploader id.ID, blob, frankingTag []byte, recvTS uint64) (cbor.RawMessage, error) {
	return payload(seq, epoch, uploader, blob, frankingTag, recvTS)
}

func WelcomePayload(welcomeID, epoch, commitSeq uint64, blob, ratchetTree, treeHash []byte) (cbor.RawMessage, error) {
	return payload(welcomeID, epoch, commitSeq, blob, ratchetTree, treeHash)
}

func MessageDeletedPayload(seq, deletedAt uint64) (cbor.RawMessage, error) {
	return payload(seq, deletedAt)
}

func PresencePayload(userID id.ID, status uint64, sinceTS uint64, statusMsg string) (cbor.RawMessage, error) {
	return payload(userID, status, sinceTS, statusMsg)
}

func TypingPayload(userID, deviceID id.ID, typing bool, expiresTS uint64) (cbor.RawMessage, error) {
	return payload(userID, deviceID, boolUint(typing), expiresTS)
}

func VoiceStatePayload(userID, deviceID, callID id.ID, flags uint64) (cbor.RawMessage, error) {
	return payload(userID, deviceID, callID, flags)
}

// The deterministic-CBOR subset has no boolean; flags travel as uint 0 or 1.
func boolUint(b bool) uint64 {
	if b {
		return 1
	}
	return 0
}

func optUint(v *uint32) any {
	if v == nil {
		return nil
	}
	return uint64(*v)
}
