package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/server"
)

// Gifs is the GIF picker's server side (E8, ruling R3). Two routes, both 404 while giphy.api_key is
// empty:
//
//	GET /v1/gifs/search?q=&offset=     search (or trending when q is empty); ids, titles, sizes and
//	                                   paths of THIS server's media route, never a Giphy URL
//	GET /v1/gifs/media/{id}?r=preview|full   the GIF's bytes, fetched by the server
//
// The privacy claims it keeps, each pinned by a test:
//   - Giphy sees dillad, never a person: the key and every upstream request live here.
//   - Readers' browsers never contact giphy.com: the picker downloads the GIF through the media
//     route and sends it as an ordinary encrypted attachment.
//   - No user-supplied URL reaches a fetch. The media route takes a Giphy id (letters and digits,
//     checked), builds the URL itself from a host on the allow-list, and refuses a redirect, in the
//     fetch or the dial, that leaves it.
//   - The API key never leaves the process: it is in no reply, header or log line.
type Gifs struct {
	cfg     config.Giphy
	limiter *server.RateLimiter
	log     *slog.Logger

	client  *http.Client
	apiBase string // the scheme and host of Giphy's API, no trailing slash
	// mediaBase is the scheme and host the media URL is built on; its host is on hosts.
	mediaBase string
	scheme    string   // the one scheme the allow-list admits
	hosts     []string // every host (with its port, if not the default) a fetch or redirect may reach

	timeout    time.Duration
	maxPreview int64
	maxFull    int64
	slots      chan struct{}
}

// The production allow-list: Giphy's API host and its media hosts. Nothing else is ever dialled.
var giphyHosts = []string{
	"api.giphy.com",
	"media.giphy.com", "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com", "media4.giphy.com",
}

const (
	giphyAPIBase   = "https://api.giphy.com"
	giphyMediaBase = "https://media.giphy.com"

	gifPageSize      = 24
	gifMaxOffset     = 4999 // Giphy refuses an offset past this
	gifMaxQueryBytes = 100
	gifMaxIDBytes    = 64
	gifMaxRedirects  = 3
	gifMaxJSONBytes  = 1 << 20

	// gifMaxFull is the size cap of the full GIF: the 25 MB the plan names, well under
	// limits.max_attachment_bytes, so the attachment path never refuses what this route served.
	gifMaxFull    = 25 << 20
	gifMaxPreview = 5 << 20

	// gifSlots bounds the fetches in flight, so the memory a burst of picks can hold is bounded:
	// 8 slots of at most 25 MiB.
	gifSlots   = 8
	gifTimeout = 15 * time.Second
)

// The two per-user buckets. A search is one upstream call against the operator's Giphy quota; a
// preview grid is up to 24 media fetches, so the media bucket is far wider.
var (
	gifSearchClass = server.Class{Name: "gif_search", PerSecond: 1, Burst: 10}
	gifMediaClass  = server.Class{Name: "gif_media", PerSecond: 20, Burst: 60}
)

// NewGifs builds the routes. limiter is the instance's rate limiter (nil meters nothing, for the
// handler tests that do not care).
func NewGifs(cfg config.Giphy, limiter *server.RateLimiter, log *slog.Logger) *Gifs {
	g := &Gifs{
		cfg: cfg, limiter: limiter, log: log,
		apiBase: giphyAPIBase, mediaBase: giphyMediaBase, scheme: "https", hosts: giphyHosts,
		timeout: gifTimeout, maxPreview: gifMaxPreview, maxFull: gifMaxFull,
		slots: make(chan struct{}, gifSlots),
	}
	g.client = &http.Client{
		Transport: &http.Transport{
			// No proxy, no environment: a dilla.toml is the whole configuration.
			Proxy: nil,
			// A name on the allow-list that resolves to a private address (a poisoned resolver, a
			// rebinding record) is refused at connect time.
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, Control: dialGuard}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			MaxIdleConns:          4,
			IdleConnTimeout:       30 * time.Second,
			ForceAttemptHTTP2:     true,
		},
	}
	g.client.CheckRedirect = g.checkRedirect
	return g
}

// Register mounts the two routes. They are always mounted: with no key they answer 404, so a client
// learns "off" from the route itself as well as from the discovery document.
func (g *Gifs) Register(mux *server.Mux) {
	mux.HandleFunc("GET /v1/gifs/search", g.search)
	mux.HandleFunc("GET /v1/gifs/media/{id}", g.media)
}

// allowed is the allow-list: the one scheme, a host on the list, no userinfo. The host is compared
// whole (with its port), so "media.giphy.com:8443" and "media.giphy.com.evil.test" are both out.
func (g *Gifs) allowed(u *url.URL) bool {
	if u == nil || u.Scheme != g.scheme || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Host)
	for _, h := range g.hosts {
		if host == h {
			return true
		}
	}
	return false
}

