package api_test

import (
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
)

// fakeRelay records the relay revocations the call routes make.
type fakeRelay struct {
	mu      sync.Mutex
	revoked []id.ID
	minted  []id.ID
}

func (f *fakeRelay) Revoke(device id.ID, _ time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, device)
}

func (f *fakeRelay) Minted(device id.ID, _ time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.minted = append(f.minted, device)
}

func (f *fakeRelay) has(device id.ID) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.revoked, device)
}

// waitRevoked waits up to two seconds for device's relay revocation.
func waitRevoked(f *fakeRelay, device id.ID) bool {
	deadline := time.Now().Add(2 * time.Second)
	for !f.has(device) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(5 * time.Millisecond)
	}
	return true
}

// Review I1: CutDevice (the in-process revocation, quarantine and logout paths) revokes the
// device's relay credentials synchronously, before anything else — also on an instance with no
// SFU, where the call cut itself returns early.
func TestCutDeviceRevokesTheRelayAtOnce(t *testing.T) {
	b := newBarredEnv(t)
	relay := &fakeRelay{}
	b.calls.WithRelay(relay)
	b.calls.CutDevice(t.Context(), b.memberDev) // no retry loop runs: only the synchronous part
	if !relay.has(b.memberDev) {
		t.Fatal("CutDevice did not revoke the device's relay credentials synchronously")
	}

	e := newEnv(t)
	noSFU := api.NewCalls(e.Repo, api.NewResolver(e.Repo), nil, api.CallsConfig{}, e.Clk, slog.New(slog.DiscardHandler))
	relay2 := &fakeRelay{}
	noSFU.WithRelay(relay2)
	dev := id.New()
	noSFU.CutDevice(t.Context(), dev)
	if !relay2.has(dev) {
		t.Fatal("CutDevice on an instance with no SFU did not revoke the relay")
	}
}

// Review I1: CutUser revokes the relay of every device of the user, resolved on the retry loop.
func TestCutUserRevokesTheRelayOfEveryDevice(t *testing.T) {
	b := newBarredEnv(t)
	relay := &fakeRelay{}
	b.calls.WithRelay(relay)
	stop := b.calls.StartRetries(time.Hour)
	defer stop()
	if err := b.e.Repo.SetUserDisabled(t.Context(), b.member, ptr(b.e.Clk.Now().Unix())); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
	b.calls.CutUser(t.Context(), b.member)
	if !waitRevoked(relay, b.memberDev) {
		t.Fatal("CutUser did not revoke the relay of the user's device")
	}
	if relay.has(b.ownerDev) {
		t.Fatal("CutUser revoked another user's device")
	}
}

// Review I1: the room sweep revokes the relay of a barred device it removes (a change another
// process wrote), and of no one else.
func TestTheRoomSweepRevokesABarredDevicesRelay(t *testing.T) {
	b := newBarredEnv(t)
	relay := &fakeRelay{}
	b.calls.WithRelay(relay)
	if err := b.e.Repo.RevokeDevice(t.Context(), b.memberDev, b.e.Clk.Now().Unix()); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	b.calls.SweepRooms(t.Context())
	if !relay.has(b.memberDev) {
		t.Fatal("the sweep did not revoke the barred device's relay")
	}
	if relay.has(b.ownerDev) {
		t.Fatal("the sweep revoked the relay of a device that is not barred")
	}
}

