package api_test

import (
	"fmt"
	"math/rand/v2"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
)

// leaseEnv is shareEnv with the mounted *api.Calls, the call's room and the owner's community: an
// open call, the owner's device a leaf, and n more leaf devices of the owner named "dev<i>", every
// one of them present in the room.
type leaseEnv struct {
	e      *env
	stub   *stubSFU
	calls  *api.Calls
	ch     id.ID
	callID id.ID
	room   string
	owner  id.ID
	devs   []id.ID
	max    int
}

func newLeaseEnv(t *testing.T, maxPublishers, n int) *leaseEnv {
	t.Helper()
	e, ch, tok, group, stub, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL, MaxPublishers: maxPublishers})
	seedLeaf(t, e, group, deviceOf(t, e, tok), 3, nil)
	_, body := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{})
	// The devices are a member's, not the owner's: an owner's own overwrite does not bind it.
	user, _, _ := joinedMember(t, e, ch, group, "member")
	devs := seedDevices(t, e, user, n)
	present := []*livekit.ParticipantInfo{}
	for i, d := range devs {
		e.sess[fmt.Sprintf("dev%d", i)] = auth.Session{UserID: user, DeviceID: d, Scope: auth.ScopeEnrolled}
		seedLeaf(t, e, group, d, 3, nil)
		present = append(present, &livekit.ParticipantInfo{Identity: d.String()})
	}
	room := stub.minted()[0][0]
	stub.setPresent(room, present...)
	return &leaseEnv{e: e, stub: stub, calls: calls, ch: ch, callID: decodeCall(t, body).CallID, room: room,
		owner: user, devs: devs, max: maxPublishers}
}

func (l *leaseEnv) sharePath() string { return "/v1/calls/" + l.callID.String() + "/share" }

func (l *leaseEnv) share(i int) int {
	status, _ := l.e.Do(http.MethodPost, l.sharePath(), fmt.Sprintf("dev%d", i), []any{})
	return status
}

func (l *leaseEnv) unshare(i int) int {
	status, _ := l.e.Do(http.MethodDelete, l.sharePath(), fmt.Sprintf("dev%d", i), nil)
	return status
}

func (l *leaseEnv) sync(t *testing.T) error {
	t.Helper()
	return api.SyncCallGrants(t.Context(), l.e.Repo, api.NewResolver(l.e.Repo), l.stub, l.calls,
		ownerCommunityOf(t, l.e, l.ch), nil, &l.ch)
}

// violation is the lease invariant's breach, or "": the devices whose permission in the SFU allows
// a camera or screen source are a subset of the lease holders, and never more than max_publishers.
func (l *leaseEnv) violation() string {
	holders := l.calls.SharersOf(l.callID)
	var video []string
	for identity, p := range l.stub.lastPerms() {
		for _, s := range p.GetCanPublishSources() {
			if s == livekit.TrackSource_CAMERA || s == livekit.TrackSource_SCREEN_SHARE || s == livekit.TrackSource_SCREEN_SHARE_AUDIO {
				video = append(video, identity)
				break
			}
		}
	}
	for _, identity := range video {
		if !slices.ContainsFunc(holders, func(d id.ID) bool { return d.String() == identity }) {
			return fmt.Sprintf("%s holds a video source without a sharing slot (holders %v)", identity, holders)
		}
	}
	if len(video) > l.max {
		return fmt.Sprintf("%d devices hold video sources, max_publishers is %d", len(video), l.max)
	}
	return ""
}

// parkOnce returns a hook that parks the first update matching match until release is closed,
// signalling parked when it does.
func parkOnce(match func(permUpdate) bool) (hook func(permUpdate), parked, release chan struct{}) {
	parked, release = make(chan struct{}), make(chan struct{})
	var once sync.Once
	return func(u permUpdate) {
		if !match(u) {
			return
		}
		fired := false
		once.Do(func() { fired = true })
		if fired {
			close(parked)
			<-release
		}
	}, parked, release
}

// within waits for done for at most d: long enough for a request that nothing blocks to finish, so
// the interleaving the test builds really happens when the implementation lets it.
func within(done <-chan struct{}, d time.Duration) bool {
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// Share against unshare of one device that holds a slot: unshare's demotion is parked after the SFU
// applied it, and a share of the same device races it. The lease transition and its push are one
// step per call, so the device ends either sharing with a slot or demoted without one — never
// promoted without a slot, which would let an extra device take the freed slot.
func TestShareRacingUnshareNeverLeavesVideoWithoutASlot(t *testing.T) {
	l := newLeaseEnv(t, 1, 2)
	if status := l.share(0); status != http.StatusNoContent {
		t.Fatalf("dev0 share = %d", status)
	}
	hook, parked, release := parkOnce(func(u permUpdate) bool {
		return u.Identity == l.devs[0].String() && !hasCamera(u.Perm)
	})
	l.stub.mu.Lock()
	l.stub.onUpdate = hook
	l.stub.mu.Unlock()
	unshareDone, shareDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(unshareDone); l.unshare(0) }()
	<-parked
	go func() { defer close(shareDone); l.share(0) }()
	within(shareDone, 300*time.Millisecond)
	close(release)
	<-unshareDone
	<-shareDone
	if v := l.violation(); v != "" {
		t.Fatalf("after share raced unshare: %s", v)
	}
	l.share(1)
	if v := l.violation(); v != "" {
		t.Fatalf("after another device's share: %s", v)
	}
}

