package main

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/id"
)

type readyFake struct {
	requests []id.ID
	wantID   id.ID
	result   client.Installation
	err      error
}

func (f *readyFake) MarkReady(_ context.Context, installation, request id.ID, revision uint64) (client.Installation, error) {
	if installation != f.wantID || revision != 7 {
		return client.Installation{}, errors.New("wrong readiness scope")
	}
	f.requests = append(f.requests, request)
	return f.result, f.err
}

func TestReadinessUsesStableRequestAndDefersUnjoinedGroups(t *testing.T) {
	inst := client.Installation{ID: id.New(), CommunityID: id.New(), State: 2, Revision: 7}
	f := &readyFake{wantID: inst.ID, result: inst, err: &client.APIError{Status: http.StatusConflict, Code: "E_INVALID_REQUEST"}}
	for i := 0; i < 2; i++ {
		ready, err := markReadyAfterMembership(context.Background(), f, inst)
		if err != nil || ready {
			t.Fatalf("pending readiness = %v, %v", ready, err)
		}
	}
	if len(f.requests) != 2 || f.requests[0] != f.requests[1] || f.requests[0].IsZero() {
		t.Fatalf("readiness request was not stable: %v", f.requests)
	}
	f.err = nil
	f.result.State, f.result.Revision = 3, 8
	ready, err := markReadyAfterMembership(context.Background(), f, inst)
	if err != nil || !ready {
		t.Fatalf("accepted readiness = %v, %v", ready, err)
	}
	if f.requests[2] != f.requests[0] {
		t.Fatal("accepted retry changed request ID")
	}
}

func TestReadinessRefusesMalformedSuccessAndSkipsOtherStates(t *testing.T) {
	inst := client.Installation{ID: id.New(), CommunityID: id.New(), State: 2, Revision: 7}
	for _, tc := range []struct {
		name string
		row  client.Installation
	}{
		{"wrong-installation", client.Installation{ID: id.New(), CommunityID: inst.CommunityID, State: 3, Revision: 8}},
		{"wrong-community", client.Installation{ID: inst.ID, CommunityID: id.New(), State: 3, Revision: 8}},
		{"still-joining", client.Installation{ID: inst.ID, CommunityID: inst.CommunityID, State: 2, Revision: 8}},
		{"stale-revision", client.Installation{ID: inst.ID, CommunityID: inst.CommunityID, State: 3, Revision: 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &readyFake{wantID: inst.ID, result: tc.row}
			if _, err := markReadyAfterMembership(context.Background(), f, inst); err == nil {
				t.Fatal("accepted malformed readiness result")
			}
		})
	}
	f := &readyFake{wantID: inst.ID, result: inst}
	inst.State = 1
	if ready, err := markReadyAfterMembership(context.Background(), f, inst); ready || err != nil || len(f.requests) != 0 {
		t.Fatalf("non-joining installation attempted readiness: ready=%v err=%v calls=%d", ready, err, len(f.requests))
	}
}
