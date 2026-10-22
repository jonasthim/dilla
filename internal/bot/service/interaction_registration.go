package service

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sync"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	interactionRegistrationStateArea       = 6
	interactionRegistrationStatePrefix     = "dilla.bot.interaction-registration.v1/"
	interactionRegistrationStateVersion    = 1
	interactionRegistrationInitialEpoch    = 1
	interactionRegistrationInitialSequence = 1
)

var (
	ErrInteractionRegistrationRecovery       = errors.New("bot interaction registration requires recovery")
	ErrInteractionRegistrationOutcomeUnknown = errors.New("bot interaction registration outcome is unknown")
)

// InteractionGroupExpected is the exact identity/admission tuple sent to the
// transaction-local native create primitive. The native helper verifies the
// signed snapshot and derives the roster from OpenMLS credentials.
type InteractionGroupExpected struct {
	Instance, Installation, Community, BotUser, BotDevice id.ID
	ParticipantUser, ParticipantDevice, Group             id.ID
	MinimumEligibilityRevision, ServerNow, PolicyVersion  uint64
}

type InteractionGroupBinding struct {
	Instance, BotUser, Installation, Community id.ID
	ParticipantUser, ParticipantDevice         id.ID
	PolicyVersion, E2EEVersion, MediaVersion   uint64
}

// InteractionGroupCreateResult is service-local until the typed native adapter
// API lands. Epoch and MemberCount are contract markers emitted only after the
// native helper has checked the actual GroupContext and OpenMLS leaves.
type InteractionGroupCreateResult struct {
	Group                                        id.ID
	Binding                                      InteractionGroupBinding
	BindingBody, GroupInfo, RatchetTree, Welcome []byte
	Epoch, MemberCount                           uint64
}

type interactionRegistrationNativeAPI interface {
	Binding() native.Binding
	Bootstrap(context.Context, [32]byte) (native.BootstrapResult, error)
	Identity(context.Context) (native.Identity, error)
	CreateInteractionGroup(context.Context, id.ID, InteractionGroupExpected, []byte, []byte) (InteractionGroupCreateResult, error)
	GroupRegistered(context.Context, id.ID, id.ID, uint64) error
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}

type interactionRegistrationDiscoveryAPI interface {
	Discover(context.Context) (client.Discovery, error)
}
type interactionRegistrationSessionAPI interface {
	IssueBotInteractionAdmission(context.Context, id.ID, id.ID, id.ID, id.ID, id.ID) ([]byte, error)
	BotInteractionContextSnapshot(context.Context, id.ID, id.ID, id.ID, id.ID, id.ID) ([]byte, error)
	RegisterBotGroupWithAdmissionRequest(context.Context, id.ID, id.ID, uint64, []byte, id.ID) (client.BotGroupRegistrationReceipt, error)
	BotGroupRegistrationReceipt(context.Context, id.ID, id.ID) (client.BotGroupRegistrationReceipt, error)
	GroupInfo(context.Context, id.ID) (client.GroupInfo, error)
}

type InteractionRegistrationCoordinator struct {
	mu                                sync.Mutex
	instance, community, installation id.ID
	native                            interactionRegistrationNativeAPI
	discovery                         interactionRegistrationDiscoveryAPI
	session                           interactionRegistrationSessionAPI
}

func NewInteractionRegistrationCoordinator(instance, community, installation id.ID, n interactionRegistrationNativeAPI, discovery interactionRegistrationDiscoveryAPI, session interactionRegistrationSessionAPI) (*InteractionRegistrationCoordinator, error) {
	if instance.IsZero() || community.IsZero() || installation.IsZero() || n == nil || discovery == nil || session == nil || n.Binding() != (native.Binding{Instance: instance, Community: community, Installation: installation}) {
		return nil, errors.New("invalid bot interaction registration binding")
	}
	return &InteractionRegistrationCoordinator{instance: instance, community: community, installation: installation, native: n, discovery: discovery, session: session}, nil
}

