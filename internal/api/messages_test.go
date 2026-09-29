package api_test

// The four application-ciphertext routes of interfaces.md §5.1 — rows 7 (upload), 12 (catch-up),
// 17 (delete) and 18 (cursor) — end to end over the same mux, sessions, delivery service and real
// wasm core groups_test.go stands up. Nothing between the request and the guest is a double.

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// Endpoint 7's response is the three-element array [seq, franking_tag, recv_ts] — the epoch is NOT
// on the wire (deviation B14), so a fourth element would be a contract break.
func TestUploadAnswersSeqTheFrankingTagAndRecvTS(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/message", member,
		h.uploadBody(t, 64))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var raw []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	if len(raw) != 3 {
		t.Fatalf("the upload response has %d elements, want 3: [seq, franking_tag, recv_ts]", len(raw))
	}
	var out struct {
		_           struct{} `cbor:",toarray"`
		Seq         uint64
		FrankingTag []byte
		RecvTS      uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode the response: %v", err)
	}
	if out.Seq != 1 {
		t.Errorf("seq = %d, want 1 — the first allocation of the group's one seq space", out.Seq)
	}
	if len(out.FrankingTag) != 32 {
		t.Errorf("franking_tag is %d bytes, want 32", len(out.FrankingTag))
	}
	if out.RecvTS == 0 {
		t.Error("recv_ts is 0")
	}
}

// A body over the ciphertext cap plus its CBOR framing is 413 E_TOO_LARGE, with protocol/02's
// error array in the body. DecodeBody RETURNS its refusal and writes nothing, so a handler that
// dropped the error would answer 200 with an empty body instead (deviation D5).
func TestAnOversizeUploadIsFourOneThreeAndCarriesTheErrorBody(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	body := mustCBOR(t, []any{h.groupEpoch(t), bytes.Repeat([]byte{7}, 140000)})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/message", member, body)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeTooLarge) {
		t.Fatalf("code = %s, want %s", got, server.CodeTooLarge)
	}
}

// Endpoint 12's row is the eight-element [seq, epoch, uploader_device, blob, commitment,
// franking_tag, recv_ts, deleted]. A tombstone keeps its place in the stream with a null blob and
// deleted = 1; everything else survives, which is what makes the seq stream dense after a delete.
func TestTheCatchUpCarriesTheRowShapeAndTheTombstone(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	h.mustUpload(t, member, 64)
	second := h.mustUpload(t, member, 96)

	res := h.do(t, http.MethodDelete,
		"/v1/groups/"+h.groupID.String()+"/messages/1", member, nil)
	if res.Code != http.StatusNoContent {
		t.Fatalf("delete: status = %d, want 204: %s", res.Code, res.Body.String())
	}

	res = h.do(t, http.MethodGet, "/v1/groups/"+h.groupID.String()+"/messages?from=0", member, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var raw []any
	if err := cborx.Unmarshal(res.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode the array: %v", err)
	}
	if len(raw) != 2 {
		t.Fatalf("got %d rows, want the tombstone and the surviving message", len(raw))
	}
	row0, ok := raw[0].([]any)
	if !ok || len(row0) != 8 {
		t.Fatalf("row 0 is %v, want an eight-element array", raw[0])
	}
	if row0[3] != nil {
		t.Errorf("the tombstone's blob is %T, want null", row0[3])
	}

	var rows []struct {
		_              struct{} `cbor:",toarray"`
		Seq            uint64
		Epoch          uint64
		UploaderDevice id.ID
		Blob           []byte
		Commitment     []byte
		FrankingTag    []byte
		RecvTS         uint64
		Deleted        uint8
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode the rows: %v", err)
	}
	if rows[0].Seq != 1 || rows[0].Deleted != 1 {
		t.Errorf("row 0 = seq %d deleted %d, want seq 1 deleted 1", rows[0].Seq, rows[0].Deleted)
	}
	if rows[0].Blob != nil {
		t.Error("a tombstone keeps no ciphertext")
	}
	if len(rows[0].Commitment) != 32 || len(rows[0].FrankingTag) != 32 {
		t.Errorf("the tombstone lost its commitment (%d bytes) or its tag (%d bytes)",
			len(rows[0].Commitment), len(rows[0].FrankingTag))
	}
	if rows[0].Epoch == 0 || rows[0].RecvTS == 0 {
		t.Error("the tombstone lost its epoch or its recv_ts")
	}
	if rows[1].Seq != 2 || rows[1].Deleted != 0 {
		t.Errorf("row 1 = seq %d deleted %d, want seq 2 deleted 0", rows[1].Seq, rows[1].Deleted)
	}
	if !bytes.Equal(rows[1].Blob, second.pm) {
		t.Error("row 1 served a ciphertext the uploader did not send")
	}
	if rows[1].UploaderDevice == (id.ID{}) {
		t.Error("row 1 has no uploader_device")
	}
}

// R29 over the wire: only the uploading USER may delete, so an enrolled session of another account
// is 403 E_NOT_UPLOADER — not 404, because the message's existence is not what is being hidden.
func TestADeleteByAnotherUserIsFourZeroThreeNotUploader(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)
	h.mustUpload(t, member, 64)

	// h.session is an enrolled session of a DIFFERENT user, and not a leaf of the group.
	res := h.do(t, http.MethodDelete,
		"/v1/groups/"+h.groupID.String()+"/messages/1", h.session, nil)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeNotUploader) {
		t.Fatalf("code = %s, want %s", got, server.CodeNotUploader)
	}
}

