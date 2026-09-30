package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// stunMagicCookie is RFC 8489 §5's fixed value, in network byte order.
const stunMagicCookie uint32 = 0x2112A442

// peekLen is how many bytes the demux reads after the handshake to choose a
// branch. Eight is the right peek: fewer cannot check the cookie, more risks
// blocking on a client that writes its first request in small pieces.
const peekLen = 8

// LooksLikeSTUN implements RFC 8489 §5: the leading two bits "MUST be zeroes",
// explicitly "enabling differentiation from other protocols during
// multiplexing", and the magic cookie occupies bytes [4:8]. Every HTTP/1.1
// method token and the HTTP/2 preface are at least eight bytes and begin with
// an uppercase ASCII letter (>= 0x41), so the top-bits test already separates
// them and the cookie is the belt to that braces.
func LooksLikeSTUN(b []byte) bool {
	return len(b) >= peekLen &&
		b[0]&0xC0 == 0 &&
		binary.BigEndian.Uint32(b[4:8]) == stunMagicCookie
}

// peekConn replays the bytes the demuxer consumed and keeps the TLS state
// visible to net/http. Go 1.27's Server reads ConnectionState() off a
// user-provided net.Conn, so r.TLS is populated and h2 still negotiates.
//
// Through the embedded *tls.Conn the type satisfies BOTH of net/http's optional
// interfaces: connectionStater and handshakeContexter. The promoted
// HandshakeContext is a no-op here because Demux.Serve already completed the
// handshake, and tls.Conn.HandshakeContext returns immediately once it has. Do
// not "fix" this by dropping the embedding: ConnectionState() would go with it,
// and r.TLS would be nil.
//
// One accepted loss: pion/turn v5.0.13's Server.readListener does
// `tlsConn, ok := conn.(*tls.Conn)`, and a *peekConn is not a *tls.Conn, so
// turn.RequestAttributes.TLS stays nil on the TURN branch. dilla's TURN auth
// handler is HMAC over the username and never reads it, but a future "require a
// client certificate" rule written against RequestAttributes.TLS would silently
// never fire.
type peekConn struct {
	*tls.Conn
	r io.Reader
}

func (c *peekConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func newPeekConn(tc *tls.Conn, peeked []byte) *peekConn {
	return &peekConn{Conn: tc, r: io.MultiReader(bytes.NewReader(peeked), tc)}
}

// Demux terminates TLS on the one public TCP port and splits each connection
// by its first bytes: a STUN header goes to the TURN branch, everything else —
// HTTP/1.1, the h2 preface, a client that has not said anything yet — to the
// HTTP branch. ALPN cannot do the job: a browser's RTCIceServer has no ALPN
// member, so a `turns:` connection negotiates "" like any other.
type Demux struct {
	raw        net.Listener
	tlsCfg     *tls.Config
	timeout    time.Duration
	http, turn *chanListener

	// pending holds the raw connections still being handshaken or peeked, so
	// Close can cut them short instead of waiting out the timeout.
	mu      sync.Mutex
	pending map[net.Conn]struct{}
	closed  bool

	closeOnce sync.Once
	closeErr  error
	wg        sync.WaitGroup
}

// NewDemux wraps raw, which must be a plain TCP listener: the demux does the
// TLS handshake itself, bounded by handshakeTimeout, and gives the peek the same
// bound.
func NewDemux(raw net.Listener, tlsCfg *tls.Config, handshakeTimeout time.Duration) *Demux {
	return &Demux{
		raw: raw, tlsCfg: tlsCfg, timeout: handshakeTimeout,
		http:    newChanListener(raw.Addr()),
		turn:    newChanListener(raw.Addr()),
		pending: map[net.Conn]struct{}{},
	}
}

// HTTP is the branch http.Server.Serve accepts from.
func (d *Demux) HTTP() net.Listener { return d.http }

// TURN is the branch turn.ListenerConfig.Listener accepts from. A caller that
// runs no TURN server closes it, and the demux then closes every STUN
// connection it routes there.
func (d *Demux) TURN() net.Listener { return d.turn }

// Serve accepts until the raw listener is closed. Each connection is handled on
// its own goroutine, so a slow handshake never holds up the next accept.
func (d *Demux) Serve() {
	var backoff time.Duration
	for {
		nc, err := d.raw.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || d.isClosed() {
				return
			}
			// A transient accept failure (EMFILE and friends): back off as
			// net/http does, rather than spin.
			backoff = min(max(2*backoff, 5*time.Millisecond), time.Second)
			time.Sleep(backoff)
			continue
		}
		backoff = 0
		if !d.track(nc) {
			_ = nc.Close()
			return
		}
		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			d.route(nc)
		}()
	}
}

