package ds

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
)

const interactionAdmissionDomain = "dilla bot interaction admission v1\x00"
const maxInteractionAdmissionPayload = 250

// AuthenticatedInteractionRegistration contains identity and scope read back from the imported
// MLS group, plus the credential-authenticated roster. LeafCount includes every occupied MLS leaf,
// including leaves the roster extractor cannot decode as dilla identities.
type AuthenticatedInteractionRegistration struct {
	GroupID   []byte
	Binding   []byte
	LeafCount uint64
	Roster    []mlswasi.RosterLeaf
}

// InteractionRegistrationExtractor must import the submitted GroupInfo/tree through WASI and
// return both authenticated public group state and the authenticated roster.
type InteractionRegistrationExtractor interface {
	ExtractInteractionRegistration(context.Context, []byte, []byte) (AuthenticatedInteractionRegistration, error)
}

// WASIInteractionRegistrationExtractor adapts an acquired WASI instance to the preflight contract.
type WASIInteractionRegistrationExtractor struct {
	Instance *mlswasi.Instance
}

func (w WASIInteractionRegistrationExtractor) ExtractInteractionRegistration(ctx context.Context, tree, info []byte) (AuthenticatedInteractionRegistration, error) {
	if w.Instance == nil {
		return AuthenticatedInteractionRegistration{}, errors.New("ds: kind-3 registration preflight has no WASI instance")
	}
	roster, err := w.Instance.ExtractAuthenticatedRoster(ctx, tree, info)
	if err != nil {
		return AuthenticatedInteractionRegistration{}, err
	}
	group, err := w.Instance.PublicGroupFromExternal(ctx, tree, info)
	if err != nil {
		return AuthenticatedInteractionRegistration{}, err
	}
	defer group.Close(ctx)
	state, err := group.State(ctx)
	if err != nil {
		return AuthenticatedInteractionRegistration{}, err
	}
	return AuthenticatedInteractionRegistration{GroupID: append([]byte(nil), state.GroupID...), Binding: append([]byte(nil), state.Binding...), LeafCount: state.LeafCount, Roster: roster}, nil
}

// InteractionRegistrationPreflight is the complete trusted-input contract for examining a
// proposed kind-3 group. Receipt fields are verified against PinnedInstanceKey; Expected,
// MinimumEligibilityRevision and device-list entries must be fetched and verified by the server
// under the current installation/eligibility fence. This preflight does not persist or authorize
// registration.
type InteractionRegistrationPreflight struct {
	Expected                   InteractionAdmissionTuple
	MinimumEligibilityRevision uint64
	ExpectedPolicyVersion      uint64
	ExpectedE2EEVersion        uint64
	ExpectedMediaVersion       uint64
	ReceiptPayload             []byte
	ReceiptSignature           []byte
	PinnedInstanceKey          ed25519.PublicKey
	BotDeviceList              []mlswasi.DeviceListEntry
	ParticipantDeviceList      []mlswasi.DeviceListEntry
	Now                        uint64
	Registration               RegisterRequest
}

type interactionAdmissionWire struct {
	_                   struct{} `cbor:",toarray"`
	Version             uint64
	AdmissionID         id.ID
	InstanceID          id.ID
	InstallationID      id.ID
	CommunityID         id.ID
	BotUserID           id.ID
	BotDeviceID         id.ID
	ParticipantUserID   id.ID
	ParticipantDeviceID id.ID
	GroupID             id.ID
	EligibilityRevision uint64
	NotAfter            uint64
}

type interactionBindingV2 struct {
	_                   struct{} `cbor:",toarray"`
	Version             uint64
	InstanceID          id.ID
	LegacyCommunityID   *id.ID
	BotUserID           id.ID
	Kind                uint8
	PolicyVersion       uint64
	E2EEVersion         uint64
	MediaVersion        uint64
	InstallationID      id.ID
	CommunityID         id.ID
	ParticipantUserID   id.ID
	ParticipantDeviceID id.ID
}

