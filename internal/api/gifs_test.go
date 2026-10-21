package api_test

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
)

const testGiphyKey = "k-SECRET-giphy-key-0123"

// fakeGiphy is Giphy, faked: the search API and the media host in one httptest server. No test in
// this file reaches the real API.
type fakeGiphy struct {
	srv *httptest.Server

	mu       sync.Mutex
	searches []map[string]string // the query of every search and trending call
	paths    []string            // every path the media side served
	hits     atomic.Int32

	// media decides what /media/... answers; nil serves a small valid GIF.
	media func(w http.ResponseWriter, r *http.Request)
}

var tinyGIF = append([]byte("GIF89a"), bytes.Repeat([]byte{0}, 64)...)

func newFakeGiphy(t *testing.T) *fakeGiphy {
	t.Helper()
	f := &fakeGiphy{}
	mux := http.NewServeMux()
	search := func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		q := map[string]string{"path": r.URL.Path}
		for k, v := range r.URL.Query() {
			q[k] = v[0]
		}
		f.mu.Lock()
		f.searches = append(f.searches, q)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"data":[
			{"type":"gif","id":"abc123XYZ","title":"cat typing","images":{"fixed_width":{"url":"https://media2.giphy.com/x","width":"200","height":"113"},"original":{"url":"https://media2.giphy.com/y","width":"480","height":"270"}}},
			{"type":"gif","id":"../../etc/passwd","title":"evil id","images":{"fixed_width":{"width":"1","height":"1"}}},
			{"type":"gif","id":"def456","title":"dog","images":{"fixed_width":{"width":"200","height":"200"}}}
		],"pagination":{"total_count":100,"count":3,"offset":0},"meta":{"status":200}}`)
	}
	mux.HandleFunc("/v1/gifs/search", search)
	mux.HandleFunc("/v1/gifs/trending", search)
	mux.HandleFunc("/media/", func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		if f.media != nil {
			f.media(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(tinyGIF)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

type gifEnv struct {
	*env
	g     *api.Gifs
	fake  *fakeGiphy
	token string
	logs  *bytes.Buffer
}

func newGifEnv(t *testing.T, key string) *gifEnv {
	t.Helper()
	e := newEnv(t)
	fake := newFakeGiphy(t)
	logs := &bytes.Buffer{}
	cfg := config.Default().Giphy
	cfg.APIKey = key
	limiter := server.NewRateLimiter(config.Default().Limits.Rate, e.Clk)
	g := api.NewGifs(cfg, limiter, slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	api.UseFakeGiphyForTest(g, fake.srv)
	g.Register(e.Mux)
	_, tok := e.NewUser("gifter")
	return &gifEnv{env: e, g: g, fake: fake, token: tok, logs: logs}
}

func (ge *gifEnv) get(path string) (int, []byte, http.Header) {
	ge.t.Helper()
	resp := ge.Request(ge.t, http.MethodGet, path, ge.token, nil, nil)
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		ge.t.Fatal(err)
	}
	return resp.StatusCode, b, resp.Header
}

func TestGifRoutesAnswer404WithoutAKey(t *testing.T) {
	ge := newGifEnv(t, "")
	for _, path := range []string{"/v1/gifs/search?q=cat", "/v1/gifs/search", "/v1/gifs/media/abc123?r=preview", "/v1/gifs/media/abc123?r=full"} {
		status, body, _ := ge.get(path)
		if status != http.StatusNotFound || ge.ErrCode(body) != "E_NOT_FOUND" {
			t.Fatalf("%s = %d %x; want 404 E_NOT_FOUND", path, status, body)
		}
	}
	if n := ge.fake.hits.Load(); n != 0 {
		t.Fatalf("Giphy was contacted %d times without a key", n)
	}
}

func TestGifRoutesNeedASession(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for _, path := range []string{"/v1/gifs/search?q=cat", "/v1/gifs/media/abc123?r=preview"} {
		resp := ge.Request(t, http.MethodGet, path, "", nil, nil)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s without a session = %d %x; want 401", path, resp.StatusCode, body)
		}
	}
	if n := ge.fake.hits.Load(); n != 0 {
		t.Fatalf("Giphy was contacted %d times for an anonymous caller", n)
	}
}

func TestGifSearchAnswersIdsTitlesSizesAndProxyPathsAndHidesTheKey(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	status, body, hdr := ge.get("/v1/gifs/search?q=cat+typing&offset=24")
	if status != http.StatusOK {
		t.Fatalf("search = %d %x", status, body)
	}
	if got := hdr.Get("Content-Type"); got != "application/cbor" {
		t.Fatalf("content type = %q", got)
	}
	var out []cbor.RawMessage
	mustUnmarshalBody(t, body, &out)
	var items [][]any
	mustUnmarshal(t, out[0], &items)
	if len(items) != 2 {
		t.Fatalf("results = %v; want the two with a sane id (the traversal id is dropped)", items)
	}
	first := items[0]
	if first[0] != "abc123XYZ" || first[1] != "cat typing" || first[2] != uint64(200) || first[3] != uint64(113) ||
		first[4] != "/v1/gifs/media/abc123XYZ?r=preview" {
		t.Fatalf("first result = %v", first)
	}
	var next uint64
	mustUnmarshal(t, out[1], &next)
	if next != 27 { // offset 24 + count 3 of 100
		t.Fatalf("next offset = %d, want 27", next)
	}
	if bytes.Contains(body, []byte(testGiphyKey)) || bytes.Contains(body, []byte("giphy.com")) {
		t.Fatalf("the reply carries the key or a giphy URL: %q", body)
	}
	for k, v := range hdr {
		if strings.Contains(strings.Join(v, ","), testGiphyKey) {
			t.Fatalf("header %s carries the key", k)
		}
	}
	ge.fake.mu.Lock()
	defer ge.fake.mu.Unlock()
	q := ge.fake.searches[0]
	if q["path"] != "/v1/gifs/search" || q["api_key"] != testGiphyKey || q["q"] != "cat typing" ||
		q["offset"] != "24" || q["rating"] != "pg-13" || q["limit"] != "24" {
		t.Fatalf("upstream query = %v", q)
	}
}

func TestGifSearchWithoutAQueryIsTrendingAndNextOffsetEndsAtTheTotal(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	status, body, _ := ge.get("/v1/gifs/search")
	if status != http.StatusOK {
		t.Fatalf("trending = %d %x", status, body)
	}
	ge.fake.mu.Lock()
	path := ge.fake.searches[0]["path"]
	ge.fake.mu.Unlock()
	if path != "/v1/gifs/trending" {
		t.Fatalf("an empty query hit %q, want trending", path)
	}
}

func TestGifSearchRefusesAMalformedQuery(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for name, path := range map[string]string{
		"q too long":        "/v1/gifs/search?q=" + strings.Repeat("a", 101),
		"offset not a num":  "/v1/gifs/search?q=a&offset=x",
		"offset negative":   "/v1/gifs/search?q=a&offset=-1",
		"offset past limit": "/v1/gifs/search?q=a&offset=5000",
		"control char":      "/v1/gifs/search?q=a%00b",
	} {
		status, body, _ := ge.get(path)
		if status != http.StatusBadRequest || ge.ErrCode(body) != "E_INVALID_REQUEST" {
			t.Fatalf("%s = %d %x; want 400 E_INVALID_REQUEST", name, status, body)
		}
	}
	if n := ge.fake.hits.Load(); n != 0 {
		t.Fatalf("a malformed query reached Giphy %d times", n)
	}
}

func TestGifMediaFetchesOnlyTheGiphyPathForTheIdAndReturnsTheBytes(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for r, want := range map[string]string{"preview": "/media/abc123XYZ/200w.gif", "full": "/media/abc123XYZ/giphy.gif"} {
		status, body, hdr := ge.get("/v1/gifs/media/abc123XYZ?r=" + r)
		if status != http.StatusOK || !bytes.Equal(body, tinyGIF) {
			t.Fatalf("%s = %d %x", r, status, body)
		}
		if hdr.Get("Content-Type") != "image/gif" || hdr.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.HasPrefix(hdr.Get("Cache-Control"), "private") {
			t.Fatalf("%s headers = %v", r, hdr)
		}
		ge.fake.mu.Lock()
		got := ge.fake.paths[len(ge.fake.paths)-1]
		ge.fake.mu.Unlock()
		if got != want {
			t.Fatalf("%s fetched %q, want %q", r, got, want)
		}
	}
}

func TestGifMediaRefusesABadIdOrVariantBeforeAnyFetch(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for name, path := range map[string]string{
		"dot dot":          "/v1/gifs/media/..?r=full",
		"encoded slash":    "/v1/gifs/media/a%2Fb?r=full",
		"encoded traverse": "/v1/gifs/media/..%2F..%2Fetc?r=full",
		"host in the id":   "/v1/gifs/media/a.evil.com?r=full",
		"colon":            "/v1/gifs/media/a:80?r=full",
		"at sign":          "/v1/gifs/media/x@evil?r=full",
		"too long":         "/v1/gifs/media/" + strings.Repeat("a", 65) + "?r=full",
		"no variant":       "/v1/gifs/media/abc123",
		"bad variant":      "/v1/gifs/media/abc123?r=original",
		"two variants":     "/v1/gifs/media/abc123?r=full&r=preview",
	} {
		status, body, _ := ge.get(path)
		// The ServeMux cleans a literal ".." away before the handler (404); everything else the
		// handler itself refuses.
		if status == http.StatusNotFound && name == "dot dot" {
			continue
		}
		if status != http.StatusBadRequest || ge.ErrCode(body) != "E_INVALID_REQUEST" {
			t.Fatalf("%s = %d %x; want 400 E_INVALID_REQUEST", name, status, body)
		}
	}
	if n := ge.fake.hits.Load(); n != 0 {
		t.Fatalf("a refused id reached Giphy %d times", n)
	}
}

func TestNoUserSuppliedURLReachesTheFetch(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	var evil atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { evil.Add(1) }))
	t.Cleanup(other.Close)
	for _, extra := range []string{"url", "u", "host", "src", "media_url"} {
		path := "/v1/gifs/media/abc123XYZ?r=full&" + extra + "=" + other.URL + "/x.gif"
		if status, _, _ := ge.get(path); status != http.StatusOK {
			t.Fatalf("%s = %d", path, status)
		}
	}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, ge.Srv.URL+"/v1/gifs/media/abc123XYZ?r=full", nil)
	req.Header.Set("Authorization", "Bearer "+ge.token)
	req.Header.Set("X-Forwarded-Host", other.Listener.Addr().String())
	req.Header.Set("Referer", other.URL)
	req.Host = other.Listener.Addr().String()
	resp, err := ge.Srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if evil.Load() != 0 {
		t.Fatalf("a host outside the allow-list was fetched %d times", evil.Load())
	}
}

func TestGifMediaRefusesARedirectOffTheAllowList(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	var evil atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		evil.Add(1)
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(tinyGIF)
	}))
	t.Cleanup(other.Close)
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/steal.gif", http.StatusFound)
	}
	status, body, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full")
	if status == http.StatusOK || evil.Load() != 0 {
		t.Fatalf("redirect off the allow-list = %d (%d fetches of the other host), body %x", status, evil.Load(), body)
	}
}

func TestGifMediaFollowsARedirectInsideTheAllowListButNotForever(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/media/abc123XYZ/giphy.gif" {
			http.Redirect(w, r, "/media/hop/giphy.gif", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(tinyGIF)
	}
	if status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full"); status != http.StatusOK {
		t.Fatalf("one redirect inside the allow-list = %d, want 200", status)
	}
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Path, http.StatusFound) // a loop
	}
	if status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full"); status != http.StatusServiceUnavailable {
		t.Fatalf("a redirect loop = %d, want 503", status)
	}
}

func TestGifMediaEnforcesTheSizeCapOnTheBytesNotTheHeader(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	api.SetGiphyCapsForTest(ge.g, 100, 200)
	big := append([]byte("GIF89a"), bytes.Repeat([]byte{1}, 300)...)
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(big) // chunked: no honest Content-Length is promised
	}
	for r, cap := range map[string]int{"preview": 100, "full": 200} {
		status, body, _ := ge.get("/v1/gifs/media/abc123XYZ?r=" + r)
		if status == http.StatusOK || bytes.Contains(body, []byte("GIF89a")) {
			t.Fatalf("%s over the %d-byte cap = %d, want a refusal with no GIF bytes", r, cap, status)
		}
	}
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/gif")
		w.Header().Set("Content-Length", "1000000")
		_, _ = w.Write(tinyGIF[:10])
	}
	if status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full"); status == http.StatusOK {
		t.Fatalf("a declared length over the cap was accepted")
	}
}

func TestGifMediaChecksTheContentTypeAndTheGIFMagic(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for name, serve := range map[string]func(w http.ResponseWriter){
		"html":    func(w http.ResponseWriter) { w.Header().Set("Content-Type", "text/html"); _, _ = w.Write(tinyGIF) },
		"png":     func(w http.ResponseWriter) { w.Header().Set("Content-Type", "image/png"); _, _ = w.Write(tinyGIF) },
		"no type": func(w http.ResponseWriter) { w.Header()["Content-Type"] = nil; _, _ = w.Write(tinyGIF) },
		"gif type, html": func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "image/gif")
			_, _ = w.Write([]byte("<html>"))
		},
	} {
		ge.fake.media = func(w http.ResponseWriter, r *http.Request) { serve(w) }
		status, body, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full")
		if status == http.StatusOK || bytes.Contains(body, []byte("html")) {
			t.Fatalf("%s = %d %q; want a refusal", name, status, body)
		}
	}
}

func TestGifMediaMapsUpstreamStatuses(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	for upstream, want := range map[int]int{
		http.StatusNotFound:        http.StatusNotFound,
		http.StatusTooManyRequests: http.StatusServiceUnavailable,
		http.StatusBadGateway:      http.StatusServiceUnavailable,
		http.StatusForbidden:       http.StatusServiceUnavailable,
	} {
		ge.fake.media = func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(upstream) }
		if status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full"); status != want {
			t.Fatalf("upstream %d = %d, want %d", upstream, status, want)
		}
	}
}

func TestGifMediaTimesOut(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	api.SetGiphyTimeoutForTest(ge.g, 50*time.Millisecond)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}
	start := time.Now()
	status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full")
	if status != http.StatusServiceUnavailable || time.Since(start) > 5*time.Second {
		t.Fatalf("a hung upstream = %d after %s, want 503 within the timeout", status, time.Since(start))
	}
}

func TestGifFetchesAreBoundedInFlight(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	api.SetGiphyConcurrencyForTest(ge.g, 1)
	entered := make(chan struct{})
	release := make(chan struct{})
	ge.fake.media = func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(tinyGIF)
	}
	done := make(chan int)
	go func() {
		status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=full")
		done <- status
	}()
	<-entered
	status, body, _ := ge.get("/v1/gifs/media/other?r=full")
	if status != http.StatusServiceUnavailable || ge.ErrCode(body) != "E_UNAVAILABLE" {
		t.Fatalf("a second fetch while the slot is held = %d %x; want 503 E_UNAVAILABLE", status, body)
	}
	close(release)
	if first := <-done; first != http.StatusOK {
		t.Fatalf("the first fetch = %d", first)
	}
}

func TestGifSearchIsRateLimitedPerUser(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	_, other := ge.NewUser("bystander")
	var last int
	var lastBody []byte
	var lastHdr http.Header
	for i := 0; i < 11; i++ {
		last, lastBody, lastHdr = ge.get("/v1/gifs/search?q=cat")
	}
	if last != http.StatusTooManyRequests || ge.ErrCode(lastBody) != "E_RATE_LIMITED" || lastHdr.Get("Retry-After") == "" {
		t.Fatalf("the 11th search = %d %x, want 429 E_RATE_LIMITED with Retry-After", last, lastBody)
	}
	hitsAtLimit := ge.fake.hits.Load()
	ge.get("/v1/gifs/search?q=cat")
	if ge.fake.hits.Load() != hitsAtLimit {
		t.Fatal("a limited search still reached Giphy")
	}
	resp := ge.Request(t, http.MethodGet, "/v1/gifs/search?q=cat", other, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("another user's search = %d; the bucket must be per user", resp.StatusCode)
	}
}

func TestGifMediaIsRateLimitedPerUser(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	var limited bool
	for i := 0; i < 80 && !limited; i++ {
		status, _, _ := ge.get("/v1/gifs/media/abc123XYZ?r=preview")
		limited = status == http.StatusTooManyRequests
	}
	if !limited {
		t.Fatal("80 media fetches in a row were never limited")
	}
}

func TestTheKeyNeverReachesALogOrAnErrorBody(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	// An upstream that answers 500 and one that is gone, so the client's own error text (which
	// carries the request URL, and the URL carries api_key) is exercised.
	ge.fake.srv.Close()
	for _, path := range []string{"/v1/gifs/search?q=cat", "/v1/gifs/media/abc123XYZ?r=full"} {
		status, body, hdr := ge.get(path)
		if status != http.StatusServiceUnavailable {
			t.Fatalf("%s with Giphy gone = %d %x, want 503", path, status, body)
		}
		if bytes.Contains(body, []byte(testGiphyKey)) || strings.Contains(fmt.Sprint(hdr), testGiphyKey) {
			t.Fatalf("%s leaked the key to the caller", path)
		}
	}
	if strings.Contains(ge.logs.String(), testGiphyKey) {
		t.Fatalf("the key reached the log:\n%s", ge.logs.String())
	}
	if ge.logs.Len() == 0 {
		t.Fatal("an upstream failure left no log line for the operator")
	}
}

func TestTheKeyNeverReachesALogWhenGiphyAnswersAnError(t *testing.T) {
	ge := newGifEnv(t, testGiphyKey)
	ge.fake.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad key "+r.URL.Query().Get("api_key"), http.StatusUnauthorized)
	})
	status, body, _ := ge.get("/v1/gifs/search?q=cat")
	if status != http.StatusServiceUnavailable || bytes.Contains(body, []byte(testGiphyKey)) {
		t.Fatalf("Giphy 401 = %d %q; want 503 without the key", status, body)
	}
	if strings.Contains(ge.logs.String(), testGiphyKey) {
		t.Fatalf("the key reached the log:\n%s", ge.logs.String())
	}
}

func TestGiphyDialsNeverReachAPrivateAddress(t *testing.T) {
	for addr, refused := range map[string]bool{
		"127.0.0.1:443":         true,
		"[::1]:443":             true,
		"10.1.2.3:443":          true,
		"192.168.0.9:443":       true,
		"172.16.0.1:443":        true,
		"169.254.169.254:443":   true,
		"100.64.0.1:443":        true,
		"0.0.0.0:443":           true,
		"[fe80::1]:443":         true,
		"[fc00::1]:443":         true,
		"[::ffff:10.0.0.1]:443": true,
		"151.101.2.1:443":       false,
		"[2606:4700::1]:443":    false,
	} {
		err := api.GiphyDialGuardForTest(addr)
		if (err != nil) != refused {
			t.Fatalf("dial guard for %s = %v, refused want %v", addr, err, refused)
		}
	}
}

func TestTheProductionClientTalksOnlyToTheGiphyHosts(t *testing.T) {
	hosts, scheme := api.GiphyHostsForTest()
	if scheme != "https" {
		t.Fatalf("scheme = %q", scheme)
	}
	for _, h := range hosts {
		if !strings.HasSuffix(h, ".giphy.com") || strings.ContainsAny(h, "/:@") {
			t.Fatalf("allow-list entry %q is not a bare giphy.com host", h)
		}
	}
	if len(hosts) == 0 {
		t.Fatal("empty allow-list")
	}
	for url, ok := range map[string]bool{
		"https://media.giphy.com/media/a/giphy.gif": true,
		"https://media3.giphy.com/x":                true,
		"http://media.giphy.com/x":                  false,
		"https://giphy.com.evil.test/x":             false,
		"https://evilgiphy.com/x":                   false,
		"https://media.giphy.com.evil.test/x":       false,
		"https://media.giphy.com:8443/x":            false,
		"https://user@media.giphy.com/x":            false,
		"https://127.0.0.1/x":                       false,
	} {
		if got := api.GiphyAllowedForTest(url); got != ok {
			t.Fatalf("allowed(%s) = %v, want %v", url, got, ok)
		}
	}
}
