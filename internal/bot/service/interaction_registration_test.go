package service

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

func TestInteractionRegistrationPersistsAndReturnsPendingWelcomeAfterReceipt(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	got, err := f.coordinator.Register(context.Background(), f.request)
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if got.Receipt.OperationID.IsZero() || len(got.PendingWelcome) == 0 || got.Usable {
		t.Fatalf("result must carry a pending Welcome without claiming usability: %+v", got)
	}
	if f.n.createCalls != 1 || f.s.registerCalls != 1 || f.n.registered != 1 {
		t.Fatalf("create/register/native-resolve calls = %d/%d/%d", f.n.createCalls, f.s.registerCalls, f.n.registered)
	}
	if len(f.s.requestIDs) != 3 || f.s.requestIDs[0].IsZero() || f.s.requestIDs[0] != f.s.requestIDs[1] || f.s.requestIDs[0] != f.s.requestIDs[2] {
		t.Fatalf("admission, context, and registration request IDs differ: %v", f.s.requestIDs)
	}
}

func TestInteractionRegistrationRecoversLostResponseAfterRestartWithoutRecreate(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.storeThenLoseResponse = true
	if _, err := f.coordinator.Register(context.Background(), f.request); !errors.Is(err, ErrInteractionRegistrationOutcomeUnknown) {
		t.Fatalf("first Register error = %v, want unknown outcome", err)
	}
	f.coordinator, _ = NewInteractionRegistrationCoordinator(f.instance, f.community, f.install, f.n, f.d, f.s)
	got, err := f.coordinator.Register(context.Background(), f.request)
	if err != nil {
		t.Fatalf("restart recovery: %v", err)
	}
	if f.n.createCalls != 1 || f.s.registerCalls != 1 || f.s.receiptCalls != 3 || len(got.PendingWelcome) == 0 || got.Usable {
		t.Fatalf("recovery duplicated work or lost pending Welcome: creates=%d registers=%d receipts=%d result=%+v", f.n.createCalls, f.s.registerCalls, f.s.receiptCalls, got)
	}
}

