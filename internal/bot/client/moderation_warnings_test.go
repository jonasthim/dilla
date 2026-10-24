package client

import (
	"context"
	"net/http"
	"testing"
)

func TestAcceptedManualWarningUsesBoundLookupRouteAndReceipt(t *testing.T) {
	installation, request := testID(1), testID(2)
	action, community, actor, device, target := testID(3), testID(4), testID(5), testID(6), testID(7)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		if r.Method != http.MethodGet || r.URL.Path != "/v1/bot-runtime/installations/"+installation.String()+"/moderation/warnings/"+request.String() {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		reply(w, http.StatusOK, []any{request, action, community, actor, device, target, uint64(9), uint64(1_800_000_000)})
	}, 0)
	s, _ := c.Session("device-token")
	got, err := s.AcceptedManualWarning(context.Background(), installation, request)
	want := AcceptedManualWarningReceipt{RequestID: request, ActionID: action, CommunityID: community, ActorUserID: actor,
		ActorDeviceID: device, TargetUserID: target, Revision: 9, AcceptedAt: 1_800_000_000}
	if err != nil || got != want {
		t.Fatalf("receipt = %+v, err %v; want %+v", got, err, want)
	}
}

func TestAcceptedManualWarningRejectsMismatchedReceipt(t *testing.T) {
	installation, request := testID(1), testID(2)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		reply(w, http.StatusOK, []any{testID(8), testID(3), testID(4), testID(5), testID(6), testID(7), uint64(9), uint64(1_800_000_000)})
	}, 0)
	s, _ := c.Session("device-token")
	if _, err := s.AcceptedManualWarning(context.Background(), installation, request); err == nil {
		t.Fatal("mismatched request receipt was accepted")
	}
}