// Commit review, revocation parity: every cut from a call room also cuts the device from the relay
// — not only a barred one. A device that lost view_channel (a kick's effect on the channel), lost
// connect, or whose leaf the call group removed is revoked when the sweep removes it, and an
// eviction by the delivery service revokes at once; a device left in the room is not. (What a cut
// means for credentials — the old one refused, one issued after it admitted — is the relay's:
// internal/server TestARevokedCredentialIsRefusedOnEveryMethod and TestRevokingADeviceClosesItsRelay.)
func TestEveryCutFromACallRoomRevokesTheRelay(t *testing.T) {
	for name, cut := range map[string]func(t *testing.T, e *env, ch, group, member, memberDev id.ID){
		"lost view_channel": func(t *testing.T, e *env, ch, _, member, _ id.ID) {
			denyInChannel(t, e, ch, member, api.PermViewChannel)
		},
		"lost connect": func(t *testing.T, e *env, ch, _, member, _ id.ID) {
			denyInChannel(t, e, ch, member, api.PermConnect)
		},
		"leaf removed": func(t *testing.T, e *env, _, group, _, memberDev id.ID) {
			dropLeaf(t, e, group, memberDev)
		},
	} {
		t.Run(name, func(t *testing.T) {
			e, ch, tok, group, stub, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL})
			owner := deviceOf(t, e, tok)
			seedLeaf(t, e, group, owner, 3, nil)
			if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status != http.StatusCreated {
				t.Fatalf("start = %d", status)
			}
			member, memberDev, _ := joinedMember(t, e, ch, group, "member")
			room := stub.minted()[0][0]
			stub.setPresent(room, &livekit.ParticipantInfo{Identity: owner.String()},
				&livekit.ParticipantInfo{Identity: memberDev.String()})
			relay := &fakeRelay{}
			calls.WithRelay(relay)
			cut(t, e, ch, group, member, memberDev)
			calls.SweepRooms(t.Context())
			if !removedDevice(stub, room, memberDev) {
				t.Fatal("the sweep did not cut the device from the room")
			}
			if !relay.has(memberDev) {
				t.Fatal("the device was cut from the room but kept the relay")
			}
			if relay.has(owner) {
				t.Fatal("a device left in the room lost the relay")
			}
		})
	}
	t.Run("evicted by the delivery service", func(t *testing.T) {
		f := newEventsFixture(t, api.CallsConfig{})
		relay := &fakeRelay{}
		f.calls.WithRelay(relay)
		f.events.Evict(t.Context(), f.group, []id.ID{f.dev})
		if !relay.has(f.dev) {
			t.Fatal("an evicted device kept the relay")
		}
	})
}

// Commit review (cut-map amplification): a start that mints a relay credential tells the relay,
// which records cuts only for devices that can hold one.
func TestAStartTellsTheRelayItMintedACredential(t *testing.T) {
	e, ch, tok, group, _, calls := callEnvCalls(t, api.CallsConfig{LiveKitURL: testLiveKitURL,
		TURNSecret: "0123456789abcdef", TURNURLs: []string{"turns:chat.example.test:443?transport=tcp"}, CredentialTTL: time.Hour})
	relay := &fakeRelay{}
	calls.WithRelay(relay)
	dev := deviceOf(t, e, tok)
	seedLeaf(t, e, group, dev, 3, nil)
	if status, _ := e.Do(http.MethodPost, "/v1/channels/"+ch.String()+"/calls", tok, []any{}); status != http.StatusCreated {
		t.Fatalf("start = %d", status)
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if !slices.Equal(relay.minted, []id.ID{dev}) {
		t.Fatalf("minted = %v, want the starting device %s", relay.minted, dev)
	}
}

// BarredDevices is the relay's store lookup: barred as the call routes say; an id with no device
// row (doctor's probe: rows are never deleted) is not.
func TestBarredDevicesAnswersAsTheCallRoutes(t *testing.T) {
	b := newBarredEnv(t)
	look := api.BarredDevices{Repo: b.e.Repo}
	if bar, err := look.DeviceBarred(t.Context(), b.memberDev); err != nil || bar {
		t.Fatalf("a device in good standing = %v, %v", bar, err)
	}
	if bar, err := look.DeviceBarred(t.Context(), id.New()); err != nil || bar {
		t.Fatalf("an id with no device row = %v, %v; want not barred", bar, err)
	}
	if err := b.e.Repo.SetUserDisabled(t.Context(), b.member, ptr(b.e.Clk.Now().Unix())); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
	if bar, err := look.DeviceBarred(t.Context(), b.memberDev); err != nil || !bar {
		t.Fatalf("a disabled user's device = %v, %v; want barred", bar, err)
	}
	if err := b.e.Repo.SetUserDisabled(t.Context(), b.member, nil); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
	if err := b.e.Repo.QuarantineDevice(t.Context(), b.memberDev, b.e.Clk.Now().Unix(), "fork quorum"); err != nil {
		t.Fatalf("QuarantineDevice: %v", err)
	}
	if bar, err := look.DeviceBarred(t.Context(), b.memberDev); err != nil || !bar {
		t.Fatalf("a quarantined device = %v, %v; want barred", bar, err)
	}
}
