package service

import (
	"bytes"
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

func TestInteractionRegistrationRenewsExpiredAdmissionAfterProvenLostResponse(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.dropRegistrationResponse = true
	if _, err := f.coordinator.Register(context.Background(), f.request); !errors.Is(err, ErrInteractionRegistrationOutcomeUnknown) {
		t.Fatalf("first Register error = %v, want unknown outcome", err)
	}
	oldOperation, oldAdmission := f.s.lastOperation, f.s.requestIDs[0]
	f.s.currentTime = 131 // old admission expired at 130
	if _, err := f.coordinator.Register(context.Background(), f.request); !errors.Is(err, ErrInteractionRegistrationRenewed) {
		t.Fatalf("safe renewal result = %v, want renewal staged", err)
	}
	value, err := f.n.StateGet(context.Background(), interactionRegistrationStateArea, interactionRegistrationKey(f.request.Group))
	if err != nil {
		t.Fatal(err)
	}
	renewed, err := decodeInteractionRegistrationIntent(value.Value)
	if err != nil || renewed.Operation == oldOperation || renewed.AdmissionRequest == oldAdmission || renewed.Submitted {
		t.Fatalf("renewal did not stage fresh operation/admission: intent=%+v err=%v", renewed, err)
	}
	f.s.dropRegistrationResponse = false
	if _, err := f.coordinator.Register(context.Background(), f.request); err != nil {
		t.Fatalf("Register renewed intent: %v", err)
	}
	if f.s.registerCalls != 2 || f.n.createCalls != 2 {
		t.Fatalf("renewal must create and submit one fresh body: posts=%d native creates=%d", f.s.registerCalls, f.n.createCalls)
	}
	value, err = f.n.StateGet(context.Background(), interactionRegistrationStateArea, interactionRegistrationKey(f.request.Group))
	if err != nil {
		t.Fatal(err)
	}
	intent, err := decodeInteractionRegistrationIntent(value.Value)
	if err != nil || intent.Operation == oldOperation || intent.AdmissionRequest == oldAdmission || intent.Phase != 2 {
		t.Fatalf("renewed intent did not complete with fresh IDs: %+v err=%v", intent, err)
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

func TestInteractionRegistrationObtainsExactPackageAfterServerContext(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.request.MinimumEligibilityRevision = 0
	f.request.ParticipantKeyPackage = nil
	f.s.keyPackage = []byte{9, 8, 7}

	got, err := f.coordinator.Register(context.Background(), f.request)
	if err != nil {
		t.Fatalf("Register without caller-supplied package: %v", err)
	}
	if got.Usable || f.s.keyPackageCalls != 1 || f.n.createCalls != 1 || !bytes.Equal(f.n.createdKeyPackage, f.s.keyPackage) {
		t.Fatalf("registration did not use the exact fetched package: result=%+v keypackage_calls=%d create_calls=%d", got, f.s.keyPackageCalls, f.n.createCalls)
	}
	if f.n.createdExpected.MinimumEligibilityRevision != 4 {
		t.Fatalf("native create minimum eligibility revision = %d, want server snapshot revision 4", f.n.createdExpected.MinimumEligibilityRevision)
	}
}

func TestInteractionRegistrationFailsClosedWhenPackageReadFails(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.request.MinimumEligibilityRevision = 0
	f.request.ParticipantKeyPackage = nil
	f.s.keyPackageErr = errors.New("package unavailable")

	if _, err := f.coordinator.Register(context.Background(), f.request); err == nil {
		t.Fatal("Register succeeded without an exact participant KeyPackage")
	}
	if f.s.keyPackageCalls != 1 || f.n.createCalls != 0 || f.s.registerCalls != 0 {
		t.Fatalf("missing package did not fail closed: keypackage_calls=%d create_calls=%d register_calls=%d", f.s.keyPackageCalls, f.n.createCalls, f.s.registerCalls)
	}
}

func TestInteractionRegistrationSnapshotProviderUsesPersistedBinding(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	if _, err := f.coordinator.Register(context.Background(), f.request); err != nil {
		t.Fatalf("Register: %v", err)
	}
	event := native.GroupEvent{Group: f.request.Group, Community: f.community, SenderUser: f.request.ParticipantUser, SenderDevice: f.request.ParticipantDevice}
	expected, wire, err := f.coordinator.InteractionSnapshot(context.Background(), event)
	if err != nil {
		t.Fatalf("InteractionSnapshot: %v", err)
	}
	if expected.Group != event.Group || expected.Instance != f.instance || expected.Installation != f.install || expected.Community != f.community ||
		expected.BotUser != f.botUser || expected.BotDevice != f.botDevice || expected.ParticipantUser != event.SenderUser || expected.ParticipantDevice != event.SenderDevice ||
		expected.MinimumEligibilityRevision != 4 || expected.PolicyVersion != 3 || expected.ServerNow != 100 || len(wire) == 0 {
		t.Fatalf("snapshot binding did not match the durable registration: expected=%+v wire=%d", expected, len(wire))
	}
}

func TestInteractionRegistrationSnapshotProviderRenewsExpiredAdmission(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	if _, err := f.coordinator.Register(context.Background(), f.request); err != nil {
		t.Fatalf("Register: %v", err)
	}
	originalRequest := f.s.requestIDs[0]
	f.s.currentTime = 131 // the registration admission expired at server time 130
	event := native.GroupEvent{Group: f.request.Group, Community: f.community, SenderUser: f.request.ParticipantUser, SenderDevice: f.request.ParticipantDevice}
	_, wire, err := f.coordinator.InteractionSnapshot(context.Background(), event)
	if err != nil {
		t.Fatalf("InteractionSnapshot after admission expiry: %v", err)
	}
	snapshot, err := interactionSnapshotDetailsFromWire(wire)
	if err != nil {
		t.Fatalf("parse fresh context: %v", err)
	}
	requestID := snapshot.Request
	if requestID.IsZero() || requestID == originalRequest || len(f.s.requestIDs) != 5 || f.s.requestIDs[3] != requestID || f.s.requestIDs[4] != requestID {
		t.Fatalf("provider reused expired admission request: original=%s context=%s requests=%v", originalRequest, requestID, f.s.requestIDs)
	}
	value, err := f.n.StateGet(context.Background(), interactionRegistrationStateArea, interactionRegistrationKey(f.request.Group))
	if err != nil {
		t.Fatalf("load durable registration intent: %v", err)
	}
	intent, err := decodeInteractionRegistrationIntent(value.Value)
	if err != nil || intent.AdmissionRequest != originalRequest {
		t.Fatalf("fresh snapshot mutated durable registration admission request: intent=%+v err=%v", intent, err)
	}
}

func TestInteractionRegistrationQueueProcessesDevicesOnlyForCurrentEpisode(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.currentEpisode = f.episode
	f.s.candidates = []id.ID{id.New(), id.New()}
	f.s.keyPackage = []byte{7, 8, 9}

	if err := f.coordinator.QueueMemberJoin(context.Background(), f.request.ParticipantUser, f.episode); err != nil {
		t.Fatalf("QueueMemberJoin: %v", err)
	}
	if f.s.registerCalls != 0 {
		t.Fatal("member join performed registration before the durable worker pass")
	}
	f.coordinator, _ = NewInteractionRegistrationCoordinator(f.instance, f.community, f.install, f.n, f.d, f.s)
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("ProcessPending: %v (keypackages=%d creates=%d registrations=%d) ", err, f.s.keyPackageCalls, f.n.createCalls, f.s.registerCalls)
	}
	if f.s.registerCalls != 2 || f.n.createCalls != 2 {
		t.Fatalf("worker registered %d devices / created %d groups, want 2", f.s.registerCalls, f.n.createCalls)
	}
	if f.s.registeredGroups[0] == f.s.registeredGroups[1] {
		t.Fatal("device candidates reused one group identifier")
	}
}

func TestInteractionRegistrationQueueKeepsEpisodeUntilDevicesAppear(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.currentEpisode = f.episode
	if err := f.coordinator.QueueMemberJoin(context.Background(), f.request.ParticipantUser, f.episode); err != nil {
		t.Fatal(err)
	}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("empty candidate pass: %v", err)
	}
	value, err := f.n.StateGet(context.Background(), interactionRegistrationStateArea, []byte(interactionRegistrationQueueKey))
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := decodeInteractionRegistrationJobs(value.Value)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("empty device list dropped pending episode: jobs=%+v err=%v", jobs, err)
	}
	f.s.candidates = []id.ID{id.New()}
	f.s.keyPackage = []byte{7, 8, 9}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("device arrival pass: %v", err)
	}
	if f.s.registerCalls != 1 {
		t.Fatalf("device arrival registered %d times, want 1", f.s.registerCalls)
	}
}

