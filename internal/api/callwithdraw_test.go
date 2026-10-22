package api_test

// callwithdraw_test.go: UP6b (R-UP12, correction I2). The call start withdraws the device's own
// absence Remove immediately before the token mint and noteAdmission, after every check that may
// still refuse it; a refused start withdraws nothing, a delivery-service error mints nothing (503),
// and a membership a commit removed first answers E_LEAF_NOT_CURRENT.

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"testing"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
)

type withdrawEnv struct {
	e     *env
	ch    id.ID
	group id.ID
	tok   string
	dev   id.ID
	stub  *stubSFU
	calls *api.Calls
	ds    *callDS
}

func newWithdrawEnv(t *testing.T, cfg api.CallsConfig) *withdrawEnv {
	t.Helper()
	cfg.LiveKitURL = testLiveKitURL
	e, ch, tok, group, stub, calls := callEnvCalls(t, cfg)
	w := &withdrawEnv{e: e, ch: ch, group: group, tok: tok, dev: deviceOf(t, e, tok), stub: stub, calls: calls,
		ds: &callDS{repo: e.Repo}}
	api.NewCallEvents(e.Repo, api.NewResolver(e.Repo), w.ds, stub, calls, &voiceGW{}, e.Clk, slog.New(slog.DiscardHandler))
	seedLeaf(t, e, group, w.dev, 3, nil)
	return w
}

func (w *withdrawEnv) start(tok string) (int, []byte) {
	return w.e.Do(http.MethodPost, "/v1/channels/"+w.ch.String()+"/calls", tok, []any{})
}

// A start that succeeds withdraws the device's own membership — its leaf, taken in its epoch — and
// does it after CreateRoom and before the mint.
func TestAStartWithdrawsItsOwnMembershipLastBeforeTheMint(t *testing.T) {
	w := newWithdrawEnv(t, api.CallsConfig{})
	var mintedAt, createdAt int
	w.ds.onWithdraw = func() {
		w.stub.mu.Lock()
		createdAt = len(w.stub.created)
		w.stub.mu.Unlock()
		mintedAt = len(w.stub.minted())
	}
	if status, body := w.start(w.tok); status != http.StatusCreated {
		t.Fatalf("start = %d %s", status, w.e.ErrCode(body))
	}
	got := w.ds.withdrawn()
	if len(got) != 1 || got[0].Group != w.group || got[0].Device != w.dev || got[0].Added != 3 {
		t.Fatalf("withdrawals %+v, want one of the device's own membership (added at 3)", got)
	}
	if createdAt == 0 || mintedAt != 0 {
		t.Fatalf("at the withdrawal %d rooms were created and %d tokens minted; want the room opened and nothing minted yet", createdAt, mintedAt)
	}
	if len(w.stub.minted()) != 1 {
		t.Fatal("no token after the withdrawal")
	}
}

