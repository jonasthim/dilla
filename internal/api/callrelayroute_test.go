package api_test

// UP11-b: POST /v1/calls/{call_id}/relay mints fresh relay (TURN) credentials for a device that is a
// current leaf of a live call, and nothing else: no room is opened, no token is minted, the SFU is not
// asked anything. A page whose relay restarted with the API asks it while it reconnects, so the
// reconnect never re-opens a room the SFU lost (a full start's CreateRoom did, and the page's
// resume then met STATE_MISMATCH). The gates are the start's, and so is the mint's order against
// the relay's cuts.

import (
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

var relayCfg = api.CallsConfig{LiveKitURL: testLiveKitURL, TURNSecret: testTURNSecret,
	TURNURLs: []string{"turns:chat.example.test:443?transport=tcp"}, CredentialTTL: time.Hour, MaxPublishers: 2}

var errFakeSFU = errors.New("the SFU does not answer")

func relayPath(call id.ID) string { return "/v1/calls/" + call.String() + "/relay" }

// relayAnswer is the ice_servers of a relay answer `[ice_servers]`.
func relayAnswer(t *testing.T, body []byte) [][]cbor.RawMessage {
	t.Helper()
	var out []cbor.RawMessage
	mustUnmarshalBody(t, body, &out)
	if len(out) != 1 {
		t.Fatalf("relay answer has %d elements, want 1: %x", len(out), body)
	}
	var ice [][]cbor.RawMessage
	mustUnmarshal(t, out[0], &ice)
	return ice
}

// sfuCalls is everything the stub SFU was asked: rooms opened and closed, tokens, pushes, removals.
func sfuCalls(s *stubSFU) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.created) + len(s.deleted) + len(s.mints) + len(s.updates) + len(s.removed) + len(s.removedIDs)
}

// A device that is not in the call gets nothing, answered as the neighbouring call routes answer:
// 404 for an unknown or ended call and for a caller who may not view its channel, 403 E_FORBIDDEN
// without connect or for a barred device, 403 E_LEAF_NOT_CURRENT for a device that is no current
// leaf of the call's group, 400 for a body that is not the empty array. None of them mints.
func TestTheRelayRouteRefusesADeviceNotInTheCall(t *testing.T) {
	e, ch, tok, group, _, calls := callEnvCalls(t, relayCfg)
	relay := &fakeRelay{}
	calls.WithRelay(relay)
	owner := deviceOf(t, e, tok)
	seedLeaf(t, e, group, owner, 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	call := decodeCall(t, body).CallID
	minted := func() int { relay.mu.Lock(); defer relay.mu.Unlock(); return len(relay.minted) }
	before := minted()
	refused := func(name, token, path string, body any, status int, code string) {
		t.Helper()
		got, resp := e.Do(http.MethodPost, path, token, body)
		if got != status || e.ErrCode(resp) != code {
			t.Errorf("%s = %d %s, want %d %s", name, got, e.ErrCode(resp), status, code)
		}
	}

	refused("an unknown call", tok, relayPath(id.New()), []any{}, http.StatusNotFound, "E_NOT_FOUND")
	refused("a body that is not the empty array", tok, relayPath(call), []any{"x"}, http.StatusBadRequest, "E_INVALID_REQUEST")
	_, strangerTok := e.NewUser("stranger")
	refused("a caller who may not view the channel", strangerTok, relayPath(call), []any{}, http.StatusNotFound, "E_NOT_FOUND")
	user := userOf(t, e, tok)
	e.sess["noleaf"] = auth.Session{UserID: user, DeviceID: seedDevices(t, e, user, 1)[0], Scope: auth.ScopeEnrolled}
	refused("a device that is no leaf of the call group", "noleaf", relayPath(call), []any{}, http.StatusForbidden, "E_LEAF_NOT_CURRENT")
	member, _, memberTok := joinedMember(t, e, ch, group, "member")
	denyInChannel(t, e, ch, member, api.PermConnect)
	refused("a member without connect", memberTok, relayPath(call), []any{}, http.StatusForbidden, "E_FORBIDDEN")
	if minted() != before {
		t.Fatalf("a refused relay request minted a credential: %d mints, want %d", minted(), before)
	}

	// Control: the owner, a current leaf of the live call, gets one; once the call ends, nobody does.
	if status, resp := e.Do(http.MethodPost, relayPath(call), tok, []any{}); status != http.StatusOK {
		t.Fatalf("the relay for a leaf of the live call = %d %s, want 200", status, e.ErrCode(resp))
	}
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+call.String(), tok, nil); status != http.StatusNoContent {
		t.Fatalf("ending the call = %d", status)
	}
	refused("an ended call", tok, relayPath(call), []any{}, http.StatusNotFound, "E_NOT_FOUND")
}

// A barred device (revoked, quarantined, of a disabled, deleted or owing user) is refused 403
// E_FORBIDDEN, however current its leaf, as at the start and at share.
func TestTheRelayRouteRefusesABarredDevice(t *testing.T) {
	for _, st := range barredStates() {
		t.Run(st.name, func(t *testing.T) {
			b := newBarredEnv(t)
			if status, body := b.e.Do(http.MethodPost, relayPath(b.callID), b.memberTok, []any{}); status != http.StatusOK {
				t.Fatalf("before the bar the relay = %d %s, want 200", status, codeOfBody(b.e, status, body))
			}
			st.bar(t, b.e, b.member, b.memberDev)
			if status, body := b.e.Do(http.MethodPost, relayPath(b.callID), b.memberTok, []any{}); status != http.StatusForbidden ||
				codeOfBody(b.e, status, body) != "E_FORBIDDEN" {
				t.Errorf("the relay for a %s device = %d %s, want 403 E_FORBIDDEN", st.name, status, codeOfBody(b.e, status, body))
			}
		})
	}
}

