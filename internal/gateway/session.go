package gateway

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

// connState is where a connection is in the handshake.
type connState uint8

const (
	stateNew connState = iota
	stateReady
	stateClosed
)

// conn is one WebSocket connection. Fan-out is per connection, not per device: three tabs of one
// device have three n counters and three rings.
type conn struct {
	mu           sync.Mutex
	state        connState
	userID       id.ID
	deviceID     id.ID
	scope        auth.Scope
	pairingGroup *id.ID // ScopeProvisional only; see interfaces §2.2 point 4
	tokenHash    []byte
	resume       []byte // 32 CSPRNG bytes, rotated on every resumed
	// noResume is set when this connection was closed with a code protocol/02 marks as NOT
	// resumable (4004 session_revoked, 4009 session_timeout). suspend refuses to park such a
	// connection in the resume window, so its token dies with the socket.
	noResume    bool
	n           uint64
	groups      map[id.ID]struct{}
	lastLive    time.Time
	ready       time.Time
	suspendedAt time.Time
	pingAt      time.Time
	// The versions this connection negotiated at identify, echoed in ready.
	wire, e2ee, media uint64

	ring   *ring
	writer *writer
	gw     *Gateway
}

// denyResume marks the connection dead for resume purposes. It is called before the socket is
// closed with a non-resumable code, and it is what suspend and CloseDevice read.
func (c *conn) denyResume() {
	c.mu.Lock()
	c.noResume = true
	c.mu.Unlock()
}

// currentWriter reads the connection's writer under the lock. The writer is REPLACED on a resume —
// the connection comes back over a new sink — so every reader takes the lock: a producer fanning
// out while a resume swaps the field is otherwise a data race the -race gate catches.
func (c *conn) currentWriter() *writer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.writer
}

// send stamps, rings and queues one frame.
//
// Allocating n, ringing the frame and handing it to the writer is ONE critical section. Two
// producers delivering to the same connection concurrently — DeliverGroup for two groups that
// share a device, or a Welcome racing a group fan-out — would otherwise be stamped n = k and
// n = k+1 and then enqueued in the opposite order, so the client sees n go backwards and answers
// with close 4007. `go test -race` cannot see that: it is an ordering bug, not a data race.
// The writer's own enqueue is non-blocking, so the lock is never held across I/O.
func (c *conn) send(f Frame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var n uint64
	if f.Replay {
		c.n++
		n = c.n
		if b, err := Encode(f, n); err == nil {
			c.ring.add(n, b)
		}
	}
	if c.writer == nil {
		return
	}
	c.writer.enqueue(f, n)
}

// mark records a liveness signal: ready, resumed or a heartbeat frame. Online is defined over
// this timestamp and nothing else (R10, protocol/02 invariant 6).
func (c *conn) mark(now time.Time) {
	c.mu.Lock()
	c.lastLive = now
	c.mu.Unlock()
}

func (c *conn) online(now time.Time, idle time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state == stateReady && now.Sub(c.lastLive) < idle
}

// resumeToken copies the connection's current resume token under the lock. `resume` is rewritten
// by the serve goroutine on every resumed, so any other goroutine — a test included — reads it
// through here.
func (c *conn) resumeToken() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.resume...)
}

func (c *conn) readyAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ready
}

func newResumeToken() ([]byte, error) {
	t := make([]byte, 32)
	if _, err := rand.Read(t); err != nil {
		return nil, err
	}
	return t, nil
}

// resumeMatch is a constant-time comparison: a resume token is a bearer credential for a
// connection's replay history.
func resumeMatch(a, b []byte) bool { return subtle.ConstantTimeCompare(a, b) == 1 }

// errNotResumable is returned by resume when the client must fall back to identify.
var errNotResumable = errors.New("gateway: not resumable")

// resumeOutcome is what a resume attempt produced.
type resumeOutcome struct {
	from, to uint64
	frames   [][]byte
}

// tryResume validates a resume frame against a suspended connection's ring.
//
// Refusal is invalid_session with resumable = 0 when the token is unknown or expired, the
// generation differs, or last_n is below the ring floor; after that the client heals from ready's
// per-group digest plus the two catch-up endpoints against its durable cursors.
func (c *conn) tryResume(token []byte, generation, lastN, current uint64) (resumeOutcome, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !resumeMatch(c.resume, token) || generation != current {
		return resumeOutcome{}, errNotResumable
	}
	floor := c.ring.floor()
	if floor != 0 && lastN < floor-1 {
		return resumeOutcome{}, errNotResumable
	}
	frames := c.ring.since(lastN)
	return resumeOutcome{from: lastN + 1, to: c.n, frames: frames}, nil
}