func TestInteractionRegistrationQueueDropsAStaleEpisode(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.currentEpisode = id.New()
	f.s.candidates = []id.ID{id.New()}
	if err := f.coordinator.QueueMemberJoin(context.Background(), f.request.ParticipantUser, f.episode); err != nil {
		t.Fatalf("QueueMemberJoin: %v", err)
	}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("ProcessPending: %v", err)
	}
	if f.s.registerCalls != 0 {
		t.Fatalf("stale episode attempted %d registrations", f.s.registerCalls)
	}
	f.s.currentEpisode = f.episode
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("ProcessPending after stale job: %v", err)
	}
	if f.s.registerCalls != 0 {
		t.Fatal("stale episode job remained queued after it was discarded")
	}
}

func TestInteractionRegistrationQueueRetainsTransientPackageFailure(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.currentEpisode = f.episode
	f.s.candidates = []id.ID{id.New()}
	f.s.keyPackageErr = errors.New("package temporarily unavailable")
	if err := f.coordinator.QueueMemberJoin(context.Background(), f.request.ParticipantUser, f.episode); err != nil {
		t.Fatalf("QueueMemberJoin: %v", err)
	}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err == nil {
		t.Fatal("transient package failure was not reported to the worker")
	} else {
		t.Logf("first worker failure: %v (keypackages=%d)", err, f.s.keyPackageCalls)
	}
	if f.s.registerCalls != 0 {
		t.Fatal("registration ran without a package")
	}
	f.s.keyPackageErr = nil
	f.s.keyPackage = []byte{7, 8, 9}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("retry ProcessPending: %v (keypackages=%d creates=%d registrations=%d)", err, f.s.keyPackageCalls, f.n.createCalls, f.s.registerCalls)
	}
	if f.s.registerCalls != 1 {
		t.Fatalf("retry registered %d times, want 1", f.s.registerCalls)
	}
}