var errRedirectOff = errors.New("redirect to a host that is not on the allow-list")
var errTooManyRedirects = errors.New("too many redirects")

func (g *Gifs) checkRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > gifMaxRedirects {
		return errTooManyRedirects
	}
	if !g.allowed(req.URL) {
		return errRedirectOff
	}
	return nil
}

// dialGuard refuses a connection to an address that is not a public unicast one.
func dialGuard(_, address string, _ syscall.RawConn) error { return guardAddress(address) }

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),  // IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),   // reserved
	netip.MustParsePrefix("64:ff9b::/96"),  // NAT64: embeds an IPv4 address this check cannot see
}

func guardAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("gifs: dial target is not host:port")
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return errors.New("gifs: dial target is not an IP address")
	}
	ip = ip.Unmap()
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return errors.New("gifs: refusing to connect to a non-public address")
	}
	for _, p := range nonPublicPrefixes {
		if p.Contains(ip) {
			return errors.New("gifs: refusing to connect to a non-public address")
		}
	}
	return nil
}

// upstream failures, mapped to one reply each by fail.
var (
	errGifNotFound    = errors.New("giphy has no such gif")
	errGifUnavailable = errors.New("giphy is unavailable")
	errGifBadBody     = errors.New("giphy sent something that is not a gif")
)

// describe is an error's text with the request URL (which carries api_key) left out: net/http wraps
// every transport error in a *url.Error whose text begins with the full URL.
func (g *Gifs) describe(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	msg := err.Error()
	if g.cfg.APIKey != "" {
		msg = strings.ReplaceAll(msg, g.cfg.APIKey, "[key]")
	}
	return msg
}

// get fetches rawURL, which the caller built from allow-listed parts, and returns at most max bytes
// of its body. The slot, the timeout and the cap bound what one call can hold.
func (g *Gifs) get(ctx context.Context, rawURL string, max int64, contentType func(string) bool) ([]byte, error) {
	select {
	case g.slots <- struct{}{}:
		defer func() { <-g.slots }()
	default:
		return nil, errGifBusy
	}
	ctx, cancel := context.WithTimeout(ctx, g.timeout)
	defer cancel()
	u, err := url.Parse(rawURL)
	if err != nil || !g.allowed(u) {
		// A bug, not a request: every URL here is built from the allow-list.
		g.log.Error("gifs: refusing a fetch off the allow-list")
		return nil, errGifUnavailable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, errGifUnavailable
	}
	req.Header.Set("User-Agent", "dilla-gifs")
	resp, err := g.client.Do(req)
	if err != nil {
		g.log.Warn("gifs: upstream request failed", "err", g.describe(err))
		return nil, errGifUnavailable
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusNotFound:
		return nil, errGifNotFound
	default:
		g.log.Warn("gifs: upstream refused", "status", resp.StatusCode)
		return nil, errGifUnavailable
	}
	if resp.ContentLength > max {
		g.log.Warn("gifs: upstream body over the cap", "declared", resp.ContentLength, "cap", max)
		return nil, errGifBadBody
	}
	if contentType != nil && !contentType(resp.Header.Get("Content-Type")) {
		g.log.Warn("gifs: upstream content type refused", "type", resp.Header.Get("Content-Type"))
		return nil, errGifBadBody
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		g.log.Warn("gifs: upstream body failed", "err", g.describe(err))
		return nil, errGifUnavailable
	}
	if int64(len(body)) > max {
		g.log.Warn("gifs: upstream body over the cap", "cap", max)
		return nil, errGifBadBody
	}
	return body, nil
}

var errGifBusy = errors.New("too many gif fetches in flight")

func gifIsGIF(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	return err == nil && mt == "image/gif"
}

func (g *Gifs) fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errGifNotFound):
		server.WriteError(w, server.Errorf(server.CodeNotFound, "no such gif"))
	case errors.Is(err, errGifBusy):
		server.WriteError(w, server.Unavailable(1000, "gif fetches are busy; try again"))
	case errors.Is(err, errGifBadBody):
		server.WriteError(w, server.Unavailable(5000, "the gif service sent something unusable"))
	default:
		server.WriteError(w, server.Unavailable(5000, "the gif service is unavailable"))
	}
}

// gate is what both routes start with: 404 without a key, an enrolled session, then the caller's
// bucket. It returns the refusal to write, or nil.
func (g *Gifs) gate(r *http.Request, class server.Class) error {
	if !g.cfg.Enabled() {
		return server.Errorf(server.CodeNotFound, "no such object")
	}
	s, err := enrolledSession(r)
	if err != nil {
		return err
	}
	if g.limiter != nil {
		if ok, wait := g.limiter.Allow(class, s.UserID.String()); !ok {
			return server.RateLimitedAfter(wait)
		}
	}
	return nil
}

