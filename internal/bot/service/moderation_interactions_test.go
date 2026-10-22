package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type moderationInteractionReaderFake struct {
	actor id.ID
	limit uint64
	rows  []ModerationCase
	after []byte
	err   error
}

func (f *moderationInteractionReaderFake) List(_ context.Context, actor id.ID, after []byte, limit uint64) ([]ModerationCase, []byte, error) {
	f.actor, f.limit, f.after = actor, limit, append([]byte(nil), after...)
	return f.rows, []byte("next"), f.err
}

func TestModerationInteractionsListsBoundedCasesForAuthenticatedActor(t *testing.T) {
	reader := &moderationInteractionReaderFake{rows: []ModerationCase{{
		Community: interactionID(2).String(), Group: interactionID(4).String(), Channel: interactionID(5).String(),
		Actor: interactionID(6).String(), Message: interactionID(7).String(), SourceRevision: 42,
		Rules: []moderation.Rule{moderation.RuleDuplicate}, Action: moderation.ActionRemove, Excerpt: "bounded preview", ReceivedAt: time.Unix(1_800_000_000, 0),
	}}}
	h := ModerationInteractions{Reader: reader, CommunityID: interactionID(2)}
	handler := h.Handlers()[protocol.OpModerationCases]
	result, err := handler.Handle(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{
		CommunityID: interactionID(2), Args: []any{uint64(0)},
	})
	if err != nil || result.Status != 0 || reader.actor != interactionID(6) || reader.limit != moderationInteractionPageSize || len(reader.after) != 0 {
		t.Fatalf("result=%+v reader=%+v err=%v", result, reader, err)
	}
	var got []any
	if err := cborx.Unmarshal(result.Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != uint64(1) || len(got[1].([]any)) != 1 {
		t.Fatalf("encoded page = %#v", got)
	}
}

func TestModerationInteractionsOnlyServesInitialCursorlessPage(t *testing.T) {
	reader := &moderationInteractionReaderFake{}
	handler := (ModerationInteractions{Reader: reader, CommunityID: interactionID(2)}).Handlers()[protocol.OpModerationCases]
	result, err := handler.Handle(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{CommunityID: interactionID(2), Args: []any{uint64(1)}})
	if err != nil || result.Status != interactionStatusUnavailable || reader.actor != (id.ID{}) {
		t.Fatalf("result=%+v reader=%+v err=%v", result, reader, err)
	}
}

func TestModerationInteractionsFailClosedForMissingActorOrReaderError(t *testing.T) {
	for _, tc := range []struct {
		name  string
		actor id.ID
		err   error
	}{
		{name: "missing actor"},
		{name: "authorization denied", actor: interactionID(6), err: ErrModerationCaseUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader := &moderationInteractionReaderFake{err: tc.err}
			handler := (ModerationInteractions{Reader: reader, CommunityID: interactionID(2)}).Handlers()[protocol.OpModerationCases]
			result, err := handler.Handle(context.Background(), InteractionActor{User: tc.actor}, protocol.Request{CommunityID: interactionID(2), Args: []any{uint64(0)}})
			if tc.actor.IsZero() {
				if err == nil {
					t.Fatal("missing actor was accepted")
				}
			} else if !errors.Is(err, ErrModerationCaseUnauthorized) || result.Data != nil {
				t.Fatalf("result=%+v err=%v", result, err)
			}
		})
	}
}

func TestModerationInteractionsDoNotRegisterEvidenceMutation(t *testing.T) {
	handlers := (ModerationInteractions{Reader: &moderationInteractionReaderFake{}, CommunityID: interactionID(2)}).Handlers()
	if _, ok := handlers[protocol.OpModerationEvidence]; ok {
		t.Fatal("evidence operation registered without accepted moderation action context")
	}
}

func TestModerationInteractionsRemainUnreachableForUnboundInteractionGroups(t *testing.T) {
	reader := &moderationInteractionReaderFake{}
	h := ModerationInteractions{Reader: reader, CommunityID: interactionID(2)}
	d, event, binding := interactionFixture(t, h.Handlers())
	body := interactionBody(t, nil, interactionID(8), protocol.OpModerationCases, nil, nil, []any{uint64(0)})
	event.Body = &body
	d.native = &interactionNativeFake{binding: binding, group: native.GroupInfo{
		ID: event.Group, Kind: 3, Community: &binding.Community, Target: event.Channel, State: 2,
	}}
	if _, err := d.Dispatch(context.Background(), event); !errors.Is(err, protocol.ErrContext) {
		t.Fatalf("unbound interaction dispatch error = %v, want context refusal", err)
	}
	if !reader.actor.IsZero() {
		t.Fatal("case reader was called before native interaction group binding")
	}
}