func TestInteractionRegistrationRejectsConflictingReuse(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	_, err := f.coordinator.Register(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	conflict := f.request
	conflict.ParticipantDevice = id.New()
	if _, err := f.coordinator.Register(context.Background(), conflict); !errors.Is(err, ErrInteractionRegistrationRecovery) {
		t.Fatalf("conflicting reuse error = %v, want recovery refusal", err)
	}
	if f.n.createCalls != 1 || f.s.registerCalls != 1 {
		t.Fatalf("conflict caused side effects: create=%d register=%d", f.n.createCalls, f.s.registerCalls)
	}
}

func TestInteractionRegistrationRejectsStaleContextWithoutPosting(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.n.createErr = errors.New("snapshot expired")
	if _, err := f.coordinator.Register(context.Background(), f.request); !errors.Is(err, ErrInteractionRegistrationRecovery) {
		t.Fatalf("stale context error = %v, want fail-closed recovery", err)
	}
	if f.n.createCalls != 1 || f.s.registerCalls != 0 || f.n.registered != 0 {
		t.Fatalf("stale context side effects: create=%d register=%d native-resolve=%d", f.n.createCalls, f.s.registerCalls, f.n.registered)
	}
}

func TestInteractionRegistrationCompletedRetryDoesNotRecreate(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	if _, err := f.coordinator.Register(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	if _, err := f.coordinator.Register(context.Background(), f.request); err != nil {
		t.Fatal(err)
	}
	if f.n.createCalls != 1 {
		t.Fatalf("native create calls=%d, want 1", f.n.createCalls)
	}
}

type interactionRegistrationFixture struct {
	coordinator                                      *InteractionRegistrationCoordinator
	n                                                *interactionRegistrationNativeFake
	s                                                *interactionRegistrationSessionFake
	d                                                *interactionRegistrationDiscoveryFake
	instance, community, install, botUser, botDevice id.ID
	request                                          InteractionRegistrationRequest
}

func newInteractionRegistrationFixture(t *testing.T) *interactionRegistrationFixture {
	t.Helper()
	f := &interactionRegistrationFixture{instance: id.New(), community: id.New(), install: id.New(), botUser: id.New(), botDevice: id.New()}
	f.n = &interactionRegistrationNativeFake{binding: native.Binding{Instance: f.instance, Community: f.community, Installation: f.install}, identity: native.Identity{Phase: 2, Instance: &f.instance, User: &f.botUser, Device: &f.botDevice}}
	f.d = &interactionRegistrationDiscoveryFake{value: client.Discovery{InstanceID: f.instance, Generation: 8, PolicyVersion: 3, ExternalSenderPub: append([]byte{1}, make([]byte, 31)...), E2EEVersions: []uint64{1}, MediaVersions: []uint64{0}}}
	f.s = &interactionRegistrationSessionFake{admission: []byte{0x41}}
	f.request = InteractionRegistrationRequest{Group: id.New(), ParticipantUser: id.New(), ParticipantDevice: id.New(), MinimumEligibilityRevision: 4, ParticipantKeyPackage: []byte{1, 2, 3}}
	var err error
	f.coordinator, err = NewInteractionRegistrationCoordinator(f.instance, f.community, f.install, f.n, f.d, f.s)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func signedSnapshotFixture(t *testing.T, request id.ID) []byte {
	t.Helper()
	wire, err := makeSignedSnapshotFixture(request)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

func makeSignedSnapshotFixture(request id.ID) ([]byte, error) {
	payload, err := cborx.Marshal([]any{uint64(1), request, id.New(), []byte{1}, make([]byte, 64), uint64(100), uint64(200), uint64(4), uint64(1), uint64(0), id.New(), id.New(), make([]byte, 32), []any{}, []any{}, []any{}})
	if err != nil {
		return nil, err
	}
	return cborx.Marshal([]any{payload, make([]byte, 64)})
}

type interactionRegistrationNativeFake struct {
	binding                 native.Binding
	identity                native.Identity
	values                  map[string]native.StateValue
	createCalls, registered uint64
	createErr               error
}

func (n *interactionRegistrationNativeFake) Binding() native.Binding { return n.binding }
func (n *interactionRegistrationNativeFake) Bootstrap(context.Context, [32]byte) (native.BootstrapResult, error) {
	return native.BootstrapResult{}, nil
}
func (n *interactionRegistrationNativeFake) Identity(context.Context) (native.Identity, error) {
	return n.identity, nil
}
func (n *interactionRegistrationNativeFake) CreateInteractionGroup(_ context.Context, _ id.ID, e native.InteractionGroupExpected, _ []byte, _ []byte) (native.InteractionGroupCreateResult, error) {
	n.createCalls++
	if n.createErr != nil {
		return native.InteractionGroupCreateResult{}, n.createErr
	}
	return native.InteractionGroupCreateResult{Group: e.Group, Binding: native.InteractionGroupBinding{Instance: e.Instance, BotUser: e.BotUser, Installation: e.Installation, Community: e.Community, ParticipantUser: e.ParticipantUser, ParticipantDevice: e.ParticipantDevice, PolicyVersion: e.PolicyVersion, E2EEVersion: 1, MediaVersion: 0}, BindingBody: []byte{1}, GroupInfo: []byte{2}, RatchetTree: []byte{3}, Welcome: []byte{4}, Epoch: 1, MemberCount: 2}, nil
}
func (n *interactionRegistrationNativeFake) GroupRegistered(context.Context, id.ID, id.ID, uint64) error {
	n.registered++
	return nil
}
func (n *interactionRegistrationNativeFake) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	if n.values == nil {
		n.values = map[string]native.StateValue{}
	}
	return n.values[registrationStateMapKey(area, key)], nil
}
func (n *interactionRegistrationNativeFake) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	if n.values == nil {
		n.values = map[string]native.StateValue{}
	}
	out := make([]uint64, len(changes))
	for i, c := range changes {
		k := registrationStateMapKey(c.Area, c.Key)
		v := n.values[k]
		if v.Revision != c.ExpectedRevision {
			return nil, errors.New("state conflict")
		}
		v.Revision++
		v.Value = append([]byte(nil), c.Value...)
		n.values[k] = v
		out[i] = v.Revision
	}
	return out, nil
}

type interactionRegistrationDiscoveryFake struct{ value client.Discovery }

func (d *interactionRegistrationDiscoveryFake) Discover(context.Context) (client.Discovery, error) {
	return d.value, nil
}

type interactionRegistrationSessionFake struct {
	admission, snapshot         []byte
	registerCalls, receiptCalls uint64
	storeThenLoseResponse       bool
	hideReceiptCalls            uint64
	receipt                     *client.BotGroupRegistrationReceipt
	requestIDs                  []id.ID
}

func (s *interactionRegistrationSessionFake) IssueBotInteractionAdmission(_ context.Context, _ id.ID, request id.ID, _ id.ID, _ id.ID, _ id.ID) ([]byte, error) {
	s.requestIDs = append(s.requestIDs, request)
	return append([]byte(nil), s.admission...), nil
}
func (s *interactionRegistrationSessionFake) BotInteractionContextSnapshot(_ context.Context, _ id.ID, request id.ID, _ id.ID, _ id.ID, _ id.ID) ([]byte, error) {
	s.requestIDs = append(s.requestIDs, request)
	return makeSignedSnapshotFixture(request)
}
func (s *interactionRegistrationSessionFake) RegisterBotGroupWithAdmissionRequest(_ context.Context, _ id.ID, op id.ID, generation uint64, body []byte, admissionRequest id.ID) (client.BotGroupRegistrationReceipt, error) {
	s.requestIDs = append(s.requestIDs, admissionRequest)
	s.registerCalls++
	var a []any
	if err := cborx.Unmarshal(body, &a); err != nil || len(a) != 5 {
		return client.BotGroupRegistrationReceipt{}, errors.New("bad interaction body")
	}
	group, ok := registrationID(a[0])
	if !ok {
		return client.BotGroupRegistrationReceipt{}, errors.New("bad group")
	}
	r := client.BotGroupRegistrationReceipt{OperationID: op, GroupID: group, RegistrationSHA256: interactionRegistrationHash(body), AcceptedGeneration: generation, InitialEpoch: 1, NextSequence: 1}
	s.receipt = &r
	if s.storeThenLoseResponse {
		s.hideReceiptCalls = 1
		return client.BotGroupRegistrationReceipt{}, errors.New("response lost")
	}
	return r, nil
}
func (s *interactionRegistrationSessionFake) BotGroupRegistrationReceipt(context.Context, id.ID, id.ID) (client.BotGroupRegistrationReceipt, error) {
	s.receiptCalls++
	if s.hideReceiptCalls > 0 {
		s.hideReceiptCalls--
		return client.BotGroupRegistrationReceipt{}, client.ErrRegistrationReceiptNotFound
	}
	if s.receipt == nil {
		return client.BotGroupRegistrationReceipt{}, client.ErrRegistrationReceiptNotFound
	}
	return *s.receipt, nil
}
func (s *interactionRegistrationSessionFake) GroupInfo(context.Context, id.ID) (client.GroupInfo, error) {
	return client.GroupInfo{}, &client.APIError{Status: http.StatusNotFound, Code: "E_NOT_FOUND"}
}

var _ = native.StateValue{}