// Two devices race for the last slot while the first one's promotion is still on its way to the
// SFU: exactly one gets it.
func TestShareRacingShareForTheLastSlotHasOneWinner(t *testing.T) {
	l := newLeaseEnv(t, 1, 2)
	hook, parked, release := parkOnce(func(u permUpdate) bool {
		return u.Identity == l.devs[0].String() && hasCamera(u.Perm)
	})
	l.stub.mu.Lock()
	l.stub.beforeUpdate = hook
	l.stub.mu.Unlock()
	var first, second int
	firstDone, secondDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(firstDone); first = l.share(0) }()
	<-parked
	go func() { defer close(secondDone); second = l.share(1) }()
	within(secondDone, 300*time.Millisecond)
	close(release)
	<-firstDone
	<-secondDone
	if first != http.StatusNoContent || second != http.StatusConflict {
		t.Fatalf("shares for the last slot = %d and %d, want 204 and 409", first, second)
	}
	if v := l.violation(); v != "" {
		t.Fatal(v)
	}
}

// SyncCallGrants against share: the device's promotion is parked before the SFU applies it, the
// user loses video and screen_share, and the sync runs. Whatever the order, the device ends without
// a video source: a sync that ran first would have freed the slot of a promotion still in flight.
func TestSyncCallGrantsRacingShareNeverLeavesVideoWithoutASlot(t *testing.T) {
	l := newLeaseEnv(t, 1, 2)
	hook, parked, release := parkOnce(func(u permUpdate) bool {
		return u.Identity == l.devs[0].String() && hasCamera(u.Perm)
	})
	l.stub.mu.Lock()
	l.stub.beforeUpdate = hook
	l.stub.mu.Unlock()
	shareDone, syncDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(shareDone); l.share(0) }()
	<-parked
	denyInChannel(t, l.e, l.ch, l.owner, api.PermVideo|api.PermScreenShare)
	go func() {
		defer close(syncDone)
		if err := l.sync(t); err != nil {
			t.Errorf("SyncCallGrants: %v", err)
		}
	}()
	within(syncDone, 300*time.Millisecond)
	close(release)
	<-shareDone
	<-syncDone
	if v := l.violation(); v != "" {
		t.Fatalf("after the sync raced the share: %s", v)
	}
	if hasCamera(l.stub.lastPerms()[l.devs[0].String()]) {
		t.Fatal("a device whose user lost video and screen_share kept the camera")
	}
}

// SyncCallGrants against unshare: the sync computed the sharer's promoted permission and its push is
// parked before the SFU applies it; the device unshares meanwhile. The sync's push must not land
// after the unshare freed the slot.
func TestSyncCallGrantsRacingUnshareNeverLeavesVideoWithoutASlot(t *testing.T) {
	l := newLeaseEnv(t, 1, 2)
	if status := l.share(0); status != http.StatusNoContent {
		t.Fatalf("dev0 share = %d", status)
	}
	hook, parked, release := parkOnce(func(u permUpdate) bool {
		return u.Identity == l.devs[0].String() && hasCamera(u.Perm)
	})
	l.stub.mu.Lock()
	l.stub.beforeUpdate = hook
	l.stub.mu.Unlock()
	syncDone, unshareDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(syncDone)
		if err := l.sync(t); err != nil {
			t.Errorf("SyncCallGrants: %v", err)
		}
	}()
	<-parked
	go func() { defer close(unshareDone); l.unshare(0) }()
	within(unshareDone, 300*time.Millisecond)
	close(release)
	<-syncDone
	<-unshareDone
	if v := l.violation(); v != "" {
		t.Fatalf("after the sync raced the unshare: %s", v)
	}
	if hasCamera(l.stub.lastPerms()[l.devs[0].String()]) {
		t.Fatal("the device that unshared kept the camera")
	}
}

// Stress, meant for -race: shares, unshares, permission flips and syncs from many goroutines. The
// invariant is checked at every update the SFU applies, not only at the end.
func TestTheLeaseInvariantHoldsUnderConcurrentChurn(t *testing.T) {
	const devices, maxPub, rounds = 6, 2, 40
	l := newLeaseEnv(t, maxPub, devices)
	var mu sync.Mutex
	var breaches []string
	l.stub.mu.Lock()
	l.stub.onUpdate = func(permUpdate) {
		if v := l.violation(); v != "" {
			mu.Lock()
			breaches = append(breaches, v)
			mu.Unlock()
		}
	}
	l.stub.mu.Unlock()
	var wg sync.WaitGroup
	for i := range devices {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := rand.New(rand.NewPCG(uint64(i), 7))
			for range rounds {
				if r.IntN(2) == 0 {
					l.share(i)
				} else {
					l.unshare(i)
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for k := range rounds / 4 {
			if k%2 == 0 {
				denyInChannel(t, l.e, l.ch, l.owner, api.PermVideo|api.PermScreenShare)
			} else {
				denyInChannel(t, l.e, l.ch, l.owner, 0)
			}
			_ = l.sync(t)
		}
	}()
	wg.Wait()
	if v := l.violation(); v != "" {
		breaches = append(breaches, v)
	}
	if len(breaches) > 0 {
		t.Fatalf("%d breaches of the lease invariant, first: %s", len(breaches), breaches[0])
	}
}