// TestStartRefusedWithdrawsNothing (I2): a start refused by callFull, one that is isPending (503) and
// one whose CreateRoom fails leave the Remove outstanding — nothing is withdrawn. A delivery-service
// error at the withdrawal answers 503, and no token is minted.
func TestStartRefusedWithdrawsNothing(t *testing.T) {
	t.Run("callFull", func(t *testing.T) {
		w := newWithdrawEnv(t, api.CallsConfig{MaxVoiceParticipants: 1})
		if status, _ := w.start(w.tok); status != http.StatusCreated {
			t.Fatalf("the owner's start = %d", status)
		}
		room := w.stub.minted()[0][0]
		_, memberDev, memberTok := joinedMember(t, w.e, w.ch, w.group, "member")
		w.stub.setPresent(room, &livekit.ParticipantInfo{Identity: w.dev.String()})
		before := len(w.ds.withdrawn())
		status, body := w.start(memberTok)
		if status == http.StatusOK || w.e.ErrCode(body) != "E_CALL_FULL" {
			t.Fatalf("a start into a full call = %d %s, want E_CALL_FULL", status, w.e.ErrCode(body))
		}
		for _, wd := range w.ds.withdrawn()[before:] {
			if wd.Device == memberDev {
				t.Fatal("a start refused by callFull withdrew the device's Remove")
			}
		}
	})
	t.Run("isPending", func(t *testing.T) {
		w := newWithdrawEnv(t, api.CallsConfig{})
		_, body := w.start(w.tok)
		callID := decodeCall(t, body).CallID
		room := w.stub.minted()[0][0]
		_, memberDev, memberTok := joinedMember(t, w.e, w.ch, w.group, "member")
		w.calls.MarkPending(callID, memberDev, room)
		w.stub.mu.Lock()
		w.stub.failUpdates = 1000
		w.stub.mu.Unlock()
		before := len(w.ds.withdrawn())
		status, body := w.start(memberTok)
		if status != http.StatusServiceUnavailable || w.e.ErrCode(body) != "E_UNAVAILABLE" {
			t.Fatalf("a start under a pending repair = %d %s, want 503", status, w.e.ErrCode(body))
		}
		if len(w.ds.withdrawn()) != before {
			t.Fatal("a start refused by isPending withdrew a Remove")
		}
	})
	t.Run("CreateRoom fails", func(t *testing.T) {
		w := newWithdrawEnv(t, api.CallsConfig{})
		w.stub.mu.Lock()
		w.stub.createFail = errors.New("sfu down")
		w.stub.mu.Unlock()
		if status, body := w.start(w.tok); status != http.StatusServiceUnavailable || w.e.ErrCode(body) != "E_UNAVAILABLE" {
			t.Fatalf("a start whose room will not open = %d %s, want 503", status, w.e.ErrCode(body))
		}
		if n := len(w.ds.withdrawn()); n != 0 {
			t.Fatalf("%d withdrawals, want none", n)
		}
	})
	t.Run("a DS error at the withdrawal", func(t *testing.T) {
		w := newWithdrawEnv(t, api.CallsConfig{})
		w.ds.withdrawErr = errors.New("the delivery service is down")
		status, body := w.start(w.tok)
		if status != http.StatusServiceUnavailable || w.e.ErrCode(body) != "E_UNAVAILABLE" || retryAfterOf(t, body) <= 0 {
			t.Fatalf("a start whose withdrawal failed = %d %s, want 503 E_UNAVAILABLE with retry_after_ms", status, w.e.ErrCode(body))
		}
		if len(w.stub.minted()) != 0 {
			t.Fatal("a token was minted although the withdrawal failed")
		}
	})
}

// A commit that removed the device first: the withdrawal answers ErrMembershipGone, the start
// E_LEAF_NOT_CURRENT, and nothing is minted. The device forgets the group and joins afresh.
func TestAStartWhoseMembershipIsGoneIsLeafNotCurrent(t *testing.T) {
	w := newWithdrawEnv(t, api.CallsConfig{})
	w.ds.withdrawErr = fmt.Errorf("callDS: %w", ds.ErrMembershipGone)
	status, body := w.start(w.tok)
	if status != http.StatusForbidden || w.e.ErrCode(body) != "E_LEAF_NOT_CURRENT" {
		t.Fatalf("a start whose membership went = %d %s, want 403 E_LEAF_NOT_CURRENT", status, w.e.ErrCode(body))
	}
	if len(w.stub.minted()) != 0 {
		t.Fatal("a token was minted for a removed membership")
	}
}

// Attack: a barred device's start is 403 and withdraws nothing, and so is the start of a device
// whose leaf is gone (a kicked user's leaf is removed with the kick).
func TestABarredOrRemovedDevicesStartWithdrawsNothing(t *testing.T) {
	for _, state := range barredStates() {
		t.Run(state.name, func(t *testing.T) {
			w := newWithdrawEnv(t, api.CallsConfig{})
			state.bar(t, w.e, userOf(t, w.e, w.tok), w.dev)
			if status, _ := w.start(w.tok); status == http.StatusCreated || status == http.StatusOK {
				t.Fatalf("a %s device's start = %d, want a refusal", state.name, status)
			}
			if n := len(w.ds.withdrawn()); n != 0 {
				t.Fatalf("a %s device's start withdrew %d times", state.name, n)
			}
		})
	}
	t.Run("removed leaf", func(t *testing.T) {
		w := newWithdrawEnv(t, api.CallsConfig{})
		_, goneTok := w.e.NewUser("gone")
		joinCommunity(t, w.e, ownerCommunityOf(t, w.e, w.ch), goneTok)
		gone := deviceOf(t, w.e, goneTok)
		removed := uint64(callGroupEpoch)
		seedLeaf(t, w.e, w.group, gone, 3, &removed)
		if status, body := w.start(goneTok); w.e.ErrCode(body) != "E_LEAF_NOT_CURRENT" {
			t.Fatalf("a removed leaf's start = %d %s, want E_LEAF_NOT_CURRENT", status, w.e.ErrCode(body))
		}
		for _, wd := range w.ds.withdrawn() {
			if wd.Device == gone {
				t.Fatal("a removed leaf's start withdrew a Remove")
			}
		}
	})
}
