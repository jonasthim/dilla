package spotifyauth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestExchangeSendsPKCEAndPreservesRedirectExactly(t *testing.T) {
	const redirect = "https://dilla.example/callback?source=bot%20settings"
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/token" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		if got := r.Header.Get("Content-Type"); !strings.HasPrefix(got, "application/x-www-form-urlencoded") {
			t.Errorf("content type=%q", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		want := url.Values{"grant_type": {"authorization_code"}, "code": {"a-code"}, "redirect_uri": {redirect}, "client_id": {"client"}, "code_verifier": {strings.Repeat("v", 43)}}
		if r.PostForm.Encode() != want.Encode() {
			t.Errorf("form=%v want=%v", r.PostForm, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "access", "token_type": "Bearer", "expires_in": 3600, "refresh_token": "refresh", "scope": "streaming user-read-email"})
	}))
	defer srv.Close()
	got, err := exchangeAt(context.Background(), srv.URL+"/api/token", srv.Client(), "client", redirect, "a-code", strings.Repeat("v", 43))
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessToken != "access" || got.RefreshToken != "refresh" || got.TokenType != "Bearer" || got.ExpiresIn != 3600 {
		t.Fatalf("token=%#v", got)
	}
	if got.String() == "" || strings.Contains(got.String(), "access") || strings.Contains(got.String(), "refresh") {
		t.Fatalf("sensitive String() = %q", got.String())
	}
	for _, format := range []string{"%v", "%+v", "%#v"} {
		formatted := fmt.Sprintf(format, got)
		if strings.Contains(formatted, got.AccessToken) || strings.Contains(formatted, got.RefreshToken) {
			t.Fatalf("format %s exposed credentials: %q", format, formatted)
		}
	}
	serialized, err := json.Marshal(got)
	if err != nil || strings.Contains(string(serialized), got.AccessToken) || strings.Contains(string(serialized), got.RefreshToken) {
		t.Fatal("token JSON exposed credentials")
	}
}

func TestExchangeRejectsOversizedAndMalformedResponses(t *testing.T) {
	for name, response := range map[string]string{"bad-json": "{", "missing-token": `{"token_type":"Bearer","expires_in":3600,"refresh_token":"r"}`, "wrong-type": `{"access_token":"a","token_type":"Basic","expires_in":3600,"refresh_token":"r"}`} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(response))
			}))
			defer srv.Close()
			if _, err := exchangeAt(context.Background(), srv.URL, srv.Client(), "client", "https://x/cb", "code", strings.Repeat("v", 43)); err == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(strings.Repeat("x", maxTokenResponse+1)))
	}))
	defer srv.Close()
	if _, err := exchangeAt(context.Background(), srv.URL, srv.Client(), "client", "https://x/cb", "code", strings.Repeat("v", 43)); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestExchangeUsesTenSecondRequestDeadline(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(250 * time.Millisecond):
		}
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := exchangeAt(ctx, srv.URL, srv.Client(), "client", "https://x/cb", "code", strings.Repeat("v", 43)); err == nil {
		t.Fatal("canceled request succeeded")
	}
}

func TestRefreshSendsRefreshGrantAndRetainsRefreshToken(t *testing.T) {
	const refresh = "secret-refresh-token"
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/token" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		want := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {"client"}}
		if r.PostForm.Encode() != want.Encode() {
			t.Errorf("form=%v want=%v", r.PostForm, want)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-access","token_type":"Bearer","expires_in":3600,"scope":"streaming"}`))
	}))
	defer srv.Close()

	got, err := refreshAt(context.Background(), srv.URL+"/api/token", srv.Client(), "client", refresh)
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessToken != "new-access" || got.RefreshToken != refresh || got.TokenType != "Bearer" || got.ExpiresIn != 3600 {
		t.Fatalf("unexpected refreshed token: %#v", got)
	}
}

func TestExchangeRejectsHTTPAndRefreshErrorsDoNotLeakCredentials(t *testing.T) {
	const secret = "secret-refresh-token"
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer plain.Close()
	if _, err := exchangeAt(context.Background(), plain.URL, plain.Client(), "client", "https://x/cb", "code", strings.Repeat("v", 43)); err == nil {
		t.Fatal("HTTP endpoint accepted")
	}

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error_description":"` + secret + `"}`))
	}))
	defer srv.Close()
	_, err := refreshAt(context.Background(), srv.URL, srv.Client(), "client", secret)
	if err == nil || strings.Contains(err.Error(), secret) || strings.Contains(fmt.Sprintf("%#v", err), secret) {
		t.Fatalf("error leaked refresh credential: %#v", err)
	}
}

func TestRefreshDoesNotFollowRedirects(t *testing.T) {
	var destinationRequests int
	destination := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		destinationRequests++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"unexpected","token_type":"Bearer","expires_in":3600,"refresh_token":"unexpected"}`))
	}))
	defer destination.Close()

	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, nil, destination.URL, http.StatusFound)
	}))
	defer origin.Close()
	if _, err := refreshAt(context.Background(), origin.URL, origin.Client(), "client", "refresh"); err == nil {
		t.Fatal("redirect response accepted")
	}
	if destinationRequests != 0 {
		t.Fatalf("redirect destination received %d request(s)", destinationRequests)
	}
}
