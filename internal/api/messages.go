package api

import (
	"net/http"
	"strconv"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// Messages is the application-ciphertext half of the delivery service's HTTP surface: endpoints 7
// (upload), 12 (catch-up), 17 (delete) and 18 (cursor) of interfaces.md §5.1.
//
// It mounts itself rather than hanging off `api.Deps`, for the same reason `Groups` does: a nil
// `*ds.DS` must not silently turn four documented routes into 501s.
type Messages struct {
	DS                 *ds.DS
	MaxCiphertextBytes int64 // zero means defaultMaxCiphertextBytes
	MaxBody            int64 // §5.3's cap for the three small routes; zero means maxCBORBody
}

// defaultMaxCiphertextBytes is the MLS ciphertext cap of the Global Constraints, 131072 bytes. The
// delivery service enforces it again on the decoded `private_message`, which is the enforcement
// that counts; the body cap here is the cheaper one, applied before the whole request is read.
const defaultMaxCiphertextBytes = 131072

func (h *Messages) maxCiphertext() int64 {
	if h.MaxCiphertextBytes == 0 {
		return defaultMaxCiphertextBytes
	}
	return h.MaxCiphertextBytes
}

func (h *Messages) max() int64 {
	if h.MaxBody == 0 {
		return maxCBORBody
	}
	return h.MaxBody
}

func (h *Messages) Register(mux *server.Mux, sessions *auth.Sessions) {
	enrolled := func(f http.HandlerFunc) http.Handler {
		return sessions.Middleware(f, auth.ScopeEnrolled)
	}
	// The ciphertext route is the one with a raised body cap; every other route uses MaxBody. The
	// cap is applied by DecodeBody's `max` argument, because plan-1a's internal/server has no
	// per-route limiting wrapper.
	mux.Handle("POST /v1/groups/{id}/message", enrolled(h.upload))
	mux.Handle("GET /v1/groups/{id}/messages", enrolled(h.list))
	mux.Handle("DELETE /v1/groups/{id}/messages/{seq}", enrolled(h.delete))
	mux.Handle("POST /v1/groups/{id}/cursor", enrolled(h.cursor))
}

type uploadRequest struct {
	_              struct{} `cbor:",toarray"`
	Epoch          uint64
	PrivateMessage []byte
}

type uploadResponse struct {
	_           struct{} `cbor:",toarray"`
	Seq         uint64
	FrankingTag []byte
	RecvTS      uint64
}

func (h *Messages) upload(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body uploadRequest
	// The 4096-byte allowance over the ciphertext cap is the CBOR framing around it: the
	// two-element array header, the epoch and the byte-string header.
	if err := server.DecodeBody(w, r, h.maxCiphertext()+4096, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	out, err := h.DS.Upload(r.Context(), session, groupID, body.Epoch, body.PrivateMessage)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, uploadResponse{
		Seq: out.Seq, FrankingTag: out.FrankingTag, RecvTS: out.RecvTS,
	}); err != nil {
		server.WriteError(w, err)
	}
}

type messageItem struct {
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

func (h *Messages) list(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// Member-only, like the other three group reads: the ciphertext, the commitments and the
	// franking tags of a group are enough to correlate membership and message timing.
	rows, err := h.DS.Messages(r.Context(), groupID, session,
		queryUint(r, "from", 0), int32(queryUint(r, "limit", 128)))
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	out := make([]messageItem, 0, len(rows))
	for _, row := range rows {
		item := messageItem{
			Seq: row.Seq, Epoch: row.Epoch, UploaderDevice: row.UploaderDevice,
			Blob: row.Blob, Commitment: row.CommitmentC, FrankingTag: row.FrankingTag,
			RecvTS: uint64(row.Created),
		}
		if row.DeletedAt != nil {
			item.Deleted = 1
		}
		out = append(out, item)
	}
	if err := server.EncodeBody(w, http.StatusOK, out); err != nil {
		server.WriteError(w, err)
	}
}

// delete is endpoint 17: the uploader deletes its own message. 204, no body.
func (h *Messages) delete(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	seq, err := strconv.ParseUint(r.PathValue("seq"), 10, 64)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "seq must be a decimal uint64"))
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.DS.DeleteMessage(r.Context(), session, groupID, seq); err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// cursor is endpoint 18: body [last_seq, last_epoch] -> 204.
func (h *Messages) cursor(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body struct {
		_         struct{} `cbor:",toarray"`
		LastSeq   uint64
		LastEpoch uint64
	}
	if err := server.DecodeBody(w, r, h.max(), &body); err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if err := h.DS.AdvanceCursor(r.Context(), session, groupID, body.LastSeq, body.LastEpoch); err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