func (d *Demux) isClosed() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.closed
}

// track records nc as in flight; false means the demux is already closed.
func (d *Demux) track(nc net.Conn) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return false
	}
	d.pending[nc] = struct{}{}
	return true
}

func (d *Demux) untrack(nc net.Conn) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.pending, nc)
}

func (d *Demux) route(nc net.Conn) {
	defer d.untrack(nc)
	tc := tls.Server(nc, d.tlsCfg)
	ctx, cancel := context.WithTimeout(context.Background(), d.timeout)
	defer cancel()
	if err := tc.HandshakeContext(ctx); err != nil {
		_ = nc.Close()
		return
	}
	// An acme-tls/1 handshake is the CA's TLS-ALPN-01 validation: certmagic
	// answered it inside GetCertificate, and the validator hangs up without
	// sending a byte. Nothing to route.
	if tc.ConnectionState().NegotiatedProtocol == "acme-tls/1" {
		_ = tc.Close()
		return
	}

	hdr := make([]byte, peekLen)
	_ = tc.SetReadDeadline(time.Now().Add(d.timeout))
	n, err := io.ReadFull(tc, hdr)
	_ = tc.SetReadDeadline(time.Time{})
	switch {
	case err == nil && LooksLikeSTUN(hdr):
		d.turn.deliver(newPeekConn(tc, hdr))
	case err == nil, errors.Is(err, os.ErrDeadlineExceeded):
		// A read timeout routes to HTTP, whatever it consumed: a legal HTTPS
		// client may complete the handshake and then wait (pre-warming, a
		// speculative browser connection), while a STUN client always sends its
		// whole Binding or Allocate at once. Closing here would drop exactly the
		// connections net/http would have kept idle.
		d.http.deliver(newPeekConn(tc, hdr[:n]))
	default:
		// EOF or a broken stream before eight bytes: nothing to serve.
		_ = tc.Close()
	}
}

// Close stops accepting, closes both branches (so Accept returns net.ErrClosed
// and both http.Server.Serve and pion's server unwind) and waits for the
// connections still being routed. It is idempotent.
func (d *Demux) Close() error {
	d.closeOnce.Do(func() {
		d.mu.Lock()
		d.closed = true
		for nc := range d.pending {
			_ = nc.Close()
		}
		d.mu.Unlock()
		d.closeErr = d.raw.Close()
		_ = d.http.Close()
		_ = d.turn.Close()
		d.wg.Wait()
	})
	if errors.Is(d.closeErr, net.ErrClosed) {
		return nil
	}
	return d.closeErr
}

// chanListener is a net.Listener fed by the demux.
type chanListener struct {
	addr  net.Addr
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func newChanListener(addr net.Addr) *chanListener {
	return &chanListener{addr: addr, conns: make(chan net.Conn), done: make(chan struct{})}
}

// deliver hands c to Accept, or closes it once the listener is closed.
func (l *chanListener) deliver(c net.Conn) {
	select {
	case l.conns <- c:
	case <-l.done:
		_ = c.Close()
	}
}

func (l *chanListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *chanListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *chanListener) Addr() net.Addr { return l.addr }
