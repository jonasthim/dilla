//go:build linux

package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/id"
)

type namedGroupSync struct {
	steps *[]string
	err   error
}

func (s namedGroupSync) ReconcileInteractionGroupOnce(_ context.Context, _ *client.Session, group id.ID) (service.MembershipResult, error) {
	*s.steps = append(*s.steps, "interaction_sync:"+group.String())
	return service.MembershipResult{GroupsSynced: 1}, s.err
}

// The gateway fast path for a participant's message reads that one interaction group and then
// dispatches; it never runs the text-channel membership sweep, the trust pass or the sweep of
// every interaction group, which stay on the throttled general wake and on reconciliation.
func TestInteractionFastPathSyncsOnlyTheMessagedGroupBeforeDispatch(t *testing.T) {
	group := id.New()
	for _, denied := range []bool{false, true} {
		var steps []string
		refusal := errors.New("private source denied")
		sync := namedGroupSync{steps: &steps}
		if denied {
			sync.err = refusal
		}
		poll := newInteractionIntakePoller(sync, nil, commandDrainFunc(func(context.Context) (service.GroupEventPollResult, error) {
			steps = append(steps, "dispatch")
			return service.GroupEventPollResult{}, nil
		}))
		err := poll(t.Context(), group)
		want := []string{"interaction_sync:" + group.String(), "dispatch"}
		if denied {
			want = want[:1]
			if !errors.Is(err, refusal) {
				t.Fatalf("error=%v, want source refusal", err)
			}
		} else if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(steps, want) {
			t.Fatalf("steps=%v, want %v", steps, want)
		}
	}
}

type commandDrainFunc func(context.Context) (service.GroupEventPollResult, error)

func (f commandDrainFunc) Drain(ctx context.Context) (service.GroupEventPollResult, error) {
	return f(ctx)
}

func TestGatewayCommandIntakeReadsPrivateSourcesBeforeDispatch(t *testing.T) {
	for _, denied := range []bool{false, true} {
		name := "accepted private source"
		if denied {
			name = "denied private source"
		}
		t.Run(name, func(t *testing.T) {
			var steps []string
			sourceRead := false
			refusal := errors.New("private source denied")
			membership := readinessMembership{steps: &steps, sync: func(context.Context, *client.Session) error {
				if denied {
					return refusal
				}
				sourceRead = true
				return nil
			}}
			poll := newCommandIntakePoller(membership, readinessTrust{steps: &steps}, nil,
				func(context.Context) error { steps = append(steps, "subscribe"); return nil },
				commandDrainFunc(func(context.Context) (service.GroupEventPollResult, error) {
					if !sourceRead {
						t.Error("dispatch attempted before ingesting private command ciphertext")
					}
					steps = append(steps, "dispatch")
					return service.GroupEventPollResult{}, nil
				}))
			err := poll(t.Context())
			want := []string{"membership", "trust", "interaction_sync", "subscribe", "dispatch"}
			if denied {
				want = []string{"membership", "trust", "interaction_sync"}
				if !errors.Is(err, refusal) {
					t.Fatalf("error=%v, want source refusal", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(steps, want) {
				t.Fatalf("steps=%v, want %v", steps, want)
			}
		})
	}
}
