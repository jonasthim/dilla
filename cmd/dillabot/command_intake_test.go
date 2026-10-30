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

// The gateway fast path for a participant's message reads that one interaction group, refreshes
// trust, then dispatches; it never runs the text-channel membership sweep or the sweep of every
// interaction group, which stay on the throttled general wake and on reconciliation.
func TestInteractionFastPathSyncsOnlyTheMessagedGroupBeforeDispatch(t *testing.T) {
	group := id.New()
	for _, denied := range []bool{false, true} {
		var steps []string
		refusal := errors.New("private source denied")
		sync := namedGroupSync{steps: &steps}
		if denied {
			sync.err = refusal
		}
		poll := newInteractionIntakePoller(sync, readinessTrust{steps: &steps}, nil, commandDrainFunc(func(context.Context) (service.GroupEventPollResult, error) {
			steps = append(steps, "dispatch")
			return service.GroupEventPollResult{}, nil
		}))
		err := poll(t.Context(), group)
		want := []string{"interaction_sync:" + group.String(), "trust", "dispatch"}
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

// pendingLeafCore models the native core: a message from a leaf whose signed list changed is held
// (app_pending_history) until the trust pass revalidates the leaf; dispatch only sees released events.
type pendingLeafCore struct{ held, released bool }

func (c *pendingLeafCore) ReconcileInteractionGroupOnce(context.Context, *client.Session, id.ID) (service.MembershipResult, error) {
	c.held = true // the participant's device list changed: the command arrives held for the list
	return service.MembershipResult{GroupsSynced: 1}, nil
}
func (c *pendingLeafCore) TrustPendingLeaves(context.Context, *client.Session) (uint32, error) {
	if !c.held {
		return 0, nil
	}
	c.held, c.released = false, true
	return 1, nil
}

// A command whose sender's device list changed reaches dispatch on the fast path: the trust pass
// runs between the group sync and Drain, as on the full path.
func TestInteractionFastPathReleasesAPendingLeafBeforeDispatch(t *testing.T) {
	core := &pendingLeafCore{}
	dispatched := false
	poll := newInteractionIntakePoller(core, core, nil, commandDrainFunc(func(context.Context) (service.GroupEventPollResult, error) {
		dispatched = core.released
		return service.GroupEventPollResult{}, nil
	}))
	if err := poll(t.Context(), id.New()); err != nil {
		t.Fatal(err)
	}
	if !dispatched {
		t.Fatal("the command from a pending leaf was still held when the fast path dispatched")
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
