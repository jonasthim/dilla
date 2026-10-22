package client

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

func TestIssueBotInteractionAdmissionReturnsExactSignedWire(t *testing.T) {
	installation, requestID, group := testID(10), testID(11), testID(12)
	participant, device := testID(13), testID(14)
	want := cbor(t, []any{[]byte{0x82, 0x01, 0x02}, make([]byte, 64)})
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/bot-runtime/installations/"+installation.String()+"/interaction-admissions" || r.Header.Get("Authorization") != "Bearer bot-session" {
			t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		fields, err := decode(body, 4)
		if err != nil {
			t.Errorf("request body: %v", err)
		}
		got := make([]id.ID, 4)
		for i := range got {
			got[i], _ = asID(fields[i])
		}
		if got[0] != requestID || got[1] != group || got[2] != participant || got[3] != device {
			t.Errorf("request tuple = %v", got)
		}
		w.Header().Set("Content-Type", "application/cbor")
		_, _ = w.Write(want)
	}, 0)
	s, _ := c.Session("bot-session")
	got, err := s.IssueBotInteractionAdmission(context.Background(), installation, requestID, group, participant, device)
	if err != nil || string(got) != string(want) {
		t.Fatalf("signed wire = %x, %v; want %x", got, err, want)
	}
}

func TestIssueBotInteractionAdmissionUncertainResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   []any
	}{
		{"server error", http.StatusServiceUnavailable, []any{"E_UNAVAILABLE", "retry", nil}},
		{"malformed success", http.StatusOK, []any{[]byte{1}, []byte{2}}},
		{"oversized success", http.StatusOK, []any{make([]byte, maxInteractionAdmissionResponse), make([]byte, 64)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/instance" {
					reply(w, http.StatusOK, discovery(testID(99)))
					return
				}
				reply(w, tc.status, tc.body)
			}, 0)
			s, _ := c.Session("bot-session")
			_, err := s.IssueBotInteractionAdmission(context.Background(), testID(20), testID(22), testID(23), testID(24), testID(25))
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.Outcome != OutcomeUnknown {
				t.Fatalf("uncertain response = %v, want outcome unknown", err)
			}
		})
	}
}

func TestIssueBotInteractionAdmissionRejectsMalformedAndCrossInstallation(t *testing.T) {
	installation := testID(20)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		if r.Header.Get("Authorization") != "Bearer bot-session" || r.URL.Path != "/v1/bot-runtime/installations/"+installation.String()+"/interaction-admissions" {
			reply(w, http.StatusForbidden, []any{"E_FORBIDDEN", "installation mismatch", nil})
			return
		}
		reply(w, http.StatusOK, []any{[]byte{1}, []byte{2}})
	}, 0)
	s, _ := c.Session("bot-session")
	if _, err := s.IssueBotInteractionAdmission(context.Background(), testID(21), testID(22), testID(23), testID(24), testID(25)); err == nil {
		t.Fatal("cross-installation request succeeded")
	}
	if _, err := s.IssueBotInteractionAdmission(context.Background(), installation, testID(22), testID(23), testID(24), testID(25)); err == nil {
		t.Fatal("malformed signature was accepted")
	}
	if _, err := s.IssueBotInteractionAdmission(context.Background(), installation, id.Zero, testID(23), testID(24), testID(25)); err == nil {
		t.Fatal("zero request ID was accepted")
	}
}
