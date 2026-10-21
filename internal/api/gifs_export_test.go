package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"time"
)

// pointAtForTest points g's bases and allow-list at an httptest server standing in for Giphy: the API and
// the media host are both that server, and it is the one host on the allow-list.
func pointAtForTest(g *Gifs, srv *httptest.Server) {
	u, _ := url.Parse(srv.URL)
	g.apiBase, g.mediaBase = srv.URL, srv.URL
	g.scheme, g.hosts = u.Scheme, []string{u.Host}
}

// UseFakeGiphyForTest points g at the fake and gives it the fake's own client, since the production dial guard
// refuses the loopback address an httptest server listens on.
func UseFakeGiphyForTest(g *Gifs, srv *httptest.Server) {
	pointAtForTest(g, srv)
	c := *srv.Client()
	c.CheckRedirect = g.checkRedirect
	g.client = &c
}

// UseFakeGiphyKeepingTransportForTest points g at the fake but keeps the production client, so the dial guard
// is in the path.
func UseFakeGiphyKeepingTransportForTest(g *Gifs, srv *httptest.Server) {
	pointAtForTest(g, srv)
	g.client = NewGifs(g.repo, nil, g.clk, g.log).client
	g.client.CheckRedirect = g.checkRedirect
}

// GiphyTransportForTest reports the production client's wiring: no proxy, a dial guard, a redirect check.
func GiphyTransportForTest(g *Gifs) (noProxy, redirectChecked bool) {
	t, ok := g.client.Transport.(*http.Transport)
	return ok && t.Proxy == nil && t.DialContext != nil, g.client.CheckRedirect != nil
}

// SetGiphyCapsForTest sets the preview and full size caps.
func SetGiphyCapsForTest(g *Gifs, preview, full int64) { g.maxPreview, g.maxFull = preview, full }

// SetGiphyTimeoutForTest sets the per-fetch timeout.
func SetGiphyTimeoutForTest(g *Gifs, d time.Duration) { g.timeout = d }

// SetGiphyWriteTimeoutForTest sets the per-reply write deadline.
func SetGiphyWriteTimeoutForTest(g *Gifs, d time.Duration) { g.writeTimeout = d }

// SetGiphySlotsForTest sets the instance's slots, one member's share and how long a request waits for a slot.
func SetGiphySlotsForTest(g *Gifs, global, perUser int, wait time.Duration) {
	g.slots, g.perUser, g.slotWait = make(chan struct{}, global), perUser, wait
}

// GiphyHeldForTest is how many slots are held right now.
func GiphyHeldForTest(g *Gifs) int { return len(g.slots) }

// GiphyDialGuardForTest is the production dial guard on a host:port.
func GiphyDialGuardForTest(addr string) error { return guardAddress(addr) }

// GiphyHostsForTest is the production allow-list and its scheme.
func GiphyHostsForTest() ([]string, string) {
	g := NewGifs(nil, nil, nil, nil)
	return g.hosts, g.scheme
}

// GiphyAllowedForTest is the production allow-list's verdict on a URL.
func GiphyAllowedForTest(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return NewGifs(nil, nil, nil, nil).allowed(u)
}