func TestInteractionRegistrationQueueRetriesOnlyFailedDevice(t *testing.T) {
	f := newInteractionRegistrationFixture(t)
	f.s.currentEpisode = f.episode
	f.s.candidates = []id.ID{id.New(), id.New()}
	f.s.keyPackage = []byte{7, 8, 9}
	f.s.keyPackageFailures = 1
	if err := f.coordinator.QueueMemberJoin(context.Background(), f.request.ParticipantUser, f.episode); err != nil {
		t.Fatalf("QueueMemberJoin: %v", err)
	}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err == nil {
		t.Fatal("partial device failure was not reported")
	}
	if f.s.registerCalls != 1 || f.n.createCalls != 1 {
		t.Fatalf("first pass registered/created %d/%d, want only one completed device", f.s.registerCalls, f.n.createCalls)
	}
	if err := f.coordinator.ProcessPending(context.Background(), 1, 8, f.s, f.s); err != nil {
		t.Fatalf("retry ProcessPending: %v", err)
	}
	if f.s.registerCalls != 2 || f.n.createCalls != 2 {
		t.Fatalf("retry duplicated completed device or missed failed device: registered=%d created=%d", f.s.registerCalls, f.n.createCalls)
	}
}

type interactionRegistrationFixture struct {
	coordinator                                      *InteractionRegistrationCoordinator
	n                                                *interactionRegistrationNativeFake
	s                                                *interactionRegistrationSessionFake
	d                                                *interactionRegistrationDiscoveryFake
	instance, community, install, botUser, botDevice id.ID
	episode                                          id.ID
	request                                          InteractionRegistrationRequest
}

func newInteractionRegistrationFixture(t *testing.T) *interactionRegistrationFixture {
	t.Helper()
	f := &interactionRegistrationFixture{instance: id.New(), community: id.New(), install: id.New(), botUser: id.New(), botDevice: id.New(), episode: id.New()}
	f.n = &interactionRegistrationNativeFake{binding: native.Binding{Instance: f.instance, Community: f.community, Installation: f.install}, identity: native.Identity{Phase: 2, Instance: &f.instance, User: &f.botUser, Device: &f.botDevice}}
	f.d = &interactionRegistrationDiscoveryFake{value: client.Discovery{InstanceID: f.instance, Generation: 8, PolicyVersion: 3, ExternalSenderPub: append([]byte{1}, make([]byte, 31)...), E2EEVersions: []uint64{1}, MediaVersions: []uint64{0}}}
	f.s = &interactionRegistrationSessionFake{admission: []byte{0x41}}
	f.request = InteractionRegistrationRequest{Group: id.New(), ParticipantUser: id.New(), ParticipantDevice: id.New(), MinimumEligibilityRevision: 4, ParticipantKeyPackage: []byte{1, 2, 3}}
	f.s.expected = []any{f.instance, f.install, f.community, f.botUser, f.botDevice}
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
	return makeSignedSnapshotFixtureFor(request, []any{id.New(), id.New(), id.New(), id.New(), id.New(), id.New(), id.New(), id.New()}, 100)
}

func makeSignedSnapshotFixtureFor(request id.ID, expected []any, now uint64) ([]byte, error) {
	payload, err := cborx.Marshal([]any{uint64(1), request, id.New(), []byte{1}, make([]byte, 64), now, uint64(4), uint64(3), uint64(1), uint64(0), id.New(), id.New(), make([]byte, 32), expected, []any{}, []any{}})
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
	createdExpected         native.InteractionGroupExpected
	createdKeyPackage       []byte
}

