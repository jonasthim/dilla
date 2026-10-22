package api

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

func TestInteractionAdmissionSharedVector(t *testing.T) {
	data, err := os.ReadFile("../../protocol/vectors/bot.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		AdmissionProof struct {
			Seed      string            `json:"seed"`
			PublicKey string            `json:"public_key"`
			Payload   string            `json:"payload_hex"`
			Proof     string            `json:"proof_hex"`
			IDs       map[string]string `json:"ids"`
			Revision  uint64            `json:"minimum_eligibility_revision"`
			NotAfter  uint64            `json:"not_after"`
		} `json:"admission_proof"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	v := corpus.AdmissionProof
	decode := func(name, value string) []byte {
		t.Helper()
		out, err := hex.DecodeString(value)
		if err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		return out
	}
	parseID := func(name string) id.ID {
		t.Helper()
		value, err := id.Parse(v.IDs[name])
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		return value
	}
	seed := decode("seed", v.Seed)
	if len(seed) != ed25519.SeedSize {
		t.Fatalf("seed length = %d", len(seed))
	}
	private := ed25519.NewKeyFromSeed(seed)
	if got := hex.EncodeToString(private.Public().(ed25519.PublicKey)); got != v.PublicKey {
		t.Fatalf("derived public key %s != vector %s", got, v.PublicKey)
	}
	payload, err := cborx.Marshal(botInteractionAdmissionPayload{
		Version: 1, AdmissionID: parseID("admission"), InstanceID: parseID("instance"),
		InstallationID: parseID("installation"), CommunityID: parseID("community"),
		BotUserID: parseID("bot_user"), BotDeviceID: parseID("bot_device"),
		ParticipantUserID: parseID("participant_user"), ParticipantDeviceID: parseID("participant_device"),
		GroupID: parseID("group"), EligibilityRevision: v.Revision, NotAfter: v.NotAfter,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(payload); got != v.Payload {
		t.Fatalf("issuer payload %s != vector %s", got, v.Payload)
	}
	signature := ed25519.Sign(private, append([]byte("dilla bot interaction admission v1\x00"), payload...))
	proof, err := cborx.Marshal([]any{payload, signature})
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(proof); got != v.Proof {
		t.Fatalf("issuer proof %s != vector %s", got, v.Proof)
	}
}
