package client

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/cborx"
)

func TestBotInteractionGroupReadsUseInstallationScopedRoutes(t *testing.T) {
	const token = "interaction-read-token"
	installation, group := testID(7), testID(8)
	wantBase := "/v1/bot-runtime/installations/" + installation.String() + "/interaction-groups/" + group.String()
	var seen int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("missing session bearer on %s", r.URL.Path)
		}
		seen++
		switch {
		case r.Method == http.MethodGet && r.URL.Path == wantBase+"/info":
			payload := []any{uint64(2), []byte{1, 2}, make([]byte, 32), uint64(4)}
			reply(w, http.StatusOK, payload)
		case r.Method == http.MethodGet && (r.URL.Path == wantBase+"/messages" || r.URL.Path == wantBase+"/handshakes"):
			if r.URL.Query().Get("from") != "1" || r.URL.Query().Get("limit") != "8" {
				t.Errorf("page query = %s", r.URL.RawQuery)
			}
			reply(w, http.StatusOK, []any{})
		case r.Method == http.MethodPost && r.URL.Path == wantBase+"/cursor":
			var body []any
			if err := cborx.Unmarshal(readRequest(t, r), &body); err != nil || len(body) != 2 || body[0] != uint64(3) || body[1] != uint64(2) {
				t.Errorf("cursor body %v err=%v", body, err)
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.String())
			reply(w, http.StatusNotFound, []any{"E_NOT_FOUND", "", nil})
		}
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	c, err := New(Config{BaseURL: "https://example.invalid", HTTPClient: &http.Client{Transport: rewriteTransport{base: srv.Client().Transport, host: u.Host}}, InstanceID: testID(99), Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Discover(context.Background()); err != nil {
		t.Fatal(err)
	}
	s, err := c.Session(token)
	if err != nil {
		t.Fatal(err)
	}
	info, err := s.BotInteractionGroupInfo(context.Background(), installation, group)
	if err != nil || info.Epoch != 2 || info.NextSequence != 4 {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	for _, kind := range []string{"messages", "handshakes"} {
		if page, e := s.BotInteractionGroupPage(context.Background(), installation, group, kind, 1, 8); e != nil || len(page.Rows) != 0 {
			t.Fatalf("%s page=%+v err=%v", kind, page, e)
		}
	}
	if err := s.AdvanceBotInteractionGroupCursor(context.Background(), installation, group, 3, 2); err != nil {
		t.Fatal(err)
	}
	if seen != 4 {
		t.Fatalf("scoped route calls = %d, want 4", seen)
	}
}

func readRequest(t *testing.T, r *http.Request) []byte {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
