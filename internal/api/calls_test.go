package api_test

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

// callResponse is POST /v1/channels/{id}/calls's five elements.
type callResponse struct {
	CallID     id.ID
	GroupID    id.ID
	LiveKitURL string
	Token      string
	ICE        [][]cbor.RawMessage
}

func decodeCall(t *testing.T, body []byte) callResponse {
	t.Helper()
	var out []cbor.RawMessage
	mustUnmarshalBody(t, body, &out)
	if len(out) != 5 {
		t.Fatalf("call response has %d elements, want 5: %x", len(out), body)
	}
	var r callResponse
	mustUnmarshal(t, out[0], &r.CallID)
	mustUnmarshal(t, out[1], &r.GroupID)
	mustUnmarshal(t, out[2], &r.LiveKitURL)
	mustUnmarshal(t, out[3], &r.Token)
	mustUnmarshal(t, out[4], &r.ICE)
	return r
}

func TestACurrentLeafGetsALiveKitToken(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{
		LiveKitURL: testLiveKitURL, TURNSecret: testTURNSecret,
		TURNURLs:      []string{"turns:chat.example.test:443?transport=tcp"},
		CredentialTTL: time.Hour,
	})
	dev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, dev, 3 /* addedEpoch */, nil /* removedEpoch */)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusCreated {
		t.Fatalf("POST calls = %d (%x)", status, body)
	}
	out := decodeCall(t, body)
	if out.Token != "jwt-for-"+dev.String() || out.LiveKitURL != testLiveKitURL || out.GroupID != group {
		t.Fatalf("response = %+v", out)
	}
	// R9: the call is keyed by the call group's call id.
	if out.CallID != ch {
		t.Fatalf("call_id = %s, want the call group's call id %s", out.CallID, ch)
	}
	minted := sfu.minted()
	if len(minted) != 1 || minted[0][1] != dev.String() {
		t.Fatalf("the SFU minted %v, want one token for device %s", minted, dev)
	}
	// The call is recorded, which is what DELETE /v1/calls/{call_id} and the
	// restore path both read, and its room is the one the token names.
	row, err := e.Repo.GetVoiceSession(t.Context(), out.CallID)
	if err != nil || row.Ended != nil || row.LivekitRoom != minted[0][0] || row.LivekitRoom == "" ||
		row.ChannelID != ch || row.GroupID == nil || *row.GroupID != group {
		t.Fatalf("voice_sessions row = %+v (%v)", row, err)
	}

	// One relay entry, carrying the REST credential pion validates:
	// "<expiry>:<device_id>" and base64(HMAC-SHA1(secret, username)).
	if len(out.ICE) != 1 || len(out.ICE[0]) != 3 {
		t.Fatalf("ice_servers = %v", out.ICE)
	}
	var urls []string
	var user, cred string
	mustUnmarshal(t, out.ICE[0][0], &urls)
	mustUnmarshal(t, out.ICE[0][1], &user)
	mustUnmarshal(t, out.ICE[0][2], &cred)
	if len(urls) != 1 || urls[0] != "turns:chat.example.test:443?transport=tcp" {
		t.Fatalf("urls = %v", urls)
	}
	expiry, who, _ := strings.Cut(user, ":")
	if who != dev.String() || expiry != "1790003600" {
		t.Fatalf("username = %q, want <now+1h>:<device>", user)
	}
	mac := hmac.New(sha1.New, []byte(testTURNSecret))
	mac.Write([]byte(user))
	if cred != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Fatal("the TURN credential is not HMAC-SHA1 over the username")
	}
}

func TestARemovedDeviceIsRefused(t *testing.T) {
	e, ch, tok, group := callEnv(t)
	dev := deviceOf(t, e, tok)
	removed := uint64(5)
	seedLeaf(t, e, group, dev, 3, &removed)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusForbidden {
		t.Fatalf("removed leaf = %d, want 403", status)
	}
	if code := e.ErrCode(body); code != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("code = %s", code)
	}
}

func TestALeafAddedInAFutureEpochIsRefused(t *testing.T) {
	e, ch, tok, group := callEnv(t) // group epoch is 7
	dev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, dev, 9 /* addedEpoch > epoch */, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusForbidden {
		t.Fatalf("future leaf = %d, want 403", status)
	}
	if code := e.ErrCode(body); code != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("code = %s", code)
	}
}

