package server

import (
	"net/http"
	"sync"
)

// Mux is the stdlib ServeMux with Go 1.22 method-and-wildcard patterns. There
// is no router library: the patterns dillad needs are exactly what the stdlib
// parses, and the stdlib's conflict detection panics at registration, which a
// test relies on.
type Mux struct {
	mux *http.ServeMux
	// wrap, when set, is applied to every handler registered through this Mux
	// before it reaches mux (Wrapped).
	wrap func(pattern string, h http.Handler) http.Handler
	// seen is every pattern registered through this Mux and its Wrapped views, in order. It is
	// shared by the views, so it lists the whole ServeMux's Handle calls (Patterns).
	seen *patterns
}

type patterns struct {
	mu   sync.Mutex
	list []string
}

func NewMux() *Mux { return &Mux{mux: http.NewServeMux(), seen: &patterns{}} }

// Patterns is every pattern registered through Handle on this Mux or a Wrapped view of it. A
// route registered on Mux() directly is not listed. The route sweep of web3.6 reads it, so a
// mounted route that no protocol document lists fails a test instead of escaping it.
func (m *Mux) Patterns() []string {
	m.seen.mu.Lock()
	defer m.seen.mu.Unlock()
	return append([]string(nil), m.seen.list...)
}

// Handle registers a pattern such as "POST /v1/groups/{id}/commit". A pattern
// that conflicts with one already registered panics, at start-up, on purpose.
func (m *Mux) Handle(pattern string, h http.Handler) {
	if m.wrap != nil {
		h = m.wrap(pattern, h)
	}
	m.mux.Handle(pattern, h)
	m.seen.mu.Lock()
	m.seen.list = append(m.seen.list, pattern)
	m.seen.mu.Unlock()
}

func (m *Mux) HandleFunc(pattern string, h http.HandlerFunc) { m.Handle(pattern, h) }

// Wrapped returns a view of m that registers on the same ServeMux, with every
// handler passed through wrap first; wrap sees the pattern, so it can choose
// per route. It is how the composition root mounts a handler group whose
// Register mounts its handlers bare (Plan 2's): the view puts the session
// middleware and the rate meter in front of each route the group registers,
// and a route registered on m itself is untouched.
func (m *Mux) Wrapped(wrap func(pattern string, h http.Handler) http.Handler) *Mux {
	return &Mux{mux: m.mux, wrap: wrap, seen: m.seen}
}

// Mux exposes the underlying ServeMux. It is the extension point parts 1b and 2
// register their handler groups through: without it a *server.Mux cannot be
// passed to a `Register(mux *http.ServeMux)` method and their routes are never
// mounted (deviation ID14).
func (m *Mux) Mux() *http.ServeMux { return m.mux }

func (m *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) { m.mux.ServeHTTP(w, r) }
