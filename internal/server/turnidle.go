package server

import (
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// turnAuthWindow is how long a relay connection may go from its accept to its first
	// authenticated request (branch review TURN-6). A browser sends its Allocate at once and its
	// authenticated retry one round trip after the 401 that carries the nonce; a connection that is
	// still unauthenticated after this is closed, so a peer that completes TLS, sends a STUN-looking
	// prefix and idles holds no goroutine, TLS state or file descriptor past it.
	turnAuthWindow = 30 * time.Second
	// turnIdleAfterAuth is how long a relay connection that holds an allocation may go without an
	// authenticated request. pion grants an allocation at most an hour (maximumAllocationLifetime),
	// and a client that keeps one sends an authenticated Refresh within its lifetime — Chrome every
	// 540 s, its permission refreshes every 240 s — so a connection that has sent none for longer
	// holds no live allocation.
	turnIdleAfterAuth = time.Hour + time.Minute
)

// turnIdleBounds are the bounds StartTURN gives its listener; a test shortens them.
var turnIdleBounds = struct{ auth, idle time.Duration }{turnAuthWindow, turnIdleAfterAuth}

// idleListener bounds the life of the relay's client connections in time. pion's read loop sets no
// deadline, and the 443 demux clears its own after the eight-byte peek, so without it a connection
// lives until its peer closes it. Every read of a connection fails past the connection's deadline:
// its accept time plus auth, moved to now plus idle only by the Allocate that creates its
// allocation (allocation) and by an authenticated request while it holds one (authenticated). A
// read past it fails, pion's read loop ends, deletes the connection's allocation and closes it.
//
// So bytes alone keep nothing open (re-review RR-1): neither unauthenticated requests, nor an
// Allocate pion refuses after authenticating it (a quota or the instance cap, 486), nor anything a
// device sends once a revocation has closed its relay socket or its credential has expired — none
// of them moves the deadline, and the connection is closed at the window or idle after the last
// request that did.
//
// A connection is found by its client transport address, the address pion's requests and events
// carry: the connection's own RemoteAddr, which behind the PROXY protocol is the address the header
// names.
type idleListener struct {
	net.Listener
	auth, idle time.Duration

	mu    sync.Mutex
	conns map[string]map[*idleConn]struct{}
}

func newIdleListener(ln net.Listener, auth, idle time.Duration) *idleListener {
	return &idleListener{Listener: ln, auth: auth, idle: idle, conns: map[string]map[*idleConn]struct{}{}}
}

// Accept wraps the next connection. Its remote address is not asked for here: a PROXY protocol
// listener reads the header to answer it, which must not hold up the accept loop.
func (l *idleListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	ic := &idleConn{Conn: c, l: l}
	ic.deadline.Store(time.Now().Add(l.auth).UnixNano())
	return ic, nil
}

// authenticated reports a request from src that pion has authenticated (OnAuth with verdict true):
// it moves the deadline of src's connections that hold an allocation.
func (l *idleListener) authenticated(src net.Addr) {
	l.each(src, func(c *idleConn) {
		if c.allocations > 0 {
			c.extend()
		}
	})
}

// allocation reports an allocation of src's created (delta 1, which moves the deadline) or deleted
// (delta -1).
func (l *idleListener) allocation(src net.Addr, delta int) {
	l.each(src, func(c *idleConn) {
		c.allocations += delta
		if delta > 0 {
			c.extend()
		}
	})
}

// each runs f on src's connections under the listener's lock.
func (l *idleListener) each(src net.Addr, f func(*idleConn)) {
	key := addrKey(src)
	l.mu.Lock()
	defer l.mu.Unlock()
	for c := range l.conns[key] {
		f(c)
	}
}

// register files c under key, its remote address.
func (l *idleListener) register(c *idleConn, key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if c.closed {
		return
	}
	c.key = key
	set := l.conns[c.key]
	if set == nil {
		set = map[*idleConn]struct{}{}
		l.conns[c.key] = set
	}
	set[c] = struct{}{}
}

func (l *idleListener) unregister(c *idleConn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	c.closed = true
	if set := l.conns[c.key]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(l.conns, c.key)
		}
	}
}

// idleConn is one relay client connection under idleListener's bounds. key, closed and allocations
// are guarded by the listener's mutex; registered is read and written by the reading goroutine
// only; deadline (unix nanoseconds) is written under the mutex and read by the reading goroutine.
type idleConn struct {
	net.Conn
	l           *idleListener
	deadline    atomic.Int64
	registered  bool
	key         string
	closed      bool
	allocations int
}

// extend moves c's deadline to now plus the idle bound; the listener's mutex is held.
func (c *idleConn) extend() {
	c.deadline.Store(time.Now().Add(c.l.idle).UnixNano())
}

func (c *idleConn) Read(p []byte) (int, error) {
	if !c.registered {
		// Outside the listener's lock: behind the PROXY protocol this reads the header.
		key := addrKey(c.RemoteAddr())
		c.registered = true
		c.l.register(c, key)
	}
	_ = c.SetReadDeadline(time.Unix(0, c.deadline.Load()))
	return c.Conn.Read(p)
}

func (c *idleConn) Close() error {
	c.l.unregister(c)
	return c.Conn.Close()
}