type InteractionRegistrationRequest struct {
	Group, ParticipantUser, ParticipantDevice id.ID
	MinimumEligibilityRevision                uint64
	ParticipantKeyPackage                     []byte
}

// InteractionRegistrationResult deliberately reports Usable=false. A server
// receipt is not an authenticated initial-Welcome delivery receipt; callers
// must keep the interaction pending until that separate protocol exists.
type InteractionRegistrationResult struct {
	Receipt        client.BotGroupRegistrationReceipt
	PendingWelcome []byte
	Usable         bool
}

type interactionRegistrationIntent struct {
	Operation, AdmissionRequest, Group, ParticipantUser, ParticipantDevice id.ID
	BotUser, BotDevice                                                     id.ID
	MinimumRevision, Policy, Generation                                    uint64
	KeyPackage, Admission, Snapshot, Body, Welcome                         []byte
	Submitted                                                              bool
	Phase                                                                  uint64
	Receipt                                                                client.BotGroupRegistrationReceipt
}

func (c *InteractionRegistrationCoordinator) Register(ctx context.Context, req InteractionRegistrationRequest) (InteractionRegistrationResult, error) {
	if c == nil {
		return InteractionRegistrationResult{}, errors.New("invalid interaction registration request")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if req.Group.IsZero() || req.ParticipantUser.IsZero() || req.ParticipantDevice.IsZero() || req.MinimumEligibilityRevision == 0 || req.MinimumEligibilityRevision > math.MaxInt64 || len(req.ParticipantKeyPackage) == 0 || len(req.ParticipantKeyPackage) > 65505 {
		return InteractionRegistrationResult{}, errors.New("invalid interaction registration request")
	}
	d, err := c.discovery.Discover(ctx)
	if err != nil {
		return InteractionRegistrationResult{}, err
	}
	if d.InstanceID != c.instance || d.Generation == 0 || d.Generation > math.MaxInt64 || d.PolicyVersion == 0 || d.PolicyVersion > math.MaxInt64 {
		return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
	}
	if len(d.ExternalSenderPub) != 32 || allZeroBytes(d.ExternalSenderPub) {
		return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
	}
	if _, err := c.native.Bootstrap(ctx, bytes32(d.ExternalSenderPub)); err != nil {
		return InteractionRegistrationResult{}, err
	}
	identity, err := c.native.Identity(ctx)
	if err != nil || identity.Phase != 2 || identity.Instance == nil || *identity.Instance != c.instance || identity.User == nil || identity.Device == nil || identity.User.IsZero() || identity.Device.IsZero() {
		return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
	}
	key := interactionRegistrationKey(req.Group)
	v, err := c.native.StateGet(ctx, interactionRegistrationStateArea, key)
	if err != nil {
		return InteractionRegistrationResult{}, err
	}
	var in interactionRegistrationIntent
	revision := v.Revision
	if v.Tombstone {
		return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
	}
	if revision == 0 {
		in = interactionRegistrationIntent{Operation: id.New(), AdmissionRequest: id.New(), Group: req.Group, ParticipantUser: req.ParticipantUser, ParticipantDevice: req.ParticipantDevice, BotUser: *identity.User, BotDevice: *identity.Device, MinimumRevision: req.MinimumEligibilityRevision, Policy: d.PolicyVersion, Generation: d.Generation, KeyPackage: append([]byte(nil), req.ParticipantKeyPackage...)}
		revision, err = c.saveInteractionRegistration(ctx, key, revision, in)
		if err != nil {
			return InteractionRegistrationResult{}, fmt.Errorf("persist interaction intent: %w", err)
		}
	} else {
		in, err = decodeInteractionRegistrationIntent(v.Value)
		if err != nil || in.Group != req.Group || in.ParticipantUser != req.ParticipantUser || in.ParticipantDevice != req.ParticipantDevice || in.MinimumRevision != req.MinimumEligibilityRevision || in.BotUser != *identity.User || in.BotDevice != *identity.Device || in.Policy != d.PolicyVersion || !equalBytes(in.KeyPackage, req.ParticipantKeyPackage) {
			return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
		}
		if in.Phase == 2 {
			return InteractionRegistrationResult{Receipt: in.Receipt, PendingWelcome: append([]byte(nil), in.Welcome...), Usable: false}, nil
		}
	}
	if len(in.Body) == 0 {
		if len(in.Admission) == 0 {
			in.Admission, err = c.session.IssueBotInteractionAdmission(ctx, c.installation, in.AdmissionRequest, in.Group, in.ParticipantUser, in.ParticipantDevice)
			if err != nil {
				return InteractionRegistrationResult{}, fmt.Errorf("%w: admission request remains pending: %v", ErrInteractionRegistrationRecovery, err)
			}
			revision, err = c.saveInteractionRegistration(ctx, key, revision, in)
			if err != nil {
				return InteractionRegistrationResult{}, err
			}
		}
		if len(in.Snapshot) == 0 {
			in.Snapshot, err = c.session.BotInteractionContextSnapshot(ctx, c.installation, in.AdmissionRequest, in.Group, in.ParticipantUser, in.ParticipantDevice)
			if err != nil {
				return InteractionRegistrationResult{}, fmt.Errorf("%w: context snapshot unavailable: %v", ErrInteractionRegistrationRecovery, err)
			}
			revision, err = c.saveInteractionRegistration(ctx, key, revision, in)
			if err != nil {
				return InteractionRegistrationResult{}, err
			}
		}
		snapshotRequest, now, err := interactionSnapshotCorrelation(in.Snapshot)
		if err != nil || snapshotRequest != in.AdmissionRequest {
			return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
		}
		expected := InteractionGroupExpected{Instance: c.instance, Installation: c.installation, Community: c.community, BotUser: in.BotUser, BotDevice: in.BotDevice, ParticipantUser: in.ParticipantUser, ParticipantDevice: in.ParticipantDevice, Group: in.Group, MinimumEligibilityRevision: in.MinimumRevision, ServerNow: now, PolicyVersion: in.Policy}
		created, err := c.native.CreateInteractionGroup(ctx, in.Operation, expected, in.Snapshot, in.KeyPackage)
		if err != nil {
			return InteractionRegistrationResult{}, fmt.Errorf("%w: native create remains pending: %v", ErrInteractionRegistrationRecovery, err)
		}
		if !validInteractionCreateResult(created, expected, d) {
			return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
		}
		in.Welcome = append([]byte(nil), created.Welcome...)
		// Preserve the native helper's exact authenticated binding bytes. The
		// versioned kind-3 registration contract adds Welcome as its fifth field.
		in.Body, err = cborx.Marshal([]any{created.Group, created.BindingBody, created.GroupInfo, created.RatchetTree, created.Welcome})
		if err != nil || len(in.Body) == 0 || len(in.Body) > 65505 {
			return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
		}
		revision, err = c.saveInteractionRegistration(ctx, key, revision, in)
		if err != nil {
			return InteractionRegistrationResult{}, fmt.Errorf("persist interaction registration body: %w", err)
		}
	}
	if in.Phase == 1 {
		return c.resolveInteractionReceipt(ctx, key, revision, in, in.Receipt)
	}
	if !in.Submitted {
		in.Submitted = true
		revision, err = c.saveInteractionRegistration(ctx, key, revision, in)
		if err != nil {
			return InteractionRegistrationResult{}, err
		}
	}
	receipt, err := c.session.BotGroupRegistrationReceipt(ctx, c.installation, in.Operation)
	if err == nil {
		return c.acceptInteractionReceipt(ctx, key, revision, in, receipt)
	}
	if !errors.Is(err, client.ErrRegistrationReceiptNotFound) {
		return InteractionRegistrationResult{}, fmt.Errorf("%w: receipt lookup failed: %v", ErrInteractionRegistrationOutcomeUnknown, err)
	}
	if err := c.proveInteractionRetrySafe(ctx, in); err != nil {
		return InteractionRegistrationResult{}, err
	}
	receipt, postErr := c.session.RegisterBotGroupWithAdmissionRequest(ctx, c.installation, in.Operation, in.Generation, in.Body, in.AdmissionRequest)
	if postErr == nil {
		return c.acceptInteractionReceipt(ctx, key, revision, in, receipt)
	}
	receipt, err = c.session.BotGroupRegistrationReceipt(ctx, c.installation, in.Operation)
	if err == nil {
		return c.acceptInteractionReceipt(ctx, key, revision, in, receipt)
	}
	if !errors.Is(err, client.ErrRegistrationReceiptNotFound) {
		return InteractionRegistrationResult{}, fmt.Errorf("%w: receipt lookup failed: %v", ErrInteractionRegistrationOutcomeUnknown, err)
	}
	return InteractionRegistrationResult{}, fmt.Errorf("%w: registration response lost: %v", ErrInteractionRegistrationOutcomeUnknown, postErr)
}

func (c *InteractionRegistrationCoordinator) proveInteractionRetrySafe(ctx context.Context, in interactionRegistrationIntent) error {
	d, err := c.discovery.Discover(ctx)
	if err != nil {
		return fmt.Errorf("%w: generation unavailable: %v", ErrInteractionRegistrationOutcomeUnknown, err)
	}
	if d.InstanceID != c.instance || d.Generation != in.Generation {
		return ErrInteractionRegistrationOutcomeUnknown
	}
	_, err = c.session.GroupInfo(ctx, in.Group)
	if err == nil {
		return ErrInteractionRegistrationRecovery
	}
	if !apiNotFound(err) {
		return fmt.Errorf("%w: cannot prove group absence: %v", ErrInteractionRegistrationOutcomeUnknown, err)
	}
	return nil
}

func (c *InteractionRegistrationCoordinator) acceptInteractionReceipt(ctx context.Context, key []byte, revision uint64, in interactionRegistrationIntent, r client.BotGroupRegistrationReceipt) (InteractionRegistrationResult, error) {
	if r.OperationID != in.Operation || r.GroupID != in.Group || r.RegistrationSHA256 != interactionRegistrationHash(in.Body) || r.AcceptedGeneration != in.Generation || r.InitialEpoch != interactionRegistrationInitialEpoch || r.NextSequence != interactionRegistrationInitialSequence {
		return InteractionRegistrationResult{}, ErrInteractionRegistrationRecovery
	}
	in.Phase = 1
	in.Receipt = r
	revision, err := c.saveInteractionRegistration(ctx, key, revision, in)
	if err != nil {
		return InteractionRegistrationResult{}, err
	}
	return c.resolveInteractionReceipt(ctx, key, revision, in, r)
}

func (c *InteractionRegistrationCoordinator) resolveInteractionReceipt(ctx context.Context, key []byte, revision uint64, in interactionRegistrationIntent, r client.BotGroupRegistrationReceipt) (InteractionRegistrationResult, error) {
	if err := c.native.GroupRegistered(ctx, in.Operation, in.Group, r.NextSequence); err != nil {
		return InteractionRegistrationResult{}, fmt.Errorf("%w: native resolution failed: %v", ErrInteractionRegistrationRecovery, err)
	}
	in.Phase = 2
	in.Receipt = r
	if _, err := c.saveInteractionRegistration(ctx, key, revision, in); err != nil {
		return InteractionRegistrationResult{}, err
	}
	return InteractionRegistrationResult{Receipt: r, PendingWelcome: append([]byte(nil), in.Welcome...), Usable: false}, nil
}

func (c *InteractionRegistrationCoordinator) saveInteractionRegistration(ctx context.Context, key []byte, revision uint64, in interactionRegistrationIntent) (uint64, error) {
	value, err := encodeInteractionRegistrationIntent(in)
	if err != nil {
		return revision, err
	}
	seed := append([]byte("dilla.bot.interaction-registration.tx.v1\x00"), key...)
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], revision)
	seed = append(seed, b[:]...)
	seed = append(seed, value...)
	h := sha256.Sum256(seed)
	var tx id.ID
	copy(tx[:], h[:id.Size])
	revs, err := c.native.StateTransaction(ctx, tx, []native.StateChange{{Area: interactionRegistrationStateArea, Key: key, ExpectedRevision: revision, Value: value}})
	if err != nil {
		return revision, err
	}
	if len(revs) != 1 || revs[0] != revision+1 {
		return revision, ErrInteractionRegistrationRecovery
	}
	return revs[0], nil
}