func cleanTitle(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	if utf8.RuneCountInString(s) > 120 {
		s = string([]rune(s)[:120])
	}
	return strings.TrimSpace(s)
}

// validGifID is a Giphy id: letters and digits. Anything else (a dot, a slash, a colon, an @) could
// steer the URL built from it, so it is refused before a URL exists.
func validGifID(id string) bool {
	if id == "" || len(id) > gifMaxIDBytes {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

type giphyList struct {
	Data []struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Images struct {
			FixedWidth struct {
				Width  json.RawMessage `json:"width"`
				Height json.RawMessage `json:"height"`
			} `json:"fixed_width"`
		} `json:"images"`
	} `json:"data"`
	Pagination struct {
		TotalCount int `json:"total_count"`
		Count      int `json:"count"`
		Offset     int `json:"offset"`
	} `json:"pagination"`
}

// dim reads a Giphy dimension, a number or a numeric string, clamped to a sane range.
func dim(raw json.RawMessage) uint64 {
	n, err := strconv.Atoi(strings.Trim(string(raw), `" `))
	if err != nil || n < 0 || n > 4000 {
		return 0
	}
	return uint64(n)
}

func (g *Gifs) search(w http.ResponseWriter, r *http.Request) {
	if err := g.gate(r, gifSearchClass); err != nil {
		server.WriteError(w, err)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > gifMaxQueryBytes || !utf8.ValidString(q) || strings.IndexFunc(q, unicode.IsControl) >= 0 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "q is at most %d bytes of text", gifMaxQueryBytes))
		return
	}
	offset := uint64(0)
	if v := r.URL.Query().Get("offset"); v != "" {
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil || n > gifMaxOffset {
			server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "offset is 0..%d", gifMaxOffset))
			return
		}
		offset = n
	}
	params := url.Values{}
	params.Set("api_key", g.cfg.APIKey)
	params.Set("limit", strconv.Itoa(gifPageSize))
	params.Set("offset", strconv.FormatUint(offset, 10))
	params.Set("rating", g.cfg.Rating)
	params.Set("bundle", "messaging_non_clips")
	path := "/v1/gifs/trending"
	if q != "" {
		path = "/v1/gifs/search"
		params.Set("q", q)
		params.Set("lang", "en")
	}
	body, err := g.get(r.Context(), g.apiBase+path+"?"+params.Encode(), gifMaxJSONBytes, nil)
	if err != nil {
		g.fail(w, err)
		return
	}
	var list giphyList
	if err := json.Unmarshal(body, &list); err != nil {
		g.log.Warn("gifs: upstream search body is not json", "err", g.describe(err))
		g.fail(w, errGifBadBody)
		return
	}
	items := make([]any, 0, len(list.Data))
	for _, d := range list.Data {
		if !validGifID(d.ID) {
			continue // never echo an id a client would put in a path
		}
		items = append(items, []any{
			d.ID, cleanTitle(d.Title), dim(d.Images.FixedWidth.Width), dim(d.Images.FixedWidth.Height),
			"/v1/gifs/media/" + d.ID + "?r=preview",
		})
	}
	var next *uint64
	if end := offset + uint64(max(len(list.Data), 0)); len(list.Data) > 0 && end < uint64(max(list.Pagination.TotalCount, 0)) && end <= gifMaxOffset {
		next = &end
	}
	if err := server.EncodeBody(w, http.StatusOK, []any{items, next}); err != nil {
		g.log.Error("gifs: encode search", "err", err)
	}
}

func (g *Gifs) media(w http.ResponseWriter, r *http.Request) {
	if err := g.gate(r, gifMediaClass); err != nil {
		server.WriteError(w, err)
		return
	}
	id := r.PathValue("id")
	variants := r.URL.Query()["r"]
	if !validGifID(id) || len(variants) != 1 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "a gif id and r=preview|full are required"))
		return
	}
	var file string
	var limit int64
	switch variants[0] {
	case "preview":
		file, limit = "200w.gif", g.maxPreview
	case "full":
		file, limit = "giphy.gif", g.maxFull
	default:
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "r is preview or full"))
		return
	}
	// The URL is built here, from the allow-listed media host and the checked id. Nothing the
	// caller sent, but the id and the variant, is in it.
	body, err := g.get(r.Context(), g.mediaBase+"/media/"+id+"/"+file, limit, gifIsGIF)
	if err != nil {
		g.fail(w, err)
		return
	}
	if !bytes.HasPrefix(body, []byte("GIF87a")) && !bytes.HasPrefix(body, []byte("GIF89a")) {
		g.log.Warn("gifs: upstream bytes are not a gif")
		g.fail(w, errGifBadBody)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/gif")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(body); err != nil {
		g.log.Debug("gifs: write media", "err", fmt.Sprint(err))
	}
}
