package api

import (
	"net/http/httptest"
	"net/url"
	"time"

	"github.com/jonasthim/dilla/internal/config"
)

// UseFakeGiphyForTest points g at an httptest server standing in for Giphy: the API and the media
// host are both that server, and it is the one host on the allow-list. The production dial guard is
// replaced with the test server's own client, since it listens on loopback.
func UseFakeGiphyForTest(g *Gifs, srv *httptest.Server) {
	u, _ := url.Parse(srv.URL)
	g.apiBase, g.mediaBase = srv.URL, srv.URL
	g.scheme, g.hosts = u.Scheme, []string{u.Host}
	c := *srv.Client()
	c.CheckRedirect = g.checkRedirect
	g.client = &c
}

// SetGiphyCapsForTest sets the preview and full size caps.
func SetGiphyCapsForTest(g *Gifs, preview, full int64) { g.maxPreview, g.maxFull = preview, full }

// SetGiphyTimeoutForTest sets the per-fetch timeout.
func SetGiphyTimeoutForTest(g *Gifs, d time.Duration) { g.timeout = d }

// SetGiphyConcurrencyForTest sets how many fetches may be in flight.
func SetGiphyConcurrencyForTest(g *Gifs, n int) { g.slots = make(chan struct{}, n) }

// GiphyDialGuardForTest is the production dial guard on a host:port.
func GiphyDialGuardForTest(addr string) error { return guardAddress(addr) }

// GiphyHostsForTest is the production allow-list and its scheme.
func GiphyHostsForTest() ([]string, string) {
	g := NewGifs(config.Giphy{}, nil, nil)
	return g.hosts, g.scheme
}

// GiphyAllowedForTest is the production allow-list's verdict on a URL.
func GiphyAllowedForTest(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return NewGifs(config.Giphy{}, nil, nil).allowed(u)
}
