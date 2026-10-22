package ds

import (
	"bytes"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestVerifyKind3RegistrationReplayRequiresDurableExactConsumption(t *testing.T) {
	accepted := store.BotGroupRegistrationReceipt{InstallationID: id.New(), OperationID: id.New(), UserID: id.New(), DeviceID: id.New(), CommunityID: id.New(), GroupID: id.New(), BodySHA256: bytes.Repeat([]byte{0x71}, 32), Generation: 4, Epoch: 0, NextSeq: 1, AcceptedAt: 123}
	expected := accepted
	expected.AcceptedAt = 0 // Caller supplies request identity; stored acceptance time is replayed.
	if err := verifyKind3RegistrationReplay(accepted, accepted, expected); err != nil {
		t.Fatalf("exact replay: %v", err)
	}

	wrongAdmission := accepted
	wrongAdmission.OperationID = id.New()
	if err := verifyKind3RegistrationReplay(accepted, wrongAdmission, expected); !errors.Is(err, errKind3RegistrationReplayConflict) {
		t.Fatalf("different consumed operation=%v, want conflict", err)
	}
	changedBody := expected
	changedBody.BodySHA256 = bytes.Repeat([]byte{0x72}, 32)
	if err := verifyKind3RegistrationReplay(accepted, accepted, changedBody); !errors.Is(err, errKind3RegistrationReplayConflict) {
		t.Fatalf("changed request body=%v, want conflict", err)
	}
	changedAcceptance := accepted
	changedAcceptance.AcceptedAt++
	if err := verifyKind3RegistrationReplay(accepted, changedAcceptance, expected); !errors.Is(err, errKind3RegistrationReplayConflict) {
		t.Fatalf("changed durable consumption=%v, want conflict", err)
	}
}
