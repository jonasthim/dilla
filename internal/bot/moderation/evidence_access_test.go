package moderation

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type evidenceState struct {
	binding native.Binding
	value   native.StateValue
	reads   int
}

func (s *evidenceState) Binding() native.Binding { return s.binding }
func (s *evidenceState) StateGet(_ context.Context, area uint64, key []byte) (native.StateValue, error) {
	s.reads++
	if area != evidenceStateArea || string(key) != string(evidenceKey(s.binding, testEvidenceID)) {
		return native.StateValue{}, errors.New("unexpected evidence state address")
	}
	return s.value, nil
}
func (*evidenceState) StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error) {
	return nil, errors.New("unused")
}

type evidenceAuthority struct {
	result  client.ActorAuthority
	present bool
	err     error
	calls   int
}

func (a *evidenceAuthority) BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error) {
	a.calls++
	return a.result, a.present, a.err
}

var testEvidenceID = id.ID{1}

func encodedEvidence(t *testing.T, binding native.Binding, evidenceID id.ID) native.StateValue {
	t.Helper()
	body, err := cborx.Marshal([]any{uint64(1), binding.Instance, binding.Community, binding.Installation,
		evidenceID, id.ID{2}, "remove", string(RuleDuplicate), "bounded excerpt", uint64(time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC).Unix())})
	if err != nil {
		t.Fatal(err)
	}
	return native.StateValue{Revision: 1, Value: body}
}

func TestEvidenceReadRequiresFreshViewAuditLogAuthority(t *testing.T) {
	binding := native.Binding{Instance: id.ID{3}, Community: id.ID{4}, Installation: id.ID{5}}
	state := &evidenceState{binding: binding, value: encodedEvidence(t, binding, testEvidenceID)}
	authority := &evidenceAuthority{result: client.ActorAuthority{EffectiveBits: permViewAuditLog}, present: true}
	reader := NewEvidenceReader(state, authority)
	got, err := reader.Read(context.Background(), id.ID{6}, testEvidenceID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Excerpt != "bounded excerpt" || got.MessageID != (id.ID{2}) || authority.calls != 1 || state.reads != 1 {
		t.Fatalf("evidence=%+v authority calls=%d state reads=%d", got, authority.calls, state.reads)
	}
	// A previously allowed actor can lose the permission; the next read must
	// resolve again before consulting the cached encrypted row.
	authority.result.EffectiveBits = 0
	if _, err := reader.Read(context.Background(), id.ID{6}, testEvidenceID); !errors.Is(err, ErrEvidenceAccess) {
		t.Fatalf("read after permission revocation = %v", err)
	}
	if authority.calls != 2 || state.reads != 1 {
		t.Fatalf("permission was not freshly checked: authority calls=%d state reads=%d", authority.calls, state.reads)
	}
}

func TestEvidenceReadFailsClosedBeforeEncryptedStateRead(t *testing.T) {
	for _, tc := range []struct {
		name      string
		authority *evidenceAuthority
	}{
		{name: "permission missing", authority: &evidenceAuthority{present: true}},
		{name: "actor absent", authority: &evidenceAuthority{}},
		{name: "lookup error", authority: &evidenceAuthority{present: true, err: errors.New("lookup unavailable")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			binding := native.Binding{Instance: id.ID{3}, Community: id.ID{4}, Installation: id.ID{5}}
			state := &evidenceState{binding: binding, value: encodedEvidence(t, binding, testEvidenceID)}
			_, err := NewEvidenceReader(state, tc.authority).Read(context.Background(), id.ID{6}, testEvidenceID)
			if err == nil {
				t.Fatal("unauthorized evidence read succeeded")
			}
			if state.reads != 0 {
				t.Fatalf("encrypted evidence read %d times before authorization", state.reads)
			}
		})
	}
}