// identify resolves a session token to a device session. A token that does not resolve is
// close 4003; a revoked one is 4004.
//
// The return type is auth.Session, the leaf type of deviation B9 — not a `ds.Session`, which
// would make this package import internal/ds while internal/ds imports this one.
func (g *Gateway) identify(ctx context.Context, token string) (auth.Session, error) {
	return g.opts.Auth.Resolve(ctx, token)
}

// wsSink adapts a coder/websocket connection to the writer's sink. Binary frames only: dilla's
// wire is CBOR, never text.
type wsSink struct{ c *websocket.Conn }

func newWSSink(c *websocket.Conn) sink { return &wsSink{c: c} }

func (s *wsSink) write(ctx context.Context, b []byte) error {
	return s.c.Write(ctx, websocket.MessageBinary, b)
}

func (s *wsSink) read(ctx context.Context) (websocket.MessageType, []byte, error) {
	return s.c.Read(ctx)
}

func (s *wsSink) close(code CloseCode, reason string) {
	// A structured failure has already been sent as an error frame; the close reason is capped at
	// 123 bytes, so it carries only the short form.
	if len(reason) > 100 {
		reason = reason[:100]
	}
	_ = s.c.Close(websocket.StatusCode(code), reason)
}

// bearerOrTicket takes the session token from the Authorization header, or spends a
// single-use ticket from Sec-WebSocket-Protocol for clients that cannot set headers (gap-38).
func bearerOrTicket(r *http.Request, tickets *Tickets) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	// coder/websocket v1.8.15 exports exactly four free functions — Accept (accept.go:102), Dial,
	// CloseStatus (close.go:78) and NetConn (netconn.go:48). There is no Subprotocols helper, so
	// the header is read directly.
	for proto := range strings.SplitSeq(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		proto = strings.TrimSpace(proto)
		if after, ok := strings.CutPrefix(proto, "dilla.ticket."); ok {
			if token, ok := tickets.Take(after); ok {
				return token
			}
		}
	}
	return ""
}

// decodeAny decodes a frame in either direction. Decode itself refuses server opcodes from a
// client, which is what the gateway wants on the read path; the tests need the other direction.
func decodeAny(b []byte) (Inbound, error) {
	var elems []cbor.RawMessage
	if err := cborx.Unmarshal(b, &elems); err != nil {
		return Inbound{}, err
	}
	if len(elems) != 4 {
		return Inbound{}, frameErr("E_FRAME_SHAPE", "frame", CloseDecode)
	}
	op, err := rawUint(elems[0])
	if err != nil {
		return Inbound{}, err
	}
	n, err := rawUint(elems[1])
	if err != nil {
		return Inbound{}, err
	}
	var payload []cbor.RawMessage
	if err := cborx.Unmarshal(elems[3], &payload); err != nil {
		return Inbound{}, err
	}
	return Inbound{Op: Op(op), CID: n, Payload: payload}, nil
}