func TestADeviceThatIsNoLeafIsRefused(t *testing.T) {
	e, ch, tok, group := callEnv(t)
	// Another device of the same user is a leaf; this one is not.
	other := seedDevices(t, e, userOf(t, e, tok), 1)[0]
	seedLeaf(t, e, group, other, 3, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusForbidden || e.ErrCode(body) != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("no leaf = %d %s, want 403 E_LEAF_NOT_CURRENT", status, e.ErrCode(body))
	}
}

func TestEndingACallMarksTheVoiceSession(t *testing.T) {
	e, ch, tok, group := callEnv(t)
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	callID := decodeCall(t, body).CallID
	e.Clk.Advance(time.Minute)
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), tok, nil); status != http.StatusNoContent {
		t.Fatal("DELETE call failed")
	}
	row, _ := e.Repo.GetVoiceSession(t.Context(), callID)
	if row.Ended == nil || *row.Ended != e.Clk.Now().Unix() {
		t.Fatalf("the voice session was not ended: %+v", row)
	}
	// Ending it again is not an error: the call is over either way.
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), tok, nil); status != http.StatusNoContent {
		t.Fatal("a second DELETE of an ended call failed")
	}
	// The next call of the same call group reopens the row in a fresh room.
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusCreated {
		t.Fatalf("the next call = %d", status)
	}
	again, _ := e.Repo.GetVoiceSession(t.Context(), decodeCall(t, body).CallID)
	if again.Ended != nil || again.LivekitRoom == row.LivekitRoom {
		t.Fatalf("the next call = %+v, after %+v", again, row)
	}
}

// I11 (fix wave): protocol/09 says DELETE ends the call for everyone, so the LiveKit room the call
// was handed out in is closed, not merely marked ended: a participant still connected to it cannot
// stay in a room the next call no longer shares. An already-ended call closes nothing again.
func TestEndingACallClosesItsLiveKitRoom(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	callID := decodeCall(t, body).CallID
	row, _ := e.Repo.GetVoiceSession(t.Context(), callID)
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), tok, nil); status != http.StatusNoContent {
		t.Fatalf("DELETE call = %d, want 204", status)
	}
	if got := sfu.deletedRooms(); len(got) != 1 || got[0] != row.LivekitRoom {
		t.Fatalf("rooms closed = %v, want the call's room %q", got, row.LivekitRoom)
	}
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), tok, nil); status != http.StatusNoContent {
		t.Fatalf("a second DELETE = %d, want 204", status)
	}
	if got := sfu.deletedRooms(); len(got) != 1 {
		t.Fatalf("rooms closed after a repeat DELETE = %v, want still only the one", got)
	}
}

// The call is over in dilla's record whatever the SFU answers: a room that will not close is logged,
// and the DELETE is still 204 with the voice session ended.
func TestARoomThatWillNotCloseStillEndsTheCall(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	callID := decodeCall(t, body).CallID
	sfu.mu.Lock()
	sfu.deleteFail = errors.New("sfu down")
	sfu.mu.Unlock()
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), tok, nil); status != http.StatusNoContent {
		t.Fatalf("DELETE with a failing room close = %d, want 204", status)
	}
	if row, _ := e.Repo.GetVoiceSession(t.Context(), callID); row.Ended == nil {
		t.Fatal("the voice session was not ended")
	}
	if got := sfu.deletedRooms(); len(got) != 1 {
		t.Fatalf("rooms asked to close = %v, want one attempt", got)
	}
}

