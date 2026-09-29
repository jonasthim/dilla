package server

import "net/http"

// Mux is the stdlib ServeMux with Go 1.22 method-and-wildcard patterns. There
// is no router library: the patterns dillad needs are exactly what the stdlib
// parses, and the stdlib's conflict detection panics at registration, which a
// test relies on.
type Mux struct {
	mux *http.ServeMux
}

func NewMux() *Mux { return &Mux{mux: http.NewServeMux()} }

// Handle registers a pattern such as "POST /v1/groups/{id}/commit". A pattern
// that conflicts with one already registered panics, at start-up, on purpose.
func (m *Mux) Handle(pattern string, h http.Handler) { m.mux.Handle(pattern, h) }

func (m *Mux) HandleFunc(pattern string, h http.HandlerFunc) { m.mux.Handle(pattern, h) }

// Mux exposes the underlying ServeMux. It is the extension point parts 1b and 2
// register their handler groups through: without it a *server.Mux cannot be
// passed to a `Register(mux *http.ServeMux)` method and their routes are never
// mounted (deviation ID14).
func (m *Mux) Mux() *http.ServeMux { return m.mux }

func (m *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) { m.mux.ServeHTTP(w, r) }
