package mlswasi

import (
	"bytes"
	"context"
	"encoding/binary"
	"testing"
)

func TestExtractAuthenticatedRosterReturnsVerifiedDescriptors(t *testing.T) {
	f := loadDS1500(t)
	r := newTestRuntime(t, Options{CacheDir: sharedCacheDir(t), PoolSize: 1})
	ctx := context.Background()
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Release()
	got, err := inst.ExtractAuthenticatedRoster(ctx, f.ratchetTree, f.groupInfo)
	if err != nil {
		t.Fatalf("ExtractAuthenticatedRoster: %v", err)
	}
	if len(got) != f.manifest.Leaves || len(got) != 1500 {
		t.Fatalf("roster leaves = %d, want %d", len(got), f.manifest.Leaves)
	}
	group, err := inst.PublicGroupFromExternal(ctx, f.ratchetTree, f.groupInfo)
	if err != nil {
		t.Fatalf("PublicGroupFromExternal: %v", err)
	}
	defer group.Close(ctx)
	state, err := group.State(ctx)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if len(state.Members) != len(got) {
		t.Fatalf("state members = %d, roster leaves = %d", len(state.Members), len(got))
	}
	first := got[0]
	firstCredential, err := inst.VerifyCredential(ctx, state.Members[0].CredentialIdentity, state.Members[0].SignatureKey)
	if err != nil {
		t.Fatalf("verify fixture leaf 0 credential: %v", err)
	}
	seed := uint64(0x5eed)
	wantDevice := make([]byte, 16)
	binary.BigEndian.PutUint64(wantDevice[:8], seed)
	binary.BigEndian.PutUint64(wantDevice[8:], seed*0x9e3779b9)
	if !bytes.Equal(first.UserID, bytes.Repeat([]byte{1}, 16)) ||
		!bytes.Equal(first.DeviceID, wantDevice) ||
		!bytes.Equal(first.DSKPub, state.Members[0].SignatureKey) ||
		!bytes.Equal(first.UserID, firstCredential.UserID[:]) ||
		!bytes.Equal(first.DeviceID, firstCredential.DeviceID[:]) ||
		first.Tier != firstCredential.Tier || first.Kind != firstCredential.Kind ||
		first.Tier != 0 || first.Kind != 0 {
		t.Fatalf("fixture leaf 0 descriptor = %+v, verified credential %+v, want creator's user/device and native user values", first, firstCredential)
	}
	for n, leaf := range got {
		if len(leaf.UserID) != 16 || len(leaf.DeviceID) != 16 || len(leaf.DSKPub) != 32 || leaf.Tier > 1 || leaf.Kind > 1 {
			t.Fatalf("leaf %d has invalid descriptor: %+v", n, leaf)
		}
	}

	tampered := append([]byte(nil), f.groupInfo...)
	tampered[len(tampered)-1] ^= 1
	if _, err := inst.ExtractAuthenticatedRoster(ctx, f.ratchetTree, tampered); err == nil {
		t.Fatal("tampered GroupInfo produced a roster")
	}
}

func TestExtractAuthenticatedRosterRejectsOversizedInputsBeforeWasm(t *testing.T) {
	r := newTestRuntime(t, Options{CacheDir: sharedCacheDir(t), PoolSize: 1})
	ctx := context.Background()
	inst, err := r.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer inst.Release()
	if _, err := inst.ExtractAuthenticatedRoster(ctx, make([]byte, 4*1024*1024+1), []byte{1}); err == nil {
		t.Fatal("oversized tree was accepted")
	}
	if _, err := inst.ExtractAuthenticatedRoster(ctx, []byte{1}, make([]byte, 64*1024+1)); err == nil {
		t.Fatal("oversized GroupInfo was accepted")
	}
}