// A device whose relay cut the media relay has not acknowledged gets 503 E_UNAVAILABLE with
// retry_after_ms 2000, as at the start and at share, and nothing is minted for it.
func TestTheRelayRouteRefusesAPendingRelayCut(t *testing.T) {
	b := newBarredEnv(t)
	relay := &ackRelay{unacked: map[id.ID]bool{}}
	b.calls.WithRelay(relay)
	relay.Revoke(b.memberDev, time.Now())
	status, body := b.e.Do(http.MethodPost, relayPath(b.callID), b.memberTok, []any{})
	if status != http.StatusServiceUnavailable || b.e.ErrCode(body) != "E_UNAVAILABLE" || retryAfterOf(t, body) != 2000 {
		t.Fatalf("the relay with an unacknowledged cut = %d %s, want 503 E_UNAVAILABLE with retry_after_ms 2000",
			status, b.e.ErrCode(body))
	}
	relay.mu.Lock()
	minted := slices.Contains(relay.minted, b.memberDev)
	relay.mu.Unlock()
	if minted {
		t.Fatal("a credential was minted for a device whose relay cut is unacknowledged")
	}
	relay.ack(b.memberDev)
	if status, body := b.e.Do(http.MethodPost, relayPath(b.callID), b.memberTok, []any{}); status != http.StatusOK {
		t.Fatalf("the relay once the cut was acknowledged = %d %s, want 200", status, b.e.ErrCode(body))
	}
}

// A current leaf of the live call gets a fresh credential: issued now (after the start's), for its
// own device, valid for turn.credential_ttl, under the instance's TURN secret, minted through the
// relay's Mint (ordered against its cuts).
func TestTheRelayRouteMintsAFreshCredentialForALeafOfTheLiveCall(t *testing.T) {
	e, ch, tok, group, _, calls := callEnvCalls(t, relayCfg)
	relay := &fakeRelay{}
	calls.WithRelay(relay)
	dev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, dev, 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	started := issuedOfCall(t, body)
	call := decodeCall(t, body).CallID
	time.Sleep(5 * time.Millisecond) // fakeRelay.Mint issues at the wall clock's millisecond
	status, resp := e.Do(http.MethodPost, relayPath(call), tok, []any{})
	if status != http.StatusOK {
		t.Fatalf("the relay = %d %s, want 200", status, e.ErrCode(resp))
	}
	ice := relayAnswer(t, resp)
	if len(ice) != 1 {
		t.Fatalf("ice_servers = %v, want one relay", ice)
	}
	var urls []string
	var user, cred string
	mustUnmarshal(t, ice[0][0], &urls)
	mustUnmarshal(t, ice[0][1], &user)
	mustUnmarshal(t, ice[0][2], &cred)
	if !slices.Equal(urls, relayCfg.TURNURLs) {
		t.Fatalf("urls = %v, want %v", urls, relayCfg.TURNURLs)
	}
	fields := strings.Split(user, ":")
	if len(fields) != 3 || fields[1] != dev.String() {
		t.Fatalf("username %q does not name the device %s", user, dev)
	}
	// fakeRelay.Mint answers the wall clock as the issue time.
	ms, err := strconv.ParseInt(fields[2], 10, 64)
	if err != nil {
		t.Fatalf("username %q carries no issue time", user)
	}
	issued := time.UnixMilli(ms)
	if !issued.After(started) {
		t.Fatalf("issued %v is not after the start's credential %v", issued, started)
	}
	wantUser, wantCred := server.TURNCredential(testTURNSecret, dev, time.Hour, issued)
	if user != wantUser || cred != wantCred {
		t.Fatalf("credential = %q %q, want %q %q", user, cred, wantUser, wantCred)
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if !slices.Equal(relay.minted, []id.ID{dev, dev}) {
		t.Fatalf("minted = %v, want the start's and the relay route's for %s", relay.minted, dev)
	}
}

// An instance without a relay answers the empty list, as the start does.
func TestTheRelayRouteAnswersAnEmptyListWithoutARelay(t *testing.T) {
	e, ch, tok, group, _ := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	status, resp := e.Do(http.MethodPost, relayPath(decodeCall(t, body).CallID), tok, []any{})
	if status != http.StatusOK || len(relayAnswer(t, resp)) != 0 {
		t.Fatalf("the relay without TURN = %d %x, want 200 [[]]", status, resp)
	}
}

// The route asks the SFU nothing: no CreateRoom (which re-opened a room the SFU's restart lost), no
// token, no push, no removal. It answers even while the SFU would refuse to open a room.
func TestTheRelayRouteMakesNoSFUCall(t *testing.T) {
	e, ch, tok, group, stub, _ := callEnvCalls(t, relayCfg)
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	call := decodeCall(t, body).CallID
	before := sfuCalls(stub)
	stub.mu.Lock()
	stub.createFail = errFakeSFU
	stub.fail = errFakeSFU
	stub.mu.Unlock()
	for range 3 {
		if status, resp := e.Do(http.MethodPost, relayPath(call), tok, []any{}); status != http.StatusOK {
			t.Fatalf("the relay while the SFU refuses = %d %s, want 200", status, e.ErrCode(resp))
		}
	}
	if after := sfuCalls(stub); after != before {
		t.Fatalf("the relay route asked the SFU %d times, want none", after-before)
	}
	// Control: a start does ask it, and is refused while it cannot open the room.
	if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status != http.StatusServiceUnavailable {
		t.Fatalf("a start while the SFU refuses = %d, want 503", status)
	}
	if sfuCalls(stub) == before {
		t.Fatal("the control start asked the SFU nothing")
	}
}
