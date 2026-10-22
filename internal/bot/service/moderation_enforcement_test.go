package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type removalSignerFake struct {
	binding native.Binding
	groups  []id.ID
	targets []uint64
	ids     []id.ID
	expires []uint64
}

func (f *removalSignerFake) Binding() native.Binding { return f.binding }
func (f *removalSignerFake) SignRemoval(_ context.Context, request, group id.ID, target, expires, now uint64) ([]byte, error) {
	f.ids = append(f.ids, request)
	f.groups = append(f.groups, group)
	f.targets = append(f.targets, target)
	f.expires = append(f.expires, expires)
	return []byte{byte(request[0]), byte(group[0]), byte(target), byte(expires >> 24), byte(expires >> 16), byte(expires >> 8), byte(expires)}, nil
}

type removalSessionFake struct {
	bodies       [][]byte
	err          error
	errs         []error
	receipt      client.ModerationRemovalReceipt
	emptyReceipt bool
}

func (f *removalSessionFake) AcceptModerationRemoval(_ context.Context, _ id.ID, body []byte) (client.ModerationRemovalReceipt, error) {
	f.bodies = append(f.bodies, append([]byte(nil), body...))
	if len(f.errs) > 0 {
		err := f.errs[0]
		f.errs = f.errs[1:]
		if err != nil {
			return client.ModerationRemovalReceipt{}, err
		}
	}
	if f.err != nil {
		return client.ModerationRemovalReceipt{}, f.err
	}
	if f.receipt.ActionID.IsZero() {
		if f.emptyReceipt {
			return client.ModerationRemovalReceipt{}, nil
		}
		return client.ModerationRemovalReceipt{ActionID: testID(88), Revision: 23}, nil
	}
	return f.receipt, nil
}

func removalAction(action moderation.Action) ModerationAction {
	now := time.Unix(1_800_000_000, 0)
	return ModerationAction{Community: testID(1).String(), Group: testID(2).String(), Channel: testID(3).String(),
		Actor: testID(4).String(), Message: testID(5).String(), SourceRevision: 17,
		Decision: moderation.Decision{Action: action, Rules: []moderation.Rule{moderation.RuleRate}}, ReceivedAt: now, runtimeGenerated: true}
}

func TestModerationRemovalBackendRefusesUnsupportedActions(t *testing.T) {
	n := &removalSignerFake{binding: native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}}
	s := &removalSessionFake{}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range []moderation.Action{moderation.ActionLog, moderation.ActionWarn, moderation.ActionTimeout} {
		if err := b.EnforceModerationAction(context.Background(), removalAction(action)); !errors.Is(err, ErrModerationActionUnsupported) {
			t.Fatalf("action %q error = %v, want unsupported", action, err)
		}
	}
	if len(n.ids) != 0 || len(s.bodies) != 0 {
		t.Fatalf("unsupported action reached signer/server: signs=%d posts=%d", len(n.ids), len(s.bodies))
	}
}

func TestModerationRemovalBackendUsesStableBoundOperationOnRetry(t *testing.T) {
	n := &removalSignerFake{binding: native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}}
	s := &removalSessionFake{err: errors.New("response lost")}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	a := removalAction(moderation.ActionRemove)
	if err = b.EnforceModerationAction(context.Background(), a); err == nil {
		t.Fatal("first uncertain result returned nil")
	}
	s.err = nil
	if err = b.EnforceModerationAction(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if len(n.ids) != 2 || n.ids[0] != n.ids[1] || len(s.bodies) != 2 || string(s.bodies[0]) != string(s.bodies[1]) {
		t.Fatalf("retry changed operation: signer ids=%v bodies=%v", n.ids, s.bodies)
	}
	if n.groups[0] != testID(2) || n.targets[0] != 17 {
		t.Fatalf("signed wrong source: group=%s target=%d", n.groups[0], n.targets[0])
	}
}