// serve runs one connection: hello, then exactly one identify or resume frame, then the read loop.
//
// The hello frame is written SYNCHRONOUSLY, not through a second writer: the connection's one
// writer is created inside register, and two writers over one sink would call
// websocket.Conn.Write concurrently, which coder/websocket does not permit and which the race
// detector flags even against the recording double. `writer.stop` closes a channel; it does not
// wait for a goroutine already inside sink.write.
func (g *Gateway) serve(ctx context.Context, s sink, token string) {
	wire, e2ee, media := g.advertised()
	hello, err := HelloPayload(wire, e2ee, media,
		g.opts.HeartbeatMS, g.opts.MaxFrameBytes, g.opts.InstanceID, g.opts.Generation)
	if err != nil {
		s.close(CloseUnknown, "hello")
		return
	}
	b, err := Encode(Frame{Op: OpHello, Payload: hello}, 0)
	if err != nil {
		s.close(CloseUnknown, "hello")
		return
	}
	writeCtx, cancel := context.WithTimeout(ctx, g.opts.WriteDeadline)
	err = s.write(writeCtx, b)
	cancel()
	if err != nil {
		return
	}

	// Exactly one frame is read before the connection is identified. Anything else — including a
	// heartbeat or a subscribe — is close 4001.
	readCtx, cancelRead := context.WithTimeout(ctx, g.beat.grace)
	typ, raw, err := s.read(readCtx)
	cancelRead()
	if err != nil {
		s.close(CloseNotIdentified, "no identify")
		return
	}
	if typ != websocket.MessageBinary {
		s.close(CloseDecode, "text frame")
		return
	}
	in, err := Decode(raw, int(g.opts.ReadLimit))
	if err != nil {
		g.refuse(ctx, s, err)
		return
	}
	// The credential may have travelled on the HTTP upgrade instead of in the identify payload.
	in.handshakeToken = token

	switch in.Op {
	case OpResume:
		if c, ok := g.resumeConnection(ctx, s, in); ok {
			g.readLoop(ctx, c, s)
			return
		}
		// A refused resume has already sent invalid_session; the client falls back to identify on
		// its next connection, so this one ends here rather than waiting for a second frame.
		s.close(CloseNotIdentified, "resume refused")
		return
	case OpIdentify:
		c, ok := g.identifyConnection(ctx, s, in)
		if !ok {
			return
		}
		g.readLoop(ctx, c, s)
	default:
		s.close(CloseNotIdentified, "first frame is not identify or resume")
	}
}

// advertised is the instance's version sets, defaulting to {1} for all three.
func (g *Gateway) advertised() (wire, e2ee, media []uint64) {
	pick := func(v []uint64) []uint64 {
		if len(v) == 0 {
			return []uint64{1}
		}
		return v
	}
	return pick(g.opts.WireVersions), pick(g.opts.E2EEVersions), pick(g.opts.MediaVersions)
}

// identifyConnection handles op 1: [bearer, wire_version, e2ee_version, media_version, caps].
//
// The client picks its versions from hello's three lists (protocol/07's "Negotiation": the client
// takes the highest it shares with the instance); the instance's job is to refuse a choice that is
// not in the set it advertised. A mismatch is an error frame naming E_VERSION and close 4006,
// which is the only reason CloseVersion exists.
func (g *Gateway) identifyConnection(ctx context.Context, s sink, in Inbound) (*conn, bool) {
	bearer, err := rawText(in.Payload[0])
	if err != nil {
		g.refuse(ctx, s, frameErr("E_FRAME_SHAPE", "identify token: "+err.Error(), CloseDecode))
		return nil, false
	}
	wire, e2ee, media := g.advertised()
	chosen := [3]uint64{}
	for i, set := range [][]uint64{wire, e2ee, media} {
		v, err := rawUint(in.Payload[i+1])
		if err != nil {
			g.refuse(ctx, s, frameErr("E_FRAME_SHAPE", "identify version: "+err.Error(), CloseDecode))
			return nil, false
		}
		if !slices.Contains(set, v) {
			g.refuse(ctx, s, frameErr("E_VERSION",
				fmt.Sprintf("version %d is not advertised; this instance offers %v", v, set),
				CloseVersion))
			return nil, false
		}
		chosen[i] = v
	}
	if bearer == "" {
		bearer = tokenFromHandshake(in)
	}
	session, err := g.identify(ctx, bearer)
	if err != nil {
		g.refuse(ctx, s, frameErr("E_UNAUTHENTICATED", "identify", CloseUnauthenticated))
		return nil, false
	}
	c, err := g.registerVersions(ctx, session, s, chosen)
	if err != nil {
		s.close(CloseUnknown, "register")
		return nil, false
	}
	return c, true
}