// R33: a malformed path value is E_INVALID_REQUEST at the edge and never reaches the database.
func TestADeleteWithANonNumericSeqIsFourHundred(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	res := h.do(t, http.MethodDelete,
		"/v1/groups/"+h.groupID.String()+"/messages/nineteen", member, nil)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeInvalidRequest) {
		t.Fatalf("code = %s, want %s", got, server.CodeInvalidRequest)
	}
}

// Endpoint 18 is [last_seq, last_epoch] -> 204 with no body, and the row it writes is the one
// MinCursor reads.
func TestTheCursorRouteAnswersTwoZeroFourAndWritesTheRow(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)
	h.mustUpload(t, member, 64)

	body := mustCBOR(t, []any{uint64(1), h.groupEpoch(t)})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/cursor", member, body)
	if res.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", res.Code, res.Body.String())
	}
	if res.Body.Len() != 0 {
		t.Errorf("a 204 carried %d bytes of body", res.Body.Len())
	}
	device := h.memberDevice(t)
	cur, err := h.deps.Repo.GetCursor(context.Background(), device, h.groupID)
	if err != nil {
		t.Fatalf("GetCursor: %v", err)
	}
	if cur.LastSeq != 1 {
		t.Errorf("last_seq = %d, want 1", cur.LastSeq)
	}
}