func TestModerationRemovalBackendReturnsTypedServerAcceptance(t *testing.T) {
	binding := native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}
	n := &removalSignerFake{binding: binding}
	s := &removalSessionFake{receipt: client.ModerationRemovalReceipt{ActionID: testID(77), Revision: 31}}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	action := removalAction(moderation.ActionRemove)
	accepted, err := b.AcceptModerationAction(context.Background(), action)
	if err != nil {
		t.Fatal(err)
	}
	if !accepted.matches(action, binding) || accepted.actionID != s.receipt.ActionID || accepted.serverRevision != s.receipt.Revision {
		t.Fatalf("typed acceptance = %+v", accepted)
	}
	s.receipt = client.ModerationRemovalReceipt{}
	s.emptyReceipt = true
	if _, err := b.AcceptModerationAction(context.Background(), action); !errors.Is(err, client.ErrProtocol) {
		t.Fatalf("empty server receipt error = %v", err)
	}
}

func TestModerationRemovalBackendResignsOnlyAfterDefinitiveExpiry(t *testing.T) {
	n := &removalSignerFake{binding: native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}}
	s := &removalSessionFake{errs: []error{&client.APIError{Code: "E_REMOVAL_PROOF_EXPIRED", Outcome: client.OutcomeDefinitive}, nil}}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	a := removalAction(moderation.ActionRemove)
	a.ReceivedAt = time.Now().Add(-time.Minute)
	if err := b.EnforceModerationAction(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	if len(n.ids) != 2 || n.ids[0] != n.ids[1] || len(s.bodies) != 2 || string(s.bodies[0]) == string(s.bodies[1]) {
		t.Fatalf("expired proof retry = signs %d ids %v bodies %d, want same request with fresh proof", len(n.ids), n.ids, len(s.bodies))
	}
	if n.expires[0] > uint64(time.Now().Unix()) {
		t.Fatalf("test did not start with an expired event-time proof: expiry=%d", n.expires[0])
	}
	if n.expires[1] <= uint64(time.Now().Unix()) {
		t.Fatalf("fresh proof expiry %d is not in the future", n.expires[1])
	}
}

func TestModerationRemovalBackendDoesNotResignAfterUncertainOutcome(t *testing.T) {
	n := &removalSignerFake{binding: native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}}
	s := &removalSessionFake{err: errors.New("network outcome unknown")}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	a := removalAction(moderation.ActionRemove)
	if err := b.EnforceModerationAction(context.Background(), a); err == nil {
		t.Fatal("uncertain result returned nil")
	}
	if len(n.ids) != 1 || len(s.bodies) != 1 {
		t.Fatalf("uncertain attempt signed %d times and posted %d times", len(n.ids), len(s.bodies))
	}
}

func TestModerationRemovalOperationIDChangesWithSourceRevision(t *testing.T) {
	group, message := testID(2), testID(5)
	first := moderationRemovalOperationID(group, message, 17)
	if first.IsZero() || first != moderationRemovalOperationID(group, message, 17) {
		t.Fatal("operation id is not stable for the same source revision")
	}
	if first == moderationRemovalOperationID(group, message, 18) || first == moderationRemovalOperationID(group, testID(6), 17) {
		t.Fatal("different source event/revision reused operation id")
	}
}

func TestModerationRemovalBackendRejectsMissingOrCrossBindingSource(t *testing.T) {
	n := &removalSignerFake{binding: native.Binding{Instance: testID(8), Community: testID(1), Installation: testID(9)}}
	s := &removalSessionFake{}
	b, err := newModerationRemovalBackend(n, s)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []ModerationAction{func() ModerationAction { v := removalAction(moderation.ActionRemove); v.SourceRevision = 0; return v }(),
		func() ModerationAction { v := removalAction(moderation.ActionRemove); v.Group = ""; return v }(),
		func() ModerationAction {
			v := removalAction(moderation.ActionRemove)
			v.Community = testID(99).String()
			return v
		}()} {
		if err := b.EnforceModerationAction(context.Background(), a); !errors.Is(err, ErrModerationActionSource) {
			t.Fatalf("invalid source error = %v, want source refusal", err)
		}
	}
	if len(n.ids) != 0 || len(s.bodies) != 0 {
		t.Fatal("invalid source reached signer/server")
	}
}