// PreflightKind3Registration authenticates the server-issued admission receipt, checks that the
// exact submitted registration is its kind-3 group, extracts authenticated MLS leaves through the
// supplied WASI instance, and applies VerifyInteractionRoster. It is deliberately a preflight only:
// the caller still needs transaction-fenced account, membership, ban, receipt-consumption,
// idempotency and recovery authorization before registration can be enabled.
func PreflightKind3Registration(ctx context.Context, extractor InteractionRegistrationExtractor, r InteractionRegistrationPreflight) error {
	if extractor == nil {
		return errors.New("ds: kind-3 registration preflight has no WASI roster extractor")
	}
	if len(r.PinnedInstanceKey) != ed25519.PublicKeySize || len(r.ReceiptSignature) != ed25519.SignatureSize || len(r.ReceiptPayload) == 0 || len(r.ReceiptPayload) > maxInteractionAdmissionPayload {
		return errors.New("ds: kind-3 registration preflight has no valid pinned receipt material")
	}
	if r.ExpectedPolicyVersion == 0 || r.ExpectedE2EEVersion != 1 || r.ExpectedMediaVersion != 0 {
		return errors.New("ds: kind-3 registration preflight has invalid trusted binding versions")
	}
	if !ed25519.Verify(r.PinnedInstanceKey, append([]byte(interactionAdmissionDomain), r.ReceiptPayload...), r.ReceiptSignature) {
		return errors.New("ds: interaction admission receipt signature is invalid")
	}
	var wire interactionAdmissionWire
	if err := cborx.Unmarshal(r.ReceiptPayload, &wire); err != nil {
		return fmt.Errorf("ds: decode interaction admission receipt: %w", err)
	}
	canonical, err := cborx.Marshal(wire)
	if err != nil || !bytes.Equal(canonical, r.ReceiptPayload) {
		return errors.New("ds: interaction admission receipt is not canonical")
	}
	admission := InteractionAdmission{
		Version:     wire.Version,
		AdmissionID: wire.AdmissionID,
		InteractionAdmissionTuple: InteractionAdmissionTuple{
			InstanceID: wire.InstanceID, InstallationID: wire.InstallationID, CommunityID: wire.CommunityID,
			BotUserID: wire.BotUserID, BotDeviceID: wire.BotDeviceID,
			ParticipantUserID: wire.ParticipantUserID, ParticipantDeviceID: wire.ParticipantDeviceID,
			GroupID: wire.GroupID,
		},
		EligibilityRevision: wire.EligibilityRevision,
		NotAfter:            wire.NotAfter,
	}
	if r.Registration.GroupID != r.Expected.GroupID {
		return errors.New("ds: submitted registration group does not match trusted interaction group")
	}
	var binding interactionBindingV2
	if err := cborx.Unmarshal(r.Registration.Binding, &binding); err != nil || binding.Version != 2 || binding.LegacyCommunityID != nil || binding.Kind != 3 || binding.InstanceID != r.Expected.InstanceID || binding.BotUserID != r.Expected.BotUserID || binding.InstallationID != r.Expected.InstallationID || binding.CommunityID != r.Expected.CommunityID || binding.ParticipantUserID != r.Expected.ParticipantUserID || binding.ParticipantDeviceID != r.Expected.ParticipantDeviceID || binding.PolicyVersion != r.ExpectedPolicyVersion || binding.E2EEVersion != r.ExpectedE2EEVersion || binding.MediaVersion != r.ExpectedMediaVersion {
		return errors.New("ds: submitted registration binding is not the admitted kind-3 group")
	}
	if len(r.Registration.GroupInfo) == 0 || len(r.Registration.RatchetTree) == 0 {
		return errors.New("ds: submitted registration is missing GroupInfo or ratchet tree")
	}
	actual, err := extractor.ExtractInteractionRegistration(ctx, r.Registration.RatchetTree, r.Registration.GroupInfo)
	if err != nil {
		return fmt.Errorf("ds: authenticate kind-3 registration roster: %w", err)
	}
	if !bytes.Equal(actual.GroupID, r.Expected.GroupID[:]) || !bytes.Equal(actual.Binding, r.Registration.Binding) || actual.LeafCount != 2 {
		return errors.New("ds: authenticated MLS group id, binding, or occupied leaf count does not match the admitted registration")
	}
	leaves := make([]AuthenticatedInteractionLeaf, len(actual.Roster))
	for i, leaf := range actual.Roster {
		if len(leaf.UserID) != len(id.ID{}) || len(leaf.DeviceID) != len(id.ID{}) {
			return fmt.Errorf("ds: authenticated roster leaf %d has invalid identity length", i)
		}
		var userID, deviceID id.ID
		copy(userID[:], leaf.UserID)
		copy(deviceID[:], leaf.DeviceID)
		leaves[i] = AuthenticatedInteractionLeaf{UserID: userID, DeviceID: deviceID, DSKPub: append([]byte(nil), leaf.DSKPub...), Tier: leaf.Tier, Kind: leaf.Kind}
	}
	return VerifyInteractionRoster(r.Expected, r.MinimumEligibilityRevision, admission, leaves, r.BotDeviceList, r.ParticipantDeviceList, r.Now)
}