// A zero-valued Messages must still serve: both caps reach http.MaxBytesReader, where a limit of 0
// refuses every body including an empty one, so the zero value has to mean "the default"
// (deviation D6). Nothing in the struct is set here on purpose.
func TestAZeroValuedMessagesFallsBackToTheDefaultCaps(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	mux := server.NewMux()
	(&api.Messages{DS: h.ds}).Register(mux, h.deps.Sessions)

	res := doOn(t, mux, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/message", member,
		h.uploadBody(t, 64))
	if res.Code != http.StatusOK {
		t.Fatalf("upload: status = %d, want 200 — a zero MaxCiphertextBytes refused the body: %s",
			res.Code, res.Body.String())
	}
	body := mustCBOR(t, []any{uint64(1), h.groupEpoch(t)})
	res = doOn(t, mux, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/cursor", member, body)
	if res.Code != http.StatusNoContent {
		t.Fatalf("cursor: status = %d, want 204 — a zero MaxBody refused the body: %s",
			res.Code, res.Body.String())
	}
}

// ------------------------------------------------------------------ harness

// uploaded is what mustUpload hands back: the seq the instance allocated and the exact ciphertext
// it was given, so the catch-up can be compared against the bytes rather than against a length.
type uploaded struct {
	seq uint64
	pm  []byte
}

func (h *groupsAPI) groupEpoch(t *testing.T) uint64 {
	t.Helper()
	row, err := h.deps.Repo.GetGroup(context.Background(), h.groupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	return row.Epoch
}

// memberDevice is the device behind memberToken: leaf 0 of the committed fixture.
func (h *groupsAPI) memberDevice(t *testing.T) id.ID {
	t.Helper()
	members, err := h.deps.Repo.ListMembers(context.Background(), h.groupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(members) == 0 {
		t.Fatal("the registered group has no member rows")
	}
	return members[0].DeviceID
}

// uploadBody is endpoint 7's [epoch, private_message] for a well-formed message at the group's own
// epoch.
func (h *groupsAPI) uploadBody(t *testing.T, ctLen int) []byte {
	t.Helper()
	epoch := h.groupEpoch(t)
	return mustCBOR(t, []any{epoch, apiPrivateMessage(t, epoch, ctLen)})
}

func (h *groupsAPI) mustUpload(t *testing.T, token string, ctLen int) uploaded {
	t.Helper()
	epoch := h.groupEpoch(t)
	pm := apiPrivateMessage(t, epoch, ctLen)
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/message", token,
		mustCBOR(t, []any{epoch, pm}))
	if res.Code != http.StatusOK {
		t.Fatalf("upload: status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var out struct {
		_           struct{} `cbor:",toarray"`
		Seq         uint64
		FrankingTag []byte
		RecvTS      uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("upload response: %v", err)
	}
	return uploaded{seq: out.Seq, pm: pm}
}

func doOn(t *testing.T, mux *server.Mux, method, path, token string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == nil {
		req = httptest.NewRequestWithContext(t.Context(), method, path, nil)
	} else {
		req = httptest.NewRequestWithContext(t.Context(), method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/cbor")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// apiPrivateMessage frames RFC 9420 §6.3.2's MLSMessage/PrivateMessage by hand, as
// core/dilla-core-wasi/src/private_message.rs's own tests_support::message does. The guest parses
// the header without decrypting — the delivery service holds no group secrets — so a real
// ciphertext is neither needed nor possible here. It is the same framing internal/ds's harness
// uses; the two packages cannot share an unexported test helper.
func apiPrivateMessage(t *testing.T, epoch uint64, ctLen int) []byte {
	t.Helper()
	var out []byte
	out = binary.BigEndian.AppendUint16(out, 1) // protocol_version: MLS 1.0
	out = binary.BigEndian.AppendUint16(out, 2) // wire_format: PrivateMessage
	out = appendVL(t, out, []byte("group-id"))
	out = binary.BigEndian.AppendUint64(out, epoch)
	out = append(out, 1) // content_type: application
	out = appendVL(t, out, bytes.Repeat([]byte{5}, 32))
	out = appendVL(t, out, bytes.Repeat([]byte{7}, 16))
	out = appendVL(t, out, bytes.Repeat([]byte{9}, ctLen))
	return out
}

// appendVL writes RFC 9420 §2.1.3's variable-length header — RFC 9000's varint, whose two top bits
// give the width, in the shortest form that carries the value — and then the payload.
func appendVL(t *testing.T, dst, v []byte) []byte {
	t.Helper()
	switch {
	case len(v) < 64:
		dst = append(dst, byte(len(v)))
	case len(v) < 16384:
		dst = binary.BigEndian.AppendUint16(dst, uint16(len(v))|0x4000)
	default:
		t.Fatalf("appendVL: %d bytes is past the two-byte form", len(v))
	}
	return append(dst, v...)
}
