package api_test

import (
	"net/http"
	"testing"
	"time"
)

// The web3.8 move cases, rewritten to the built-in channel (web3.9): the community's own AFK channel
// at a 60 s timeout (newPendingEnv), the server cutting an idle device from its room and the client
// joining AFK on its own pending.

func TestAFKTimeoutCutsMediaAndTheDeviceMayJoinAgain(t *testing.T) {
	p := newPendingEnv(t)
	activity := "/v1/communities/" + p.cid.String() + "/afk/activity"
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	if code, body := p.e.Do(http.MethodPost, activity, p.memberTok, []any{p.ch[:]}); code != http.StatusNoContent {
		t.Fatalf("activity = %d: %x", code, body)
	}
	p.e.Clk.Advance(59 * time.Second)
	p.calls.SweepAFK(t.Context())
	if removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("moved before timeout")
	}
	p.e.Clk.Advance(2 * time.Second)
	p.calls.SweepAFK(t.Context())
	if !removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("idle device kept its media session")
	}
	// Nothing blocks the device any more: the AFK channel is an ordinary call, and so is the one
	// it left.
	if code, body := p.e.Do(http.MethodPost, "/v1/channels/"+p.ch.String()+"/calls", p.memberTok, []any{}); code != http.StatusOK {
		t.Fatalf("rejoin after the move = %d (%x), want 200", code, body)
	}
}

func TestAFKAdmissionStartsTimerWithoutBrowserActivity(t *testing.T) {
	p := newPendingEnv(t)
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	p.e.Clk.Advance(40 * time.Second)
	p.calls.Admitted(t.Context(), p.room, p.memberDev, true)
	p.e.Clk.Advance(21 * time.Second)
	p.calls.SweepAFK(t.Context())
	if !removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("suspended device kept media after admission timeout")
	}
}

func TestAFKFreshAdmissionRestartsTimer(t *testing.T) {
	p := newPendingEnv(t)
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	p.e.Clk.Advance(50 * time.Second)
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	p.e.Clk.Advance(20 * time.Second)
	p.calls.SweepAFK(t.Context())
	if removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("fresh voice admission inherited an old inactivity timer")
	}
	p.e.Clk.Advance(41 * time.Second)
	p.calls.SweepAFK(t.Context())
	if !removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("fresh admission timer did not expire")
	}
}

// web3.8's "enable AFK" is now a timeout change: an existing admission is judged by the new timeout.
func TestAFKTimeoutChangeKeepsExistingAdmissionTimer(t *testing.T) {
	p := newPendingEnv(t)
	settings := "/v1/communities/" + p.cid.String() + "/afk/settings"
	if code, _ := p.e.Do(http.MethodPut, settings, p.ownerTok, []any{uint64(300)}); code != http.StatusNoContent {
		t.Fatalf("PUT [300] = %d", code)
	}
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	p.e.Clk.Advance(61 * time.Second)
	p.calls.SweepAFK(t.Context())
	if removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("moved inside the 5 minute timeout")
	}
	if code, _ := p.e.Do(http.MethodPut, settings, p.ownerTok, []any{uint64(60)}); code != http.StatusNoContent {
		t.Fatalf("PUT [60] = %d", code)
	}
	p.calls.SweepAFK(t.Context())
	if !removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("existing idle device was not moved after the timeout was shortened")
	}
}

// web3.8's manual move is retired (R41): it moves nobody.
func TestAFKManualMoveIsRetired(t *testing.T) {
	p := newPendingEnv(t)
	if code, _ := p.e.Do(http.MethodPost, "/v1/communities/"+p.cid.String()+"/afk", p.memberTok, []any{p.ch[:]}); code != http.StatusNotFound {
		t.Fatalf("manual move = %d, want 404", code)
	}
	if removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("the retired route moved the device")
	}
	if got := p.pending(t, p.memberTok); got != 0 {
		t.Fatalf("pending after the retired route = %d", got)
	}
}

func TestAFKActivityResetsOnlyItsOwnDeviceTimer(t *testing.T) {
	p := newPendingEnv(t)
	path := "/v1/communities/" + p.cid.String() + "/afk/activity"
	p.calls.Admitted(t.Context(), p.room, p.memberDev, false)
	if code, _ := p.e.Do(http.MethodPost, path, p.memberTok, []any{p.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	p.e.Clk.Advance(50 * time.Second)
	if code, _ := p.e.Do(http.MethodPost, path, p.memberTok, []any{p.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	p.e.Clk.Advance(20 * time.Second)
	if code, _ := p.e.Do(http.MethodPost, path, p.ownerTok, []any{p.ch[:]}); code != 204 {
		t.Fatal(code)
	}
	p.calls.SweepAFK(t.Context())
	if removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("another device or early sweep moved the member")
	}
	p.e.Clk.Advance(41 * time.Second)
	p.calls.SweepAFK(t.Context())
	if !removedDevice(p.stub, p.room, p.memberDev) {
		t.Fatal("member did not move after its own inactivity")
	}
}

// web3.8's occupant snapshot is retired: the snapshot names the built-in channel, and its third
// element is always the empty list, before and after a move.
func TestAFKSnapshotNamesTheBuiltInChannelWithAnEmptyList(t *testing.T) {
	p := newPendingEnv(t)
	for _, step := range []string{"before", "after"} {
		for _, tok := range []string{p.ownerTok, p.memberTok} {
			ch, timeout, retired, _ := afkSnapshotOf(t, p.e, p.cid, tok)
			if ch == nil || *ch != p.afk || timeout != 60 || retired != 0 {
				t.Fatalf("%s the move: snapshot = %v %d %d", step, ch, timeout, retired)
			}
		}
		if step == "before" {
			p.idleMove(t)
		}
	}
	if code, _ := p.e.Do(http.MethodDelete, "/v1/communities/"+p.cid.String()+"/afk", p.memberTok, nil); code != http.StatusNotFound {
		t.Fatalf("leave AFK = %d, want 404 (retired)", code)
	}
}
