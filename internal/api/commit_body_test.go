package api_test

import (
	"bytes"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

// protocol/01 § Joining batches at most 256 Adds into one commit, and row 5 addresses the commit's
// Welcome to each added device separately: `welcomes([[device_id, blob]])`. One Welcome for 256
// joiners is about 30 KiB (measured by join_storm_256_batched), so a full batch is about 256 copies
// of it — some 8 MiB, four times the 2 MiB the other delivery-service routes accept. The commit
// route's cap must admit the batch the protocol itself mandates, or no join storm can complete.
func TestAFullBatchOfWelcomesIsNotRefusedAsTooLarge(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	welcome := bytes.Repeat([]byte{0x5a}, 32<<10)
	welcomes := make([]any, 0, 256)
	for range 256 {
		device := id.New()
		welcomes = append(welcomes, []any{device[:], welcome})
	}
	body := mustCBOR(t, []any{h.groupEpoch(t), []byte{0x00}, []byte{0x00}, welcomes, nil})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/commit", member, body)
	if res.Code == http.StatusRequestEntityTooLarge {
		t.Fatalf("a %d-byte commit carrying 256 Welcomes was refused as too large", len(body))
	}
	// The commit itself is not a commit, so the delivery service refuses it on its own terms.
	if res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want the delivery service's 422: %s", res.Code, res.Body.String())
	}
}

// …and the raised cap is still a cap.
func TestACommitBodyAboveTheBatchCapIsTooLarge(t *testing.T) {
	h := newGroupsAPI(t)
	h.mustCreate(t)
	member := h.memberToken(t)

	body := mustCBOR(t, []any{h.groupEpoch(t), bytes.Repeat([]byte{0x00}, 17<<20), []byte{0x00},
		[]any{}, nil})
	res := h.do(t, http.MethodPost, "/v1/groups/"+h.groupID.String()+"/commit", member, body)
	if res.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 for a %d-byte body", res.Code, len(body))
	}
}
