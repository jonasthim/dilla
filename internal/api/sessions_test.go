package api_test

import (
	"crypto/ed25519"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// The challenge answer is identical for an unknown device: the route is
// unauthenticated, so a different answer would make it a device-enumeration
// oracle (protocol/02 § Device sessions item 1).
func TestTheChallengeRouteIsNotAnEnumerationOracle(t *testing.T) {
	h, deps := newTestAPI(t)
	_, device, _ := seedAPIDevice(t, deps)

	known := postCBOR(h, "/v1/devices/"+device.ID.String()+"/sessions/challenge", nil)
	unknown := postCBOR(h, "/v1/devices/"+id.New().String()+"/sessions/challenge", nil)
	if known.Code != http.StatusCreated || unknown.Code != http.StatusCreated {
		t.Fatalf("challenge answered %d for a known device and %d for an unknown one",
			known.Code, unknown.Code)
	}
	var a, b []any
	if err := cborx.Unmarshal(known.Body.Bytes(), &a); err != nil {
		t.Fatalf("decode known: %v", err)
	}
	if err := cborx.Unmarshal(unknown.Body.Bytes(), &b); err != nil {
		t.Fatalf("decode unknown: %v", err)
	}
	if len(a) != 2 || len(b) != 2 {
		t.Fatalf("challenge response has %d/%d elements, want [nonce, expires]", len(a), len(b))
	}
	if n, _ := a[0].([]byte); len(n) != 32 {
		t.Fatalf("nonce is %d bytes, want 32", len(n))
	}
	if a[1] != b[1] {
		t.Fatal("the expiry differs between a known and an unknown device")
	}
}

// The establish body is the five-element array of protocol/02 § Device sessions
// item 2, and the answer is the seven-element array of the same item.
func TestEstablishTakesFiveElementsAndAnswersSeven(t *testing.T) {
	h, deps := newTestAPI(t)
	_, device, priv := seedAPIDevice(t, deps)

	rec := postCBOR(h, "/v1/devices/"+device.ID.String()+"/sessions/challenge", nil)
	var challenge []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	nonce, _ := challenge[0].([]byte)
	pre := auth.SessionPreimage(deps.Instance.InstanceID, device.ID, nonce, auth.PurposeSession)
	body, _ := cborx.Marshal([]any{nonce, uint64(auth.PurposeSession), ed25519.Sign(priv, pre), nil, nil})

	rec = postCBOR(h, "/v1/devices/"+device.ID.String()+"/sessions", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("establish = %d, want 201; body %x", rec.Code, rec.Body.Bytes())
	}
	var out []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out) != 7 {
		t.Fatalf("establish response has %d elements, want 7", len(out))
	}
	if out[1] != uint64(auth.ScopeEnrolled) {
		t.Fatalf("scope = %v, want 0 (enrolled)", out[1])
	}
	if out[6] != deps.Instance.Generation {
		t.Fatalf("generation = %v, want the instance's %d", out[6], deps.Instance.Generation)
	}
	if got := rec.Header().Get("X-Dilla-Generation"); got == "" {
		t.Fatal("the establish response carries no X-Dilla-Generation header")
	}
}

// A body of the wrong length is E_INVALID_REQUEST, never a partial read.
func TestEstablishRefusesAWrongLengthBody(t *testing.T) {
	h, deps := newTestAPI(t)
	_, device, _ := seedAPIDevice(t, deps)
	body, _ := cborx.Marshal([]any{make([]byte, 32), uint64(0), make([]byte, 64)})
	rec := postCBOR(h, "/v1/devices/"+device.ID.String()+"/sessions", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a three-element establish body gave %d, want 400", rec.Code)
	}
}

// The ticket route exists and is honest about not being wired until part 1b.
func TestTheGatewayTicketRouteIsReservedUntilPartOneB(t *testing.T) {
	h, deps := newTestAPI(t)
	_, _, token := seedAPISession(t, deps)
	rec := postCBORAuth(h, "/v1/gateway/ticket", nil, token)
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("POST /v1/gateway/ticket = %d, want 501 while Deps.Tickets is nil", rec.Code)
	}
}
