package api_test

// UP8 (R-UP11): the relay runs in `dillad media`. A relay cut the media relay has not acknowledged
// keeps the device pending, and the call routes count the call tokens they mint for `dillad media
// --idle`.

import (
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// ackRelay is a relay revoker in front of a relay in another process: every cut stays
// unacknowledged until ack.
type ackRelay struct {
	fakeRelay
	amu     sync.Mutex
	unacked map[id.ID]bool
}

func (a *ackRelay) Revoke(device id.ID, at time.Time) {
	a.fakeRelay.Revoke(device, at)
	a.amu.Lock()
	defer a.amu.Unlock()
	a.unacked[device] = true
}

func (a *ackRelay) Unacked(device id.ID) bool {
	a.amu.Lock()
	defer a.amu.Unlock()
	return a.unacked[device]
}

func (a *ackRelay) ack(device id.ID) {
	a.amu.Lock()
	defer a.amu.Unlock()
	delete(a.unacked, device)
}

// R-UP11: a device whose relay cut the media relay has not acknowledged is refused like one whose
// SFU repair is pending — 503 E_UNAVAILABLE with retry_after_ms at the start, the /rtc gate and the
// share route, with nothing minted or admitted — and, once acknowledged, is admitted again.
func TestAnUnacknowledgedRelayCutIs503AtTheStartTheGateAndShare(t *testing.T) {
	b := newBarredEnv(t)
	relay := &ackRelay{unacked: map[id.ID]bool{}}
	b.calls.WithRelay(relay)
	relay.Revoke(b.memberDev, time.Now())
	minted := len(b.stub.minted())
	status, body := b.e.Do(http.MethodPost, "/v1/channels/"+b.ch.String()+"/calls", b.memberTok, []any{})
	if status != http.StatusServiceUnavailable || b.e.ErrCode(body) != "E_UNAVAILABLE" || retryAfterOf(t, body) != 2000 {
		t.Fatalf("a start with an unacknowledged relay cut = %d %s, want 503 E_UNAVAILABLE with retry_after_ms 2000",
			status, b.e.ErrCode(body))
	}
	if len(b.stub.minted()) != minted {
		t.Fatal("a token was minted for a device whose relay cut is unacknowledged")
	}
	if se := gateRefusal(t, b.calls, b.room, b.memberDev); se == nil || se.Code != server.CodeUnavailable {
		t.Fatalf("the gate with an unacknowledged relay cut = %v, want E_UNAVAILABLE", se)
	}
	if status, body := b.e.Do(http.MethodPost, b.sharePath(), b.memberTok, []any{}); status != http.StatusServiceUnavailable ||
		b.e.ErrCode(body) != "E_UNAVAILABLE" {
		t.Fatalf("a share with an unacknowledged relay cut = %d %s, want 503 E_UNAVAILABLE", status, b.e.ErrCode(body))
	}
	if se := gateRefusal(t, b.calls, b.room, b.ownerDev); se != nil {
		t.Fatalf("another device was refused at the gate: %v", se)
	}
	relay.ack(b.memberDev)
	if se := gateRefusal(t, b.calls, b.room, b.memberDev); se != nil {
		t.Fatalf("the gate once the cut was acknowledged = %v, want an admission", se)
	}
	if status, body := b.e.Do(http.MethodPost, "/v1/channels/"+b.ch.String()+"/calls", b.memberTok, []any{}); status != http.StatusOK {
		t.Fatalf("a start once the cut was acknowledged = %d %s, want 200", status, b.e.ErrCode(body))
	}
}

// R-UP4: GET /media/recent-mints counts the call tokens minted within the last 60 s.
func TestRecentMintsCountsTheLastMinutesCallTokens(t *testing.T) {
	e, ch, tok, group, _, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	if n := calls.RecentMints(); n != 1 {
		t.Fatalf("recent mints during the API startup grace period = %d, want 1 (busy)", n)
	}
	for range 2 {
		if status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status >= 300 {
			t.Fatalf("start = %d %s", status, e.ErrCode(body))
		}
		e.Clk.Advance(30 * time.Second)
	}
	if n := calls.RecentMints(); n != 1 {
		t.Fatalf("recent mints 30 s and 60 s after two starts = %d, want 1", n)
	}
	e.Clk.Advance(30 * time.Second)
	if n := calls.RecentMints(); n != 0 {
		t.Fatalf("recent mints 60 s after the last start = %d, want 0", n)
	}
}

func TestRecentMintsIsBusyAfterRestartWithAnOldEmptyRoom(t *testing.T) {
	e, ch, tok, group, stub, previous := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	e.Clk.Advance(61 * time.Second)
	if status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status >= http.StatusMultipleChoices {
		t.Fatalf("start in the old empty room = %d %s", status, e.ErrCode(body))
	}
	if len(stub.minted()) != 1 {
		t.Fatalf("previous API process minted %d tokens, want 1", len(stub.minted()))
	}

	e.Clk.Advance(time.Second)
	restarted := api.NewCalls(e.Repo, api.NewResolver(e.Repo), stub,
		api.CallsConfig{LiveKitURL: testLiveKitURL}, e.Clk, slog.New(slog.DiscardHandler))
	if n := previous.RecentMints(); n != 1 {
		t.Fatalf("previous API process recent mints = %d, want 1", n)
	}
	if n := restarted.RecentMints(); n != 1 {
		t.Fatalf("recent mints after API restart = %d, want busy until the startup grace period ends", n)
	}
	e.Clk.Advance(59 * time.Second)
	if n := restarted.RecentMints(); n != 1 {
		t.Fatalf("recent mints 59 s after API restart = %d, want busy", n)
	}
	e.Clk.Advance(time.Second)
	if n := restarted.RecentMints(); n != 0 {
		t.Fatalf("recent mints 60 s after API restart = %d, want 0", n)
	}
}

// Today's mint race (TestNoCredentialFromAStartOutlivesACutDuringIt), through the revoker that
// forwards cuts to the media relay: Mint stays ordered against cuts under the API's local lock.
func TestNoCredentialFromAStartOutlivesACutDuringItThroughTheMediaRevoker(t *testing.T) {
	t.Run("a cut between the gates and the mint", func(t *testing.T) {
		e, dev, _, rv, release, done := startParkedVia(t, "mint", true)
		e.Clk.Advance(time.Millisecond)
		rv.Revoke(dev, e.Clk.Now())
		e.Clk.Advance(time.Millisecond)
		release()
		res := <-done
		if status := res[0].(int); status != http.StatusTooManyRequests || e.ErrCode(res[1].([]byte)) != "E_RATE_LIMITED" {
			t.Fatalf("a start cut before its mint = %d %s, want 429 E_RATE_LIMITED", status, e.ErrCode(res[1].([]byte)))
		}
	})
	t.Run("a cut between the mint and the response", func(t *testing.T) {
		e, dev, rev, rv, release, done := startParkedVia(t, "respond", true)
		rv.Revoke(dev, e.Clk.Now())
		release()
		res := <-done
		if status := res[0].(int); status != http.StatusCreated {
			t.Fatalf("start = %d %s", status, e.ErrCode(res[1].([]byte)))
		}
		if issued := issuedOfCall(t, res[1].([]byte)); !cutCovers(rev, dev, issued) {
			t.Fatalf("the credential issued at %v outlived the cut that followed its mint", issued)
		}
	})
}