func validInteractionCreateResult(r InteractionGroupCreateResult, e InteractionGroupExpected, d client.Discovery) bool {
	b := r.Binding
	return r.Group == e.Group && b.Instance == e.Instance && b.Installation == e.Installation && b.Community == e.Community && b.BotUser == e.BotUser && b.ParticipantUser == e.ParticipantUser && b.ParticipantDevice == e.ParticipantDevice && b.PolicyVersion == e.PolicyVersion && b.E2EEVersion == 1 && b.MediaVersion == 0 && containsVersion(d.E2EEVersions, b.E2EEVersion) && r.Epoch == 1 && r.MemberCount == 2 && len(r.BindingBody) > 0 && len(r.GroupInfo) > 0 && len(r.RatchetTree) > 0 && len(r.Welcome) > 0
}
func interactionRegistrationHash(body []byte) [32]byte {
	h := sha256.New()
	_, _ = h.Write([]byte("dilla bot group registration v1\x00"))
	_, _ = h.Write(body)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
func interactionRegistrationKey(group id.ID) []byte {
	return []byte(interactionRegistrationStatePrefix + group.String())
}
func containsVersion(v []uint64, want uint64) bool {
	for _, x := range v {
		if x == want {
			return true
		}
	}
	return false
}

// The snapshot envelope and signed payload are parsed only to pass the signed
// server time into native verification. No signature or admission is trusted
// here; the native helper verifies the complete wire against pinned keys.
func interactionSnapshotCorrelation(wire []byte) (id.ID, uint64, error) {
	if cborx.CheckDeterministic(wire) != nil {
		return id.ID{}, 0, ErrInteractionRegistrationRecovery
	}
	var envelope []any
	if cborx.Unmarshal(wire, &envelope) != nil || len(envelope) != 2 {
		return id.ID{}, 0, ErrInteractionRegistrationRecovery
	}
	payload, ok := envelope[0].([]byte)
	sig, sok := envelope[1].([]byte)
	if !ok || !sok || len(sig) != 64 || cborx.CheckDeterministic(payload) != nil {
		return id.ID{}, 0, ErrInteractionRegistrationRecovery
	}
	var a []any
	if cborx.Unmarshal(payload, &a) != nil || len(a) != 16 {
		return id.ID{}, 0, ErrInteractionRegistrationRecovery
	}
	version, vok := a[0].(uint64)
	request, rok := registrationID(a[1])
	now, nok := a[5].(uint64)
	if !vok || version != 1 || !rok || request.IsZero() || !nok || now == 0 || now > math.MaxInt64 {
		return id.ID{}, 0, ErrInteractionRegistrationRecovery
	}
	return request, now, nil
}

func encodeInteractionRegistrationIntent(i interactionRegistrationIntent) ([]byte, error) {
	var receipt any
	if i.Phase >= 1 {
		receipt = []any{i.Receipt.OperationID, i.Receipt.GroupID, i.Receipt.RegistrationSHA256[:], i.Receipt.AcceptedGeneration, i.Receipt.InitialEpoch, i.Receipt.NextSequence}
	}
	return cborx.Marshal([]any{uint64(interactionRegistrationStateVersion), i.Operation, i.AdmissionRequest, i.Group, i.ParticipantUser, i.ParticipantDevice, i.BotUser, i.BotDevice, i.MinimumRevision, i.Policy, i.Generation, nullableBytes(i.KeyPackage), nullableBytes(i.Admission), nullableBytes(i.Snapshot), nullableBytes(i.Body), nullableBytes(i.Welcome), boolUint(i.Submitted), i.Phase, receipt})
}

func decodeInteractionRegistrationIntent(raw []byte) (interactionRegistrationIntent, error) {
	var o interactionRegistrationIntent
	if cborx.CheckDeterministic(raw) != nil {
		return o, ErrInteractionRegistrationRecovery
	}
	var a []any
	if cborx.Unmarshal(raw, &a) != nil || len(a) != 19 {
		return o, ErrInteractionRegistrationRecovery
	}
	u, ok := a[0].(uint64)
	if !ok || u != interactionRegistrationStateVersion {
		return o, ErrInteractionRegistrationRecovery
	}
	ids := []*id.ID{&o.Operation, &o.AdmissionRequest, &o.Group, &o.ParticipantUser, &o.ParticipantDevice, &o.BotUser, &o.BotDevice}
	for i, p := range ids {
		*p, ok = registrationID(a[i+1])
		if !ok || p.IsZero() {
			return o, ErrInteractionRegistrationRecovery
		}
	}
	if o.MinimumRevision, ok = a[8].(uint64); !ok || o.MinimumRevision == 0 {
		return o, ErrInteractionRegistrationRecovery
	}
	if o.Policy, ok = a[9].(uint64); !ok || o.Policy == 0 {
		return o, ErrInteractionRegistrationRecovery
	}
	if o.Generation, ok = a[10].(uint64); !ok || o.Generation == 0 {
		return o, ErrInteractionRegistrationRecovery
	}
	fields := []*[]byte{&o.KeyPackage, &o.Admission, &o.Snapshot, &o.Body, &o.Welcome}
	for i, p := range fields {
		if a[11+i] != nil {
			*p, ok = a[11+i].([]byte)
			if !ok {
				return o, ErrInteractionRegistrationRecovery
			}
			*p = append([]byte(nil), (*p)...)
		}
	}
	if o.Submitted, ok = uintBool(a[16]); !ok {
		return o, ErrInteractionRegistrationRecovery
	}
	if o.Phase, ok = a[17].(uint64); !ok || o.Phase > 2 {
		return o, ErrInteractionRegistrationRecovery
	}
	if o.Phase >= 1 {
		r, ok := a[18].([]any)
		if !ok || len(r) != 6 {
			return o, ErrInteractionRegistrationRecovery
		}
		if o.Receipt.OperationID, ok = registrationID(r[0]); !ok {
			return o, ErrInteractionRegistrationRecovery
		}
		if o.Receipt.GroupID, ok = registrationID(r[1]); !ok {
			return o, ErrInteractionRegistrationRecovery
		}
		hash, ok := r[2].([]byte)
		if !ok || len(hash) != 32 {
			return o, ErrInteractionRegistrationRecovery
		}
		copy(o.Receipt.RegistrationSHA256[:], hash)
		if o.Receipt.AcceptedGeneration, ok = r[3].(uint64); !ok {
			return o, ErrInteractionRegistrationRecovery
		}
		if o.Receipt.InitialEpoch, ok = r[4].(uint64); !ok {
			return o, ErrInteractionRegistrationRecovery
		}
		if o.Receipt.NextSequence, ok = r[5].(uint64); !ok {
			return o, ErrInteractionRegistrationRecovery
		}
		if len(o.Body) == 0 || o.Receipt.OperationID != o.Operation || o.Receipt.GroupID != o.Group || o.Receipt.RegistrationSHA256 != interactionRegistrationHash(o.Body) || o.Receipt.AcceptedGeneration != o.Generation || o.Receipt.InitialEpoch != 1 || o.Receipt.NextSequence != 1 {
			return o, ErrInteractionRegistrationRecovery
		}
	} else if a[18] != nil {
		return o, ErrInteractionRegistrationRecovery
	}
	return o, nil
}

var _ = fmt.Sprintf
