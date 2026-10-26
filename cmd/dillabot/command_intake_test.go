//go:build linux

package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/service"
)

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
