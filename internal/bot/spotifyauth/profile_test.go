package spotifyauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProfileReturnsAccountIDAndIgnoresProduct(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/me" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret-token" {
			t.Errorf("authorization header mismatch")
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"account_id":"acct_123-XYZ","product":"free","display_name":"private"}`))
	}))
	defer srv.Close()
	got, err := profileAt(context.Background(), srv.URL+"/v1/me", srv.Client(), "secret-token")
	if err != nil || got != "acct_123-XYZ" {
		t.Fatalf("Profile() = %q, %v", got, err)
	}
}

func TestProfileRejectsRedirectWithoutFollowing(t *testing.T) {
	destinationRequests := 0
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinationRequests++ }))
	defer destination.Close()
	source := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/steal", http.StatusFound)
	}))
	defer source.Close()
	if _, err := profileAt(context.Background(), source.URL, source.Client(), "secret"); err == nil {
		t.Fatal("expected redirect failure")
	}
	if destinationRequests != 0 {
		t.Fatalf("redirect destination received %d requests", destinationRequests)
	}
}

func TestProfileRejectsMalformedOversizedAndMissingIdentity(t *testing.T) {
	for name, body := range map[string]string{
		"malformed": `{`,
		"missing":   `{"display_name":"private"}`,
		"unsafe":    `{"account_id":"id with spaces"}`,
		"oversized": `{"account_id":"valid","padding":"` + strings.Repeat("x", maxProfileResponse) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			if id, err := profileAt(context.Background(), srv.URL, srv.Client(), "secret"); err == nil || id != "" {
				t.Fatalf("Profile() = %q, %v", id, err)
			}
		})
	}
}

func TestProfileErrorsDoNotExposeSensitiveValues(t *testing.T) {
	const token = "top-secret-access-token"
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `{"error":"%s","email":"person@example.test"}`, token)
	}))
	defer srv.Close()
	_, err := profileAt(context.Background(), srv.URL, srv.Client(), token)
	if err == nil || strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "person@example.test") {
		t.Fatalf("error leaked sensitive value: %v", err)
	}
}

func TestProfileHonorsCancellation(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := profileAt(ctx, srv.URL, srv.Client(), "secret"); err == nil {
		t.Fatal("expected canceled request failure")
	}
}
