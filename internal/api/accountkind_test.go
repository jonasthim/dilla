package api_test

// Task S1 part 2: the instance-signed account-kind attestation on GET /v1/users/{id}/device-list.

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

var accountKindTestKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0xa9}, ed25519.SeedSize))

func accountKindAPI(t *testing.T) (http.Handler, api.Deps) {
	t.Helper()
	return newTestAPIWired(t, func(d *api.Deps) {
		d.SignAccountKind = func(m []byte) ([]byte, error) { return ed25519.Sign(accountKindTestKey, m), nil }
	})
}

// negotiateWire records the session's wire version through POST /v1/sessions/negotiate.
func negotiateWire(t *testing.T, h http.Handler, token string, wire uint64) {
	t.Helper()
	rec := postCBORAuth(h, "/v1/sessions/negotiate", mustCBOR(t, []any{[]any{wire}, []any{uint64(1)}, []any{uint64(1)}}), token)
	if rec.Code != http.StatusOK {
		t.Fatalf("negotiate wire %d: %d %x", wire, rec.Code, rec.Body.Bytes())
	}
}

// putList stores a device-list row for user straight through the store: the GET route serves bytes
// and this test is about what it adds to them.
func putList(t *testing.T, d api.Deps, user id.ID) {
	t.Helper()
	if err := d.Repo.PutDeviceList(context.Background(), store.DeviceListRow{UserID: user, Version: 1, Blob: []byte{0x80},
		SSKSignature: make([]byte, 64), PrevHash: make([]byte, 32), Created: d.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
}

func head(t *testing.T, h http.Handler, token string, user id.ID) []any {
	t.Helper()
	rec := doAuth(h, http.MethodGet, "/v1/users/"+user.String()+"/device-list", token)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET device-list: %d %x", rec.Code, rec.Body.Bytes())
	}
	var out []any
	if err := cborx.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAWire4DeviceListHeadCarriesTheInstanceSignedAccountKind(t *testing.T) {
	h, d := accountKindAPI(t)
	reader, _, token := seedAPISession(t, d)
	negotiateWire(t, h, token, 4)
	human, _, _ := seedAPISession(t, d)
	putList(t, d, human.ID)

	got := head(t, h, token, human.ID)
	if len(got) != 5 {
		t.Fatalf("wire-4 head has %d elements, want 5", len(got))
	}
	attestation, _ := got[4].([]byte)
	pub := accountKindTestKey.Public().(ed25519.PublicKey)
	kind, err := api.VerifyAccountKindAttestation(pub, d.Instance.InstanceID, human.ID, human.UMKPub, attestation)
	if err != nil || kind != 0 {
		t.Fatalf("attested kind %d, %v; want a verifying human (0)", kind, err)
	}
	var shape []any
	if err := cborx.Unmarshal(attestation, &shape); err != nil || len(shape) != 4 || !bytes.Equal(shape[1].([]byte), d.Instance.ExternalSenderKeyID[:]) {
		t.Fatalf("attestation shape %v %v: want [1, key_id, kind, sig] naming the external-sender key", shape, err)
	}
	// Deterministic: the same account answers the same bytes, so serving is idempotent.
	if again := head(t, h, token, human.ID); !bytes.Equal(again[4].([]byte), attestation) {
		t.Fatal("a second read produced a different attestation")
	}
	// Bound to user, instance and UMK: none of them can be swapped.
	if _, err := api.VerifyAccountKindAttestation(pub, d.Instance.InstanceID, reader.ID, human.UMKPub, attestation); err == nil {
		t.Fatal("verified for another user")
	}
	if _, err := api.VerifyAccountKindAttestation(pub, id.New(), human.ID, human.UMKPub, attestation); err == nil {
		t.Fatal("verified for another instance")
	}
	if _, err := api.VerifyAccountKindAttestation(pub, d.Instance.InstanceID, human.ID, bytes.Repeat([]byte{9}, 32), attestation); err == nil {
		t.Fatal("verified for another UMK")
	}
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32)).Public().(ed25519.PublicKey)
	if _, err := api.VerifyAccountKindAttestation(other, d.Instance.InstanceID, human.ID, human.UMKPub, attestation); err == nil {
		t.Fatal("verified under another key")
	}
}

func TestABotAccountIsAttestedAsABot(t *testing.T) {
	h, d := accountKindAPI(t)
	_, _, token := seedAPISession(t, d)
	negotiateWire(t, h, token, 4)
	bot := store.UserRow{ID: id.New(), Username: "bot" + id.New().String()[:8], Display: "Bot", Kind: 1,
		UMKPub: bytes.Repeat([]byte{7}, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: d.Clock.Now().Unix()}
	if err := d.Repo.CreateUser(context.Background(), bot); err != nil {
		t.Fatal(err)
	}
	putList(t, d, bot.ID)
	got := head(t, h, token, bot.ID)
	kind, err := api.VerifyAccountKindAttestation(accountKindTestKey.Public().(ed25519.PublicKey), d.Instance.InstanceID, bot.ID, bot.UMKPub, got[4].([]byte))
	if err != nil || kind != 1 {
		t.Fatalf("Bot account attested kind %d, %v; want 1", kind, err)
	}
}

// A wire-2 or wire-3 session reads the four elements it always has (old clients decode exactly four).
func TestAnOlderWireSessionReadsTheFourElementHead(t *testing.T) {
	h, d := accountKindAPI(t)
	_, _, token := seedAPISession(t, d)
	negotiateWire(t, h, token, 3)
	user, _, _ := seedAPISession(t, d)
	putList(t, d, user.ID)
	if got := head(t, h, token, user.ID); len(got) != 4 {
		t.Fatalf("wire-3 head has %d elements, want 4", len(got))
	}
}

// Without the signer wired, a wire-4 read fails closed rather than serving a head without the
// attestation a wire-4 client requires.
func TestAWire4ReadWithoutTheSignerFailsClosed(t *testing.T) {
	h, d := newTestAPIWired(t, nil)
	_, _, token := seedAPISession(t, d)
	negotiateWire(t, h, token, 4)
	user, _, _ := seedAPISession(t, d)
	putList(t, d, user.ID)
	if rec := doAuth(h, http.MethodGet, "/v1/users/"+user.ID.String()+"/device-list", token); rec.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want 500", rec.Code)
	}
}