// resumeConnection handles op 2: [session_token, resume_token, generation, last_n]. On success it
// sends `resumed` [replayed_from, replayed_to], replays the ring, and rotates the resume token —
// which is what makes §6.1's "rotated on every resumed" true end to end rather than only in a
// unit test.
//
// Element 0 is a CREDENTIAL, not decoration. A resume that is authenticated by possession of the
// resume token alone would let a device whose sessions were just revoked back into the live
// registry for the whole ResumeWindow, so the session token is resolved through Options.Auth and
// the session it names must be the connection's own device.
func (g *Gateway) resumeConnection(ctx context.Context, s sink, in Inbound) (*conn, bool) {
	refuse := func(reason string) (*conn, bool) {
		if p, err := InvalidSessionPayload(false, reason); err == nil {
			if b, err := Encode(Frame{Op: OpInvalidSession, Payload: p}, 0); err == nil {
				writeCtx, cancel := context.WithTimeout(ctx, g.opts.WriteDeadline)
				_ = s.write(writeCtx, b)
				cancel()
			}
		}
		return nil, false
	}
	bearer, err := rawText(in.Payload[0])
	if err != nil {
		return refuse("malformed session token")
	}
	token, err := rawBytes(in.Payload[1])
	if err != nil {
		return refuse("malformed resume token")
	}
	generation, err := rawUint(in.Payload[2])
	if err != nil {
		return refuse("malformed generation")
	}
	lastN, err := rawUint(in.Payload[3])
	if err != nil {
		return refuse("malformed last_n")
	}
	v, ok := g.suspended.Load(string(token))
	if !ok {
		return refuse("unknown resume token")
	}
	c, ok := v.(*conn)
	if !ok {
		return refuse("unknown resume token")
	}
	// The credential may have travelled on the HTTP upgrade instead of in the payload, exactly as
	// identify allows.
	if bearer == "" {
		bearer = tokenFromHandshake(in)
	}
	session, err := g.identify(ctx, bearer)
	if err != nil {
		return refuse("unauthenticated")
	}
	if session.DeviceID != c.deviceID {
		return refuse("resume token does not belong to this session")
	}
	out, err := c.tryResume(token, generation, lastN, g.opts.Generation)
	if err != nil {
		g.suspended.Delete(string(token))
		return refuse("resume window elapsed or n below the ring floor")
	}

	// The connection comes back into the live registry over the NEW sink.
	g.suspended.Delete(string(token))
	now := g.opts.Clock.Now()
	c.mu.Lock()
	c.state = stateReady
	c.lastLive = now
	c.writer = newWriterWithLogger(s, writerLimits{
		Frames:   g.opts.QueueFrames,
		Bytes:    g.opts.QueueBytes,
		Deadline: g.opts.WriteDeadline,
	}, g.opts.Clock, g.opts.Log)
	w := c.writer
	c.mu.Unlock()

	// The token rotates BEFORE `resumed` reaches the writer, not after the replay: the writer runs
	// on its own goroutine, so rotating afterwards would leave the new token racing the frames
	// that announce the resume, and a client (or a test) that has seen `resumed` could still read
	// the spent one.
	if err := g.rotateResume(c); err != nil {
		s.close(CloseUnknown, "rotate")
		return nil, false
	}
	p, err := ResumedPayload(out.from, out.to)
	if err != nil {
		s.close(CloseUnknown, "resumed")
		return nil, false
	}
	c.send(Frame{Op: OpResumed, Payload: p, Replay: true})
	for _, frame := range out.frames {
		w.enqueueRaw(frame)
	}
	// Only now does the connection go back into the live registry. Publishing it before `resumed`
	// and the replay are on the writer lets a concurrent fan-out land ahead of `resumed` or in
	// among the replayed frames — the non-monotonic n a client answers with close 4007.
	g.addLive(c)
	return c, true
}

// refuse sends the structured error frame and then closes, because a close reason is capped at
// 123 bytes and the client needs the code.
func (g *Gateway) refuse(ctx context.Context, s sink, err error) {
	var fe *FrameError
	if !errors.As(err, &fe) {
		s.close(CloseUnknown, "error")
		return
	}
	if p, perr := ErrorPayload(0, fe.Code, fe.Detail); perr == nil {
		if b, berr := Encode(Frame{Op: OpError, Payload: p}, 0); berr == nil {
			writeCtx, cancel := context.WithTimeout(ctx, g.opts.WriteDeadline)
			_ = s.write(writeCtx, b)
			cancel()
		}
	}
	s.close(fe.Close, fe.Code)
}

// tokenFromHandshake is the credential taken from the HTTP upgrade (an Authorization header or a
// spent ticket), which serve threaded in. An identify frame may carry an empty token when the
// credential travelled on the handshake instead.
func tokenFromHandshake(in Inbound) string { return in.handshakeToken }

