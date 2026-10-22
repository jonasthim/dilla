package ds

import (
	"context"
	"crypto/ed25519"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

type authorityDeviceLists struct{}

func (authorityDeviceLists) Entries(context.Context, DeviceListVerifier, id.ID) ([]auth.ListedDevice, error) {
	return nil, nil
}
func (authorityDeviceLists) Verify(context.Context, []byte, []byte, id.ID) ([]mlswasi.DeviceListEntry, error) {
	return nil, nil
}

type authorityTxStub struct{ store.Repository }

func TestPrepareKind3PreflightEvidenceBindsAdmissionAndRegistration(t *testing.T) {
	tuple, admission, leaves, botList, participantList := validInteractionRosterFixture()
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	wire := interactionReceiptWire{Version: admission.Version, AdmissionID: admission.AdmissionID, InstanceID: tuple.InstanceID, InstallationID: tuple.InstallationID, CommunityID: tuple.CommunityID, BotUserID: tuple.BotUserID, BotDeviceID: tuple.BotDeviceID, ParticipantUserID: tuple.ParticipantUserID, ParticipantDeviceID: tuple.ParticipantDeviceID, GroupID: tuple.GroupID, EligibilityRevision: admission.EligibilityRevision, NotAfter: admission.NotAfter}
	payload, err := cborx.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(private, append([]byte(interactionAdmissionDomain), payload...))
	binding := interactionBindingForTest(t, tuple)
	registration := RegisterRequest{GroupID: tuple.GroupID, Binding: binding, GroupInfo: []byte{1}, RatchetTree: []byte{2}}
	preflight := InteractionRegistrationPreflight{Expected: tuple, MinimumEligibilityRevision: 1, ExpectedPolicyVersion: 1, ExpectedE2EEVersion: 1, ReceiptPayload: payload, ReceiptSignature: signature, PinnedInstanceKey: private.Public().(ed25519.PublicKey), BotDeviceList: botList, ParticipantDeviceList: participantList, Now: 100, Registration: registration}
	extractor := rosterExtractorFunc(func(context.Context, []byte, []byte) (AuthenticatedInteractionRegistration, error) {
		roster := make([]mlswasi.RosterLeaf, len(leaves))
		for i, leaf := range leaves {
			roster[i] = mlswasi.RosterLeaf{UserID: leaf.UserID[:], DeviceID: leaf.DeviceID[:], DSKPub: leaf.DSKPub, Tier: leaf.Tier, Kind: leaf.Kind}
		}
		return AuthenticatedInteractionRegistration{GroupID: tuple.GroupID[:], Binding: binding, LeafCount: 2, Roster: roster}, nil
	})
	evidence, err := PrepareKind3PreflightEvidence(context.Background(), extractor, preflight)
	if err != nil {
		t.Fatalf("prepare evidence: %v", err)
	}
	if evidence.admissionID != admission.AdmissionID || evidence.tuple != tuple {
		t.Fatal("evidence lost the admitted identity")
	}
	registration.GroupInfo[0] ^= 1
	if evidence.registration.GroupInfo[0] != 1 {
		t.Fatal("evidence retained caller-owned mutable request bytes")
	}

	// The opaque evidence rejects substitution before any repository read.
	session := auth.Session{UserID: tuple.BotUserID, DeviceID: tuple.BotDeviceID, TokenHash: []byte{1}, Bot: &auth.BotSessionBinding{InstallationID: tuple.InstallationID, CommunityID: tuple.CommunityID, State: store.BotInstallationReady}}
	request := evidence.registration
	request.Session = session
	d := &DS{opts: Options{Clock: clock.NewFake(time.Unix(100, 0)), DeviceLists: authorityDeviceLists{}}}
	state := RegisteredKind3State{GroupID: tuple.GroupID, Binding: binding, Generation: 1, Epoch: 0, NextSeq: 1}
	badTuple := tuple
	badTuple.ParticipantDeviceID = interactionID(101)
	if _, err := d.ValidateKind3RegistrationAuthority(context.Background(), authorityTxStub{}, session, tuple.InstallationID, interactionID(102), admission.AdmissionID, interactionID(103), badTuple, request, []byte{1}, state, evidence); err == nil {
		t.Fatal("validator accepted a participant device different from preflight")
	}
	if _, err := d.ValidateKind3RegistrationAuthority(context.Background(), authorityTxStub{}, session, interactionID(104), interactionID(102), admission.AdmissionID, interactionID(103), tuple, request, []byte{1}, state, evidence); err == nil {
		t.Fatal("validator accepted cross-installation authority")
	}
}

func TestPrepareKind3PreflightEvidenceRejectsExpiredProof(t *testing.T) {
	tuple, admission, _, botList, participantList := validInteractionRosterFixture()
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	wire := interactionReceiptWire{Version: admission.Version, AdmissionID: admission.AdmissionID, InstanceID: tuple.InstanceID, InstallationID: tuple.InstallationID, CommunityID: tuple.CommunityID, BotUserID: tuple.BotUserID, BotDeviceID: tuple.BotDeviceID, ParticipantUserID: tuple.ParticipantUserID, ParticipantDeviceID: tuple.ParticipantDeviceID, GroupID: tuple.GroupID, EligibilityRevision: admission.EligibilityRevision, NotAfter: 100}
	payload, _ := cborx.Marshal(wire)
	binding := interactionBindingForTest(t, tuple)
	preflight := InteractionRegistrationPreflight{Expected: tuple, MinimumEligibilityRevision: 1, ExpectedPolicyVersion: 1, ExpectedE2EEVersion: 1, ReceiptPayload: payload, ReceiptSignature: ed25519.Sign(private, append([]byte(interactionAdmissionDomain), payload...)), PinnedInstanceKey: private.Public().(ed25519.PublicKey), BotDeviceList: botList, ParticipantDeviceList: participantList, Now: 100, Registration: RegisterRequest{GroupID: tuple.GroupID, Binding: binding, GroupInfo: []byte{1}, RatchetTree: []byte{2}}}
	_, err := PrepareKind3PreflightEvidence(context.Background(), rosterExtractorFunc(func(context.Context, []byte, []byte) (AuthenticatedInteractionRegistration, error) {
		return AuthenticatedInteractionRegistration{GroupID: tuple.GroupID[:], Binding: binding, LeafCount: 2}, nil
	}), preflight)
	if err == nil {
		t.Fatal("expired admission proof produced authority evidence")
	}
}
