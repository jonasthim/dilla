package api_test

// UP2 of the plan "calls survive an upgrade": the server half. A pending cut and an SFU that does
// not answer are transient refusals (R-UP7: 503 E_UNAVAILABLE with retry_after_ms), and an API that
// restarts while the SFU keeps its rooms rebuilds what its memory lost with one whole-room reconcile
// of every live call at boot (BootReconcile): the sharing slots of the camera and screen publishers
// (F1), and the cuts of barred participants or participants without a current leaf. It ends no call
// and reaps nothing, and when the SFU does not answer it leaves each room as a pending room resync.

import (
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// gateRefusal is AdmitRoom's refusal as a *server.Error, or nil.
func gateRefusal(t *testing.T, calls *api.Calls, room string, dev id.ID) *server.Error {
	t.Helper()
	perm, err := calls.AdmitRoom(t.Context(), room, dev)
	if err == nil {
		return nil
	}
	var se *server.Error
	if !errors.As(err, &se) {
		t.Fatalf("the gate failed with no refusal: %v", err)
	}
	if perm != nil {
		t.Fatalf("the gate refused %s but answered a permission", dev)
	}
	return se
}

// R-UP7: a removal or demotion that has not landed in the SFU answers 503 E_UNAVAILABLE with
// retry_after_ms 2000 at the start and at the /rtc gate, and mints and admits nothing. It is still a
// refusal: once the repair lands every other check runs again, and a barred device gets its 403.
func TestAPendingCutIsTransientAndStillARefusal(t *testing.T) {
	t.Run("a pending demotion", func(t *testing.T) {
		b := newBarredEnv(t)
		b.calls.MarkPending(b.callID, b.memberDev, b.room)
		b.stub.mu.Lock()
		b.stub.failUpdates = 1000 // the device's own retry does not land either
		b.stub.mu.Unlock()
		minted := len(b.stub.minted())
		status, body := b.e.Do(http.MethodPost, "/v1/channels/"+b.ch.String()+"/calls", b.memberTok, []any{})
		if status != http.StatusServiceUnavailable || b.e.ErrCode(body) != "E_UNAVAILABLE" || retryAfterOf(t, body) != 2000 {
			t.Fatalf("a start under a pending repair = %d %s, want 503 E_UNAVAILABLE with retry_after_ms 2000",
				status, b.e.ErrCode(body))
		}
		if len(b.stub.minted()) != minted {
			t.Fatal("a token was minted for a device whose repair is pending")
		}
		se := gateRefusal(t, b.calls, b.room, b.memberDev)
		if se == nil || se.Code != server.CodeUnavailable || se.RetryAfterMS == nil || *se.RetryAfterMS != 2000 {
			t.Fatalf("the gate under a pending repair = %v, want E_UNAVAILABLE with retry_after_ms 2000", se)
		}
		// The repair lands: the device that is entitled is admitted and minted again.
		b.stub.mu.Lock()
		b.stub.failUpdates = 0
		b.stub.mu.Unlock()
		if se := gateRefusal(t, b.calls, b.room, b.memberDev); se != nil {
			t.Fatalf("the gate once the repair landed = %v, want an admission", se)
		}
		if status, _ := b.e.Do(http.MethodPost, "/v1/channels/"+b.ch.String()+"/calls", b.memberTok, []any{}); status != http.StatusOK {
			t.Fatalf("a start once the repair landed = %d, want 200", status)
		}
	})
	t.Run("a pending cut of a barred device", func(t *testing.T) {
		b := newBarredEnv(t)
		barredStates()[0].bar(t, b.e, b.member, b.memberDev)
		b.stub.mu.Lock()
		b.stub.failRemovals = 1000
		b.stub.mu.Unlock()
		b.calls.SweepRooms(t.Context())
		if b.calls.PendingRepairs() != 1 {
			t.Fatalf("pending repairs = %d, want the refused cut", b.calls.PendingRepairs())
		}
		se := gateRefusal(t, b.calls, b.room, b.memberDev)
		if se == nil || se.Code != server.CodeUnavailable || se.RetryAfterMS == nil || *se.RetryAfterMS != 2000 {
			t.Fatalf("the gate under a pending cut = %v, want E_UNAVAILABLE with retry_after_ms 2000", se)
		}
		b.stub.mu.Lock()
		b.stub.failRemovals = 0
		b.stub.mu.Unlock()
		se = gateRefusal(t, b.calls, b.room, b.memberDev)
		if se == nil || se.Code != server.CodeForbidden {
			t.Fatalf("the gate once the cut landed = %v, want 403 E_FORBIDDEN for the barred device", se)
		}
		if !removedDevice(b.stub, b.room, b.memberDev) || b.calls.PendingRepairs() != 0 {
			t.Fatal("the gate's own retry did not land the cut")
		}
	})
}

// R-UP7: while the SFU does not answer, a start is 503 E_UNAVAILABLE with retry_after_ms 2000, not
// 500, whether the room will not open or the token will not mint; nothing is minted.
func TestAnSFUDownAtStartAnswers503(t *testing.T) {
	for _, tc := range []struct {
		name string
		down func(s *stubSFU)
	}{
		{"the room will not open", func(s *stubSFU) { s.createFail = errors.New("sfu down") }},
		{"the token will not mint", func(s *stubSFU) { s.fail = errors.New("sfu down") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, ch, tok, group, stub := callEnvWith(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
			seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
			stub.mu.Lock()
			tc.down(stub)
			stub.mu.Unlock()
			status, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
			if status != http.StatusServiceUnavailable || e.ErrCode(body) != "E_UNAVAILABLE" || retryAfterOf(t, body) != 2000 {
				t.Fatalf("a start with the SFU down = %d %s, want 503 E_UNAVAILABLE with retry_after_ms 2000", status, e.ErrCode(body))
			}
			if len(stub.minted()) != 0 {
				t.Fatal("a token was minted while the SFU was down")
			}
		})
	}
}

// restarted is a second call route group over the same store and SFU, as `dilla` is after an API
// restart while `dilla-media` keeps its rooms: nothing of the first one's memory (slots, repairs,
// strikes, admissions) carries over. Its call events record Removes in ds.
func restarted(t *testing.T, e *env, stub *stubSFU, cfg api.CallsConfig) (*api.Calls, *callDS) {
	t.Helper()
	cfg.LiveKitURL = testLiveKitURL
	calls := api.NewCalls(e.Repo, api.NewResolver(e.Repo), stub, cfg, e.Clk, slog.New(slog.DiscardHandler))
	ds := &callDS{repo: e.Repo}
	api.NewCallEvents(e.Repo, api.NewResolver(e.Repo), ds, stub, calls, &voiceGW{}, e.Clk, slog.New(slog.DiscardHandler))
	return calls, ds
}

// publishing is a participant publishing the given sources as dilla-sframe/1 tracks, each published
// at the given microsecond.
func publishing(dev id.ID, at int64, sources ...livekit.TrackSource) *livekit.ParticipantInfo {
	p := &livekit.ParticipantInfo{Identity: dev.String()}
	for i, s := range sources {
		kind := livekit.TrackType_VIDEO
		if s == livekit.TrackSource_MICROPHONE || s == livekit.TrackSource_SCREEN_SHARE_AUDIO {
			kind = livekit.TrackType_AUDIO
		}
		p.Tracks = append(p.Tracks, &livekit.TrackInfo{
			Sid: "TR_" + dev.String()[:8] + "_" + string(rune('a'+i)), Type: kind, Source: s,
			Encryption: livekit.Encryption_CUSTOM, Version: &livekit.TimedVersion{UnixMicro: at},
		})
	}
	return p
}

// presentLeaves makes every current leaf of l's call group but those in except present in the room,
// with a microphone.
func presentLeaves(t *testing.T, l *leaseEnv, except ...id.ID) {
	t.Helper()
	row, err := l.e.Repo.GetVoiceSession(t.Context(), l.callID)
	if err != nil {
		t.Fatalf("GetVoiceSession: %v", err)
	}
	members, err := l.e.Repo.ListMembers(t.Context(), *row.GroupID)
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	var present []*livekit.ParticipantInfo
	for i, m := range members {
		if m.RemovedEpoch == nil && !slices.Contains(except, m.DeviceID) {
			present = append(present, publishing(m.DeviceID, int64(i+1), livekit.TrackSource_MICROPHONE))
		}
	}
	l.stub.setPresent(l.room, present...)
}

// hasSource reports whether p allows publishing source.
func hasSource(p *livekit.ParticipantPermission, source livekit.TrackSource) bool {
	return slices.Contains(p.GetCanPublishSources(), source)
}

// F1: after an API restart, the camera publisher the SFU still holds keeps its camera. The boot
// reconcile adopts its slot, and neither it nor the first sweep ever pushes it a permission
// without the camera.
func TestAnAPIRestartKeepsALiveCameraPublisher(t *testing.T) {
	l := newLeaseEnv(t, 2, 2)
	if status := l.share(0); status != http.StatusNoContent {
		t.Fatalf("dev0 share = %d", status)
	}
	l.stub.setPresent(l.room, publishing(l.devs[0], 1_000, livekit.TrackSource_MICROPHONE, livekit.TrackSource_CAMERA),
		publishing(l.devs[1], 2_000, livekit.TrackSource_MICROPHONE))
	before := len(l.stub.permUpdates())

	calls, _ := restarted(t, l.e, l.stub, api.CallsConfig{MaxPublishers: 2})
	calls.BootReconcile(t.Context())
	if got := calls.SharersOf(l.callID); len(got) != 1 || got[0] != l.devs[0] {
		t.Fatalf("slot holders after the boot reconcile = %v, want the camera publisher", got)
	}
	l.e.Clk.Advance(api.RoomSweepInterval)
	calls.SweepRooms(t.Context())
	if !hasCamera(l.stub.lastPerms()[l.devs[0].String()]) {
		t.Fatal("the camera publisher lost its camera after the restart's first sweep")
	}
	for _, u := range l.stub.permUpdates()[before:] {
		if u.Identity == l.devs[0].String() && !hasCamera(u.Perm) {
			t.Fatalf("the restarted instance pushed the camera publisher a permission without the camera: %+v", u)
		}
	}
	if hasCamera(l.stub.lastPerms()[l.devs[1].String()]) {
		t.Fatal("a device that publishes no camera was given one")
	}
}

// F1: adoption is oldest publication first, up to livekit.max_publishers, and never adopts a
// barred device or one publishing media that is not dilla-sframe/1; only the excess is demoted.
func TestSlotAdoptionIsOldestFirstWithinTheCapAndSkipsTheIneligible(t *testing.T) {
	l := newLeaseEnv(t, 2, 5)
	barred, foreign, first, second, excess := l.devs[0], l.devs[1], l.devs[2], l.devs[3], l.devs[4]
	if err := l.e.Repo.RevokeDevice(t.Context(), barred, l.e.Clk.Now().Unix()); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	bad := publishing(foreign, 200, livekit.TrackSource_CAMERA)
	bad.Tracks[0].Encryption = livekit.Encryption_NONE
	l.stub.setPresent(l.room,
		publishing(excess, 900, livekit.TrackSource_CAMERA),
		publishing(barred, 100, livekit.TrackSource_CAMERA),
		bad,
		publishing(second, 400, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO),
		publishing(first, 300, livekit.TrackSource_CAMERA))

	calls, _ := restarted(t, l.e, l.stub, api.CallsConfig{MaxPublishers: 2})
	calls.BootReconcile(t.Context())
	want := []id.ID{first, second}
	slices.SortFunc(want, func(a, b id.ID) int { return slices.Compare(a[:], b[:]) })
	if got := calls.SharersOf(l.callID); !slices.Equal(got, want) {
		t.Fatalf("slot holders = %v, want the two oldest eligible publishers %v", got, want)
	}
	perms := l.stub.lastPerms()
	if !hasCamera(perms[first.String()]) || !hasSource(perms[second.String()], livekit.TrackSource_SCREEN_SHARE) {
		t.Fatal("an adopted publisher lost its source")
	}
	if p, in := perms[excess.String()]; !in || hasCamera(p) {
		t.Fatalf("the publisher past the cap = %v, want it demoted and kept", p)
	}
	if hasCamera(perms[foreign.String()]) {
		t.Fatal("a device publishing media that is not dilla-sframe/1 was given a slot")
	}
	if !removedDevice(l.stub, l.room, barred) {
		t.Fatal("the barred publisher was not cut")
	}
	// The first sweep after keeps exactly that.
	calls.SweepRooms(t.Context())
	if got := calls.SharersOf(l.callID); !slices.Equal(got, want) {
		t.Fatalf("slot holders after the first sweep = %v, want %v", got, want)
	}
}

// Nothing at start ends a live call whose room the SFU still holds: after an API restart the call
// row, its group and its participants are untouched, and no Remove is proposed for a participant the
// SFU still holds, at boot or at the sweeps after.
func TestAnAPIRestartLeavesALiveCallAsItIs(t *testing.T) {
	l := newLeaseEnv(t, 2, 2)
	row, err := l.e.Repo.GetVoiceSession(t.Context(), l.callID)
	if err != nil {
		t.Fatalf("GetVoiceSession: %v", err)
	}
	presentLeaves(t, l)
	calls, ds := restarted(t, l.e, l.stub, api.CallsConfig{MaxPublishers: 2})
	calls.BootReconcile(t.Context())
	for range 3 {
		l.e.Clk.Advance(api.RoomSweepInterval + time.Second)
		calls.SweepRooms(t.Context())
		calls.RetryPending(t.Context())
	}
	after, err := l.e.Repo.GetVoiceSession(t.Context(), l.callID)
	if err != nil || after.Ended != nil || after.LivekitRoom != row.LivekitRoom {
		t.Fatalf("the call after the restart = %+v (%v), want it live in the same room", after, err)
	}
	g, err := l.e.Repo.GetGroup(t.Context(), *row.GroupID)
	if err != nil || g.ClosedAt != nil {
		t.Fatalf("the call group after the restart = closed %v (%v)", g.ClosedAt, err)
	}
	if devices, identities := l.stub.removals(); len(devices) != 0 || len(identities) != 0 {
		t.Fatalf("the restart cut participants the SFU holds: %v %v", devices, identities)
	}
	if slices.Contains(l.stub.deletedRooms(), l.room) {
		t.Fatal("the restart closed a live call's room")
	}
	if got := ds.removeDevices(); len(got) != 0 {
		t.Fatalf("Removes were proposed for participants the SFU still holds: %v", got)
	}
}

// A participant_left lost while the API was down is recovered by the room sweep within one
// interval: the boot reconcile sees the leaf absent, and the sweep a period later proposes its
// Remove, bound to its membership.
func TestALeaveLostDuringTheRestartIsRecoveredByTheSweep(t *testing.T) {
	l := newLeaseEnv(t, 2, 2)
	gone := l.devs[1]
	// gone left the room while the API was down: its participant_left never arrived.
	presentLeaves(t, l, gone)
	calls, ds := restarted(t, l.e, l.stub, api.CallsConfig{MaxPublishers: 2})
	calls.BootReconcile(t.Context())
	if got := ds.memberRemovals(); len(got) != 0 {
		t.Fatalf("the boot reconcile proposed %v on a first sight", got)
	}
	l.e.Clk.Advance(api.RoomSweepInterval)
	calls.SweepRooms(t.Context())
	got := ds.memberRemovals()
	if len(got) != 1 || got[0].Device != gone {
		t.Fatalf("Removes one interval after the restart = %+v, want the leaf of the device that left", got)
	}
	for _, r := range got {
		if r.Device == l.devs[0] {
			t.Fatal("the sweep removed the leaf of a device still in the room")
		}
	}
}

// A device barred while the API was down, still in the SFU's room, is evicted by the boot
// reconcile — before the first request is served — and cut from the relay; no one else is.
func TestADeviceBarredWhileTheAPIWasDownIsEvictedAtBoot(t *testing.T) {
	for _, st := range barredStates() {
		t.Run(st.name, func(t *testing.T) {
			b := newBarredEnv(t)
			st.bar(t, b.e, b.member, b.memberDev)
			calls, _ := restarted(t, b.e, b.stub, api.CallsConfig{MaxPublishers: 2})
			relay := &fakeRelay{}
			calls.WithRelay(relay)
			calls.BootReconcile(t.Context())
			if !removedDevice(b.stub, b.room, b.memberDev) {
				t.Fatalf("the boot reconcile did not evict the %s device", st.name)
			}
			if !relay.has(b.memberDev) {
				t.Fatalf("the boot reconcile did not cut the %s device from the relay", st.name)
			}
			if removedDevice(b.stub, b.room, b.ownerDev) {
				t.Fatal("the boot reconcile cut the owner, who is not barred")
			}
		})
	}
}

// With the SFU unreachable at boot nothing is reaped: no call ends, no Remove is proposed, nobody is
// cut, and each live call's room is left as a pending room resync, which the retry loop drives once
// the SFU answers.
func TestWithTheSFUUnreachableAtBootNothingIsReaped(t *testing.T) {
	l := newLeaseEnv(t, 2, 2)
	if err := l.e.Repo.RevokeDevice(t.Context(), l.devs[1], l.e.Clk.Now().Unix()); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	l.stub.mu.Lock()
	l.stub.roomsFail = errors.New("sfu unreachable")
	l.stub.listFail = errors.New("sfu unreachable")
	l.stub.mu.Unlock()
	calls, ds := restarted(t, l.e, l.stub, api.CallsConfig{MaxPublishers: 2})
	calls.BootReconcile(t.Context())
	if callEnded(t, l.e, l.callID) {
		t.Fatal("the boot ended a live call while the SFU was unreachable")
	}
	if got := ds.removeDevices(); len(got) != 0 {
		t.Fatalf("the boot proposed Removes while the SFU was unreachable: %v", got)
	}
	if devices, identities := l.stub.removals(); len(devices) != 0 || len(identities) != 0 {
		t.Fatalf("the boot cut participants while the SFU was unreachable: %v %v", devices, identities)
	}
	if calls.PendingRepairs() != 1 {
		t.Fatalf("pending repairs = %d, want the call's room resync", calls.PendingRepairs())
	}
	// The SFU answers again: the retry loop's pass reconciles the room and the revoked device goes.
	l.stub.mu.Lock()
	l.stub.roomsFail, l.stub.listFail = nil, nil
	l.stub.mu.Unlock()
	calls.RetryPending(t.Context())
	if calls.PendingRepairs() != 0 || !removedDevice(l.stub, l.room, l.devs[1]) {
		t.Fatalf("after the SFU came back: %d pending, revoked device cut %v", calls.PendingRepairs(),
			removedDevice(l.stub, l.room, l.devs[1]))
	}
	if callEnded(t, l.e, l.callID) {
		t.Fatal("the room resync ended the call")
	}
}
