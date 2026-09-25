package api_test

// Endpoints 13 and 14 over the real mux, a real session, a real delivery service and the real wasm
// core. Nothing between the request and the guest is a double.

import (
	"context"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/server"
)

// GET /v1/groups/{id}/heal is `[epoch, next_seq, generation, need_from_seq]`. The generation is
// the instance's own, not a constant: a client compares it against the one `hello` gave it, and a
// hard-coded 1 here would make every restore invisible.
func TestHealStatusServesTheEpochTheHighWaterAndTheGeneration(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	res := h.do(t, http.MethodGet, "/v1/groups/"+h.groupID.String()+"/heal", member, nil)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var out struct {
		_           struct{} `cbor:",toarray"`
		Epoch       uint64
		NextSeq     uint64
		Generation  uint64
		NeedFromSeq uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("response: %v", err)
	}
	instance, err := h.deps.Repo.GetInstance(context.Background())
	if err != nil {
		t.Fatalf("GetInstance: %v", err)
	}
	if out.Generation != instance.Generation {
		t.Errorf("generation = %d, want the instance's %d", out.Generation, instance.Generation)
	}
	if out.NextSeq != 1 || out.NeedFromSeq != 1 {
		t.Errorf("next_seq = %d, need_from_seq = %d, want 1 and 1", out.NextSeq, out.NeedFromSeq)
	}
	if out.Epoch == 0 {
		t.Error("epoch = 0; the registered fixture is at the epoch its GroupInfo names")
	}
}

// An unknown group is 404, and the same 404 is what a non-existent id gets: the status endpoint
// says nothing a client could not already ask `GET /info` for.
func TestHealStatusOfAnUnknownGroupIsFourZeroFour(t *testing.T) {
	h := newGroupsAPI(t)
	res := h.do(t, http.MethodGet, "/v1/groups/"+h.groupID.String()+"/heal", h.session, nil)
	if res.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.Code)
	}
	if got := errorCode(t, res); got != string(server.CodeNotFound) {
		t.Fatalf("code = %s, want %s", got, server.CodeNotFound)
	}
}

// POST /v1/groups/{id}/heal takes `[group_info, tail, ratchet_tree|null]` and answers
// `[epoch, next_seq]` — that order, which is NOT the commit endpoint's `[seq, epoch]`.
func TestHealAdoptsTheUploadedGroupInfoAndAnswersEpochThenNextSeq(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	body := mustCBOR(t, []any{h.fixture.groupInfo, []any{}, nil})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/heal", member, body)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", res.Code, res.Body.String())
	}
	var out struct {
		_       struct{} `cbor:",toarray"`
		Epoch   uint64
		NextSeq uint64
	}
	if err := cborx.Unmarshal(res.Body.Bytes(), &out); err != nil {
		t.Fatalf("response: %v", err)
	}
	row, err := h.deps.Repo.GetGroup(context.Background(), h.groupID)
	if err != nil {
		t.Fatalf("GetGroup: %v", err)
	}
	if out.Epoch != row.Epoch {
		t.Errorf("epoch = %d, want the group's %d", out.Epoch, row.Epoch)
	}
	if out.NextSeq != row.Seq+1 {
		t.Errorf("next_seq = %d, want %d", out.NextSeq, row.Seq+1)
	}
}

// The 64-item bound is the request's, so it is refused as E_INVALID_REQUEST and not as a commit
// rule: the client fixes the request, it does not re-derive its group state.
func TestHealRefusesATailOverSixtyFourItems(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	tail := make([]any, 0, 65)
	for i := range 65 {
		tail = append(tail, []any{uint64(i) + 1, uint64(0), uint64(0), nil, []byte{0x01}})
	}
	body := mustCBOR(t, []any{h.fixture.groupInfo, tail, nil})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/heal", member, body)
	if res.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeInvalidRequest) {
		t.Fatalf("code = %s, want %s", got, server.CodeInvalidRequest)
	}
}

// A device that is not in the rebuilt tree cannot heal on its own word: the GroupInfo's signer is
// the leaf the healing device occupies, and a caller that occupies none is E_FORBIDDEN.
func TestHealByANonMemberIsRefused(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)

	body := mustCBOR(t, []any{h.fixture.groupInfo, []any{}, nil})
	// h.session is the CREATING session, which is not a leaf of the fixture's tree.
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/heal", h.session, body)
	if res.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403: %s", res.Code, res.Body.String())
	}
	if got := errorCode(t, res); got != string(server.CodeForbidden) {
		t.Fatalf("code = %s, want %s", got, server.CodeForbidden)
	}
}