// sendReady fills the per-group digest a client heals from when its resume is refused.
func (g *Gateway) sendReady(ctx context.Context, c *conn) error {
	groups, err := g.opts.Store.GroupsForDevice(ctx, c.deviceID)
	if err != nil {
		return err
	}
	digests := make([]GroupDigest, 0, len(groups))
	for _, groupID := range groups {
		cursor, err := g.opts.Store.GetCursor(ctx, c.deviceID, groupID)
		if err != nil {
			return err
		}
		var outstanding uint64
		if g.opts.Outstanding != nil {
			// §2.3 fixes ready's group rows as [group_id, epoch, last_seq,
			// proposals_outstanding]. A hardcoded 0 here would tell a client reconnecting into a
			// frozen group that nothing is outstanding — and the digest is exactly what a client
			// with a refused resume heals from.
			outstanding = g.opts.Outstanding(ctx, groupID)
		}
		digests = append(digests, GroupDigest{
			GroupID:              groupID,
			Epoch:                cursor.LastEpoch,
			LastSeq:              cursor.LastSeq,
			ProposalsOutstanding: outstanding,
		})
		c.mu.Lock()
		c.groups[groupID] = struct{}{}
		c.mu.Unlock()
	}
	remaining, err := g.opts.Store.CountKeyPackages(ctx, c.deviceID, g.opts.Clock.Now().Unix())
	if err != nil {
		return err
	}
	p, err := ReadyPayload(c.deviceID, c.userID, g.opts.Generation, c.resume,
		c.wire, c.e2ee, c.media, uint64(remaining), digests)
	if err != nil {
		return err
	}
	c.send(Frame{Op: OpReady, Payload: p, Replay: true})
	c.mark(g.opts.Clock.Now())
	return nil
}

// readLoop reads one frame at a time. Conn.Read plus cborx.Unmarshal, never the streaming
// decoder: coder/websocket's reader grows 2*cap+512 without bound.
func (g *Gateway) readLoop(ctx context.Context, c *conn, s sink) {
	defer g.suspend(c)
	for {
		typ, b, err := s.read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary {
			s.close(CloseDecode, "text frame")
			return
		}
		in, err := Decode(b, int(g.opts.ReadLimit))
		if err != nil {
			var fe *FrameError
			if errors.As(err, &fe) {
				if p, perr := ErrorPayload(0, fe.Code, fe.Detail); perr == nil {
					c.send(Frame{Op: OpError, Payload: p})
				}
				s.close(fe.Close, fe.Code)
			}
			return
		}
		g.handle(ctx, c, in)
	}
}

// handle dispatches one inbound frame. heartbeat marks liveness and trims the ring; subscribe and
// unsubscribe adjust this connection's group set.
func (g *Gateway) handle(ctx context.Context, c *conn, in Inbound) {
	switch in.Op {
	case OpHeartbeat:
		lastN, err := rawUint(in.Payload[0])
		if err != nil {
			return
		}
		c.mark(g.opts.Clock.Now())
		c.ring.trim(lastN)
		if p, err := HeartbeatAckPayload(uint64(g.opts.Clock.Now().Unix())); err == nil {
			c.send(Frame{Op: OpHeartbeatAck, Payload: p})
		}
	case OpCommitAck:
		// Invariant 7's acknowledgement. The frame is group-scoped, so the group comes from
		// element 2, not from the payload.
		if in.GroupID == nil || g.opts.CommitAck == nil {
			return
		}
		round, err := rawUint(in.Payload[0])
		if err != nil {
			return
		}
		c.mark(g.opts.Clock.Now())
		g.opts.CommitAck(ctx, *in.GroupID, c.deviceID, round)
	case OpSubscribe, OpUnsubscribe:
		var groups []id.ID
		if err := cborx.Unmarshal(in.Payload[0], &groups); err != nil {
			return
		}
		c.mu.Lock()
		for _, gid := range groups {
			if in.Op == OpSubscribe {
				c.groups[gid] = struct{}{}
			} else {
				delete(c.groups, gid)
			}
		}
		c.mu.Unlock()
	}
	if g.opts.Metrics != nil {
		g.opts.Metrics.GatewayFrames.WithLabelValues(opLabel(in.Op), "in").Inc()
	}
}