func (n *interactionRegistrationNativeFake) Binding() native.Binding { return n.binding }
func (n *interactionRegistrationNativeFake) Bootstrap(context.Context, [32]byte) (native.BootstrapResult, error) {
	return native.BootstrapResult{}, nil
}
func (n *interactionRegistrationNativeFake) Identity(context.Context) (native.Identity, error) {
	return n.identity, nil
}
func (n *interactionRegistrationNativeFake) CreateInteractionGroup(_ context.Context, _ id.ID, e native.InteractionGroupExpected, _ []byte, keyPackage []byte) (native.InteractionGroupCreateResult, error) {
	n.createCalls++
	n.createdExpected = e
	n.createdKeyPackage = append([]byte(nil), keyPackage...)
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
	dropRegistrationResponse    bool
	lastOperation               id.ID
	hideReceiptCalls            uint64
	receipt                     *client.BotGroupRegistrationReceipt
	requestIDs                  []id.ID
	expected                    []any
	currentEpisode              id.ID
	candidates                  []id.ID
	registeredGroups            []id.ID
	admissionErr                error
	currentTime                 uint64
	admissions                  map[id.ID]uint64
	keyPackage                  []byte
	keyPackageErr               error
	keyPackageCalls             uint64
	keyPackageFailures          uint64
}

func (s *interactionRegistrationSessionFake) KeyPackage(context.Context, id.ID) ([]byte, error) {
	s.keyPackageCalls++
	if s.keyPackageFailures > 0 {
		s.keyPackageFailures--
		return nil, errors.New("package temporarily unavailable")
	}
	return append([]byte(nil), s.keyPackage...), s.keyPackageErr
}

func (s *interactionRegistrationSessionFake) IssueBotInteractionAdmission(_ context.Context, _ id.ID, request id.ID, _ id.ID, _ id.ID, _ id.ID) ([]byte, error) {
	s.requestIDs = append(s.requestIDs, request)
	if s.admissionErr != nil {
		return nil, s.admissionErr
	}
	if s.currentTime == 0 {
		s.currentTime = 100
	}
	if s.admissions == nil {
		s.admissions = map[id.ID]uint64{}
	}
	s.admissions[request] = s.currentTime + 30
	return append([]byte(nil), s.admission...), nil
}

func (s *interactionRegistrationSessionFake) ResolveCurrentEpisode(context.Context, id.ID) (id.ID, bool, error) {
	return s.currentEpisode, !s.currentEpisode.IsZero(), nil
}

func (s *interactionRegistrationSessionFake) DeviceCandidates(context.Context, id.ID) ([]id.ID, error) {
	return append([]id.ID(nil), s.candidates...), nil
}
func (s *interactionRegistrationSessionFake) BotInteractionContextSnapshot(_ context.Context, _ id.ID, request, group, user, device id.ID) ([]byte, error) {
	s.requestIDs = append(s.requestIDs, request)
	if s.currentTime == 0 {
		s.currentTime = 100
	}
	if s.admissions[request] <= s.currentTime {
		return nil, errors.New("admission expired or missing")
	}
	expected := append(append([]any(nil), s.expected...), user, device, group)
	return makeSignedSnapshotFixtureFor(request, expected, s.currentTime)
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
	s.registeredGroups = append(s.registeredGroups, group)
	s.lastOperation = op
	if s.dropRegistrationResponse {
		return client.BotGroupRegistrationReceipt{}, errors.New("response lost before commit")
	}
	r := client.BotGroupRegistrationReceipt{OperationID: op, GroupID: group, RegistrationSHA256: interactionRegistrationHash(body), AcceptedGeneration: generation, InitialEpoch: 1, NextSequence: 1}
	s.receipt = &r
	if s.storeThenLoseResponse {
		s.hideReceiptCalls = 1
		return client.BotGroupRegistrationReceipt{}, errors.New("response lost")
	}
	return r, nil
}
func (s *interactionRegistrationSessionFake) BotGroupRegistrationReceipt(_ context.Context, _ id.ID, operation id.ID) (client.BotGroupRegistrationReceipt, error) {
	s.receiptCalls++
	if s.hideReceiptCalls > 0 {
		s.hideReceiptCalls--
		return client.BotGroupRegistrationReceipt{}, client.ErrRegistrationReceiptNotFound
	}
	if s.receipt == nil || s.receipt.OperationID != operation {
		return client.BotGroupRegistrationReceipt{}, client.ErrRegistrationReceiptNotFound
	}
	return *s.receipt, nil
}
func (s *interactionRegistrationSessionFake) GroupInfo(context.Context, id.ID) (client.GroupInfo, error) {
	return client.GroupInfo{}, &client.APIError{Status: http.StatusNotFound, Code: "E_NOT_FOUND"}
}

var _ = native.StateValue{}
