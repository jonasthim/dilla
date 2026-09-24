package api

import (
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/server"
)

// maxSessionBody is generous for a five-element array whose largest member is a
// 64-byte signature, and small enough that the unauthenticated establish route
// cannot be used to make the instance allocate.
const maxSessionBody = 4096

// classChallenge is the bucket the unauthenticated challenge route meters
// itself on. It is not one of config's §5.3 knobs: the two keys below are
// derived per request rather than configured, so the class is stated here with
// its rate and burst rather than read out of config.Rate.
const classChallenge = "challenge"

// challengeClass is that bucket's rate. One nonce a second with a burst of ten
// is far above what a real client needs — a device asks for a nonce when it
// establishes or renews a session — and far below what enumerating a 16-byte
// identifier space would take.
var challengeClass = server.Class{Name: classChallenge, PerSecond: 1, Burst: 10}

// SessionChallenge serves POST /v1/devices/{device_id}/sessions/challenge. It is
// unauthenticated and answers identically for an unknown device, so it is not a
// device-enumeration oracle. It is rate limited per source address AND per
// device_id: the first bucket is defeated by a distributed caller, the second by
// an attacker-chosen id, and only both together are worth anything.
func (d Deps) SessionChallenge(w http.ResponseWriter, r *http.Request) {
	deviceID, err := server.PathID(r, "device_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	// Fail closed, for the same reason d.meter does: a nil limiter on an
	// unauthenticated route is an unmetered unauthenticated route.
	if d.Limiter == nil || d.Config == nil {
		server.WriteError(w, server.Errorf(server.CodeInternal, "the %s rate bucket is not wired", classChallenge))
		return
	}
	addr := server.RateKey(server.RealIP(r, d.Config.Server.TrustedProxyCIDRs))
	for _, key := range []string{"challenge-addr\x00" + addr, "challenge-device\x00" + deviceID.String()} {
		if ok, retry := d.Limiter.Allow(challengeClass, key); !ok {
			if d.Metrics != nil {
				d.Metrics.RateLimited(classChallenge)
			}
			server.WriteError(w, server.RateLimited(uint64(retry.Milliseconds())))
			return
		}
	}
	nonce, expires, err := d.Sessions.Challenge(r.Context(), deviceID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusCreated, []any{nonce, uint64(expires)})
}

// SessionEstablish serves POST /v1/devices/{device_id}/sessions. The body is the
// five-element array of protocol/02 § Device sessions item 2:
//
//	[nonce(bstr 32), purpose(uint), sig(bstr 64), credential(bstr|null), login(bstr|null)]
//
// and the answer is that section's seven-element array. `purpose` is bound into
// the signature preimage, so a renew signature cannot be replayed as an
// establish; `login`, when present, is the enrolment assertion, which
// auth.Sessions spends and which yields the `pending` scope.
func (d Deps) SessionEstablish(w http.ResponseWriter, r *http.Request) {
	deviceID, err := server.PathID(r, "device_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var body []any
	if err := server.DecodeBody(w, r, maxSessionBody, &body); err != nil {
		server.WriteError(w, err)
		return
	}
	if len(body) != 5 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest,
			"session body has %d elements, want 5", len(body)))
		return
	}
	nonce, _ := body[0].([]byte)
	purpose, ok := body[1].(uint64)
	if !ok || purpose > uint64(auth.PurposeProvisional) {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "purpose must be 0, 1 or 2"))
		return
	}
	sig, _ := body[2].([]byte)
	credential, _ := body[3].([]byte)
	login, _ := body[4].([]byte)

	req := auth.EstablishRequest{
		DeviceID: deviceID, Nonce: nonce, Purpose: auth.Purpose(purpose),
		Sig: sig, Credential: credential, Login: login,
	}
	var tok auth.Token
	if auth.Purpose(purpose) == auth.PurposeRenew {
		tok, err = d.Sessions.Renew(r.Context(), req)
	} else {
		tok, err = d.Sessions.Establish(r.Context(), req)
	}
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	out := []any{
		tok.Token, uint64(tok.Scope), tok.UserID, tok.DeviceID,
		uint64(tok.Expires), uint64(tok.IdleExpires), tok.Generation,
	}
	d.write(w, r, http.StatusCreated, out)
}

// SessionDelete serves DELETE /v1/devices/{device_id}/sessions: it drops every
// session of one device. A device may only do this to itself or to another
// device of the same user.
func (d Deps) SessionDelete(w http.ResponseWriter, r *http.Request) {
	sess, ok := auth.FromContext(r.Context())
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	deviceID, err := server.PathID(r, "device_id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	device, err := d.Repo.GetDevice(r.Context(), deviceID)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeNotFound, ""))
		return
	}
	if device.UserID != sess.UserID {
		server.WriteError(w, server.Errorf(server.CodeForbidden, ""))
		return
	}
	if _, err := d.Repo.DeleteSessionsByDevice(r.Context(), deviceID); err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.noContent(w, r)
}

// GatewayTicket serves POST /v1/gateway/ticket for clients that cannot set an
// Authorization header on a WebSocket upgrade. The ticket store itself is
// internal/gateway's (interfaces.md §1, §6.1): a second in-memory store here
// would mint tickets the gateway has never heard of. Deps.Tickets is filled by
// part 1b task 17.
func (d Deps) GatewayTicket(w http.ResponseWriter, r *http.Request) {
	sess, ok := auth.FromContext(r.Context())
	if !ok {
		server.WriteError(w, server.Errorf(server.CodeUnauthenticated, ""))
		return
	}
	if d.Tickets == nil {
		server.WriteError(w, notImplemented("the gateway ticket store is part 1b's"))
		return
	}
	ticket, expires := d.Tickets.Mint(sess.UserID, sess.DeviceID)
	d.write(w, r, http.StatusCreated, []any{ticket, uint64(expires)})
}