// A second device starting the call that is already live joins it: the same
// call id and the same room, answered 200 rather than 201.
func TestASecondDeviceJoinsTheLiveCall(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	first := decodeCall(t, body)

	user := userOf(t, e, tok)
	phone := seedDevices(t, e, user, 1)[0]
	e.sess["phone"] = auth.Session{UserID: user, DeviceID: phone, Scope: auth.ScopeEnrolled}
	seedLeaf(t, e, group, phone, 6, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", "phone", []any{})
	if status != http.StatusOK {
		t.Fatalf("joining a live call = %d, want 200", status)
	}
	second := decodeCall(t, body)
	if second.CallID != first.CallID {
		t.Fatalf("second call id %s, want %s", second.CallID, first.CallID)
	}
	minted := sfu.minted()
	if len(minted) != 2 || minted[0][0] != minted[1][0] || minted[1][1] != phone.String() {
		t.Fatalf("tokens minted %v: both devices must be in one room", minted)
	}
	// TURN is off here, so there is no relay to offer: an empty list, never null.
	if second.ICE == nil || len(second.ICE) != 0 {
		t.Fatalf("ice_servers without TURN = %v, want []", second.ICE)
	}
}

// C1 (fix wave): while a call is live, its token gate is the call group the call was opened on
// (voice_sessions.group_id), never merely the newest open call group of the channel. A second
// call group registered during the call (a restore's re-creation, or a registration from before
// the delivery service refused it) neither locks the live call's leaves out nor lets its own
// leaves into the live room.
func TestALiveCallIsGatedOnTheGroupItWasOpenedOn(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusCreated {
		t.Fatalf("opening the call = %d (%x)", status, body)
	}
	first := decodeCall(t, body)

	// A member's device is a leaf of a NEWER call group of the same channel only.
	cid := ownerCommunityOf(t, e, ch)
	_, memberTok := e.NewUser("member")
	joinCommunity(t, e, cid, memberTok)
	e.Clk.Advance(time.Minute)
	rival := seedCallGroup(t, e, ch, cid, callGroupEpoch)
	seedLeaf(t, e, rival, deviceOf(t, e, memberTok), 3, nil)

	status, body = e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusOK {
		t.Fatalf("a leaf of the live call's group, after a newer group appeared = %d %s, want 200",
			status, e.ErrCode(body))
	}
	if again := decodeCall(t, body); again.GroupID != group || again.CallID != first.CallID {
		t.Fatalf("rejoining = %+v, want group %s and call %s", again, group, first.CallID)
	}
	status, body = e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", memberTok, []any{})
	if status != http.StatusForbidden || e.ErrCode(body) != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("a leaf of only the newer group = %d %s, want 403 E_LEAF_NOT_CURRENT", status, e.ErrCode(body))
	}
	if minted := sfu.minted(); len(minted) != 2 {
		t.Fatalf("tokens minted %v, want the owner's two and none for the newer group's leaf", minted)
	}
	row, err := e.Repo.GetVoiceSession(t.Context(), first.CallID)
	if err != nil || row.GroupID == nil || *row.GroupID != group {
		t.Fatalf("voice_sessions row = %+v (%v), want it still on the first group", row, err)
	}
}

// A live call whose group has been closed (a failed heal's re-creation) cannot go on: the next
// start from a leaf of the channel's current call group ends it and opens a fresh call there.
func TestACallWhoseGroupClosedIsReplacedOnTheCurrentGroup(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	dev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, dev, 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	first := decodeCall(t, body)
	before, _ := e.Repo.GetVoiceSession(t.Context(), first.CallID)

	e.Clk.Advance(time.Minute)
	if err := e.Repo.CloseGroup(t.Context(), group, e.Clk.Now().Unix()); err != nil {
		t.Fatalf("CloseGroup: %v", err)
	}
	next := seedCallGroup(t, e, ch, ownerCommunityOf(t, e, ch), callGroupEpoch)
	seedLeaf(t, e, next, dev, 3, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusCreated {
		t.Fatalf("starting after the live call's group closed = %d %s, want 201", status, e.ErrCode(body))
	}
	if out := decodeCall(t, body); out.GroupID != next {
		t.Fatalf("the new call is on group %s, want the current group %s", out.GroupID, next)
	}
	after, _ := e.Repo.GetVoiceSession(t.Context(), first.CallID)
	if after.Ended != nil || after.GroupID == nil || *after.GroupID != next || after.LivekitRoom == before.LivekitRoom {
		t.Fatalf("voice_sessions row = %+v after %+v, want a fresh live room on the current group", after, before)
	}
	// The stale call is ended, so its room is closed like any ended call's.
	if got := sfu.deletedRooms(); len(got) != 1 || got[0] != before.LivekitRoom {
		t.Fatalf("rooms closed = %v, want the stale call's room %q", got, before.LivekitRoom)
	}
}

func TestCallsAreRefusedWhereThereIsNoCall(t *testing.T) {
	e, ch, tok, _ := callEnv(t)
	// A stranger learns nothing about the channel.
	_, stranger := e.NewUser("stranger")
	if status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", stranger, []any{}); status != http.StatusNotFound {
		t.Fatalf("a non-member = %d %s, want 404", status, e.ErrCode(body))
	}
	// A text channel carries no calls.
	cid := ownerCommunityOf(t, e, ch)
	text, _, _ := newChannel(t, e, cid, tok, 0, 1, 2, "text")
	if status, body := e.Do(http.MethodPost, "/v1/channels/"+text.String()+"/calls", tok, []any{}); status != http.StatusBadRequest {
		t.Fatalf("a text channel = %d %s, want 400", status, e.ErrCode(body))
	}
	// A voice channel with no call group registered yet.
	bare, _, _ := newChannel(t, e, cid, tok, 1, 1, 2, "bare")
	if status, body := e.Do(http.MethodPost, "/v1/channels/"+bare.String()+"/calls", tok, []any{}); status != http.StatusNotFound {
		t.Fatalf("no call group = %d %s, want 404", status, e.ErrCode(body))
	}
	// An unknown call.
	if status, _ := e.Do(http.MethodDelete, "/v1/calls/"+id.New().String(), tok, nil); status != http.StatusNotFound {
		t.Fatalf("DELETE of an unknown call = %d, want 404", status)
	}
	// A body that is not the empty array.
	if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{"x"}); status != http.StatusBadRequest {
		t.Fatalf("a non-empty body = %d, want 400", status)
	}
}

// Only a current leaf of the call's group may end it for everyone.
func TestOnlyALeafEndsACall(t *testing.T) {
	e, ch, tok, group := callEnv(t)
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	callID := decodeCall(t, body).CallID

	user := userOf(t, e, tok)
	other := seedDevices(t, e, user, 1)[0]
	e.sess["other"] = auth.Session{UserID: user, DeviceID: other, Scope: auth.ScopeEnrolled}
	status, resp := e.Do(http.MethodDelete, "/v1/calls/"+callID.String(), "other", nil)
	if status != http.StatusForbidden || e.ErrCode(resp) != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("a non-leaf DELETE = %d %s, want 403 E_LEAF_NOT_CURRENT", status, e.ErrCode(resp))
	}
	if row, _ := e.Repo.GetVoiceSession(t.Context(), callID); row.Ended != nil {
		t.Fatal("a non-leaf ended the call")
	}
}

func TestASFUFailureIsAnInternalError(t *testing.T) {
	e, ch, tok, group, sfu := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	sfu.fail = errors.New("sfu down")
	if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status != http.StatusInternalServerError {
		t.Fatalf("an SFU failure = %d, want 500", status)
	}
}

// An instance with no SFU (livekit.enabled = false) still mounts the call routes, because the
// composition root mounts every route protocol/09 lists: a start that passes every gate is then 501
// and records no voice session, since there is no room to hand out; a request refused by an earlier
// gate keeps its own answer.
func TestAnInstanceWithoutAnSFUAnswersNotImplemented(t *testing.T) {
	e, cid, tok := channelEnv(t)
	ch, _, status := newChannel(t, e, cid, tok, 1 /* voice */, 1, 2, "voice")
	if status != http.StatusCreated {
		t.Fatalf("voice channel = %d", status)
	}
	api.NewCalls(e.Repo, api.NewResolver(e.Repo), nil, api.CallsConfig{}, e.Clk, slog.New(slog.DiscardHandler)).Register(e.Mux)
	group := seedCallGroup(t, e, ch, cid, callGroupEpoch)
	if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status != http.StatusForbidden {
		t.Fatalf("a device that is no leaf = %d, want the leaf gate's 403", status)
	}
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	if status != http.StatusNotImplemented {
		t.Fatalf("a call on an instance with no SFU = %d (%x), want 501", status, body)
	}
	if _, err := e.Repo.GetVoiceSession(t.Context(), ch); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("a refused start recorded a voice session: %v", err)
	}
}

func ownerCommunityOf(t *testing.T, e *env, ch id.ID) id.ID {
	t.Helper()
	row, err := e.Repo.GetChannel(t.Context(), ch)
	if err != nil || row.CommunityID == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	return *row.CommunityID
}
