//go:build linux

package main

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type musicCallMembershipReaderFake struct{ err error }

func (f musicCallMembershipReaderFake) GroupPage(context.Context, id.ID, string, uint64, uint64) (client.Page, error) {
	return client.Page{}, f.err
}

type musicCallMembershipForgetterFake struct {
	calls  int
	groups []id.ID
	err    error
}

func (f *musicCallMembershipForgetterFake) CallGroupForget(_ context.Context, group id.ID) error {
	f.calls++
	f.groups = append(f.groups, group)
	return f.err
}

func TestMusicCallResumeForgetsOnlyDefinitivelyRemovedLeaf(t *testing.T) {
	group := id.New()
	t.Run("current member keeps local keys", func(t *testing.T) {
		forgetter := &musicCallMembershipForgetterFake{}
		current, err := prepareMusicCallGroupMembership(context.Background(), musicCallMembershipReaderFake{}, forgetter, group)
		if err != nil || !current || forgetter.calls != 0 {
			t.Fatalf("current=%v forgets=%d err=%v", current, forgetter.calls, err)
		}
	})
	t.Run("removed leaf discards stale keys before rejoin", func(t *testing.T) {
		forgetter := &musicCallMembershipForgetterFake{}
		reader := musicCallMembershipReaderFake{err: &client.APIError{Status: 404, Code: "E_NOT_FOUND"}}
		current, err := prepareMusicCallGroupMembership(context.Background(), reader, forgetter, group)
		if err != nil || current || forgetter.calls != 1 {
			t.Fatalf("current=%v forgets=%d err=%v", current, forgetter.calls, err)
		}
	})
	t.Run("transient or pruned errors never trigger forget", func(t *testing.T) {
		for _, probeErr := range []error{
			&client.APIError{Status: 503, Code: "E_UNAVAILABLE"},
			&client.APIError{Status: 410, Code: "E_PRUNED"},
		} {
			forgetter := &musicCallMembershipForgetterFake{}
			current, err := prepareMusicCallGroupMembership(context.Background(), musicCallMembershipReaderFake{err: probeErr}, forgetter, group)
			var apiErr *client.APIError
			_ = errors.As(probeErr, &apiErr)
			wantCurrent := apiErr != nil && apiErr.Code == "E_PRUNED"
			wantErr := !wantCurrent
			if (err != nil) != wantErr || current != wantCurrent || forgetter.calls != 0 {
				t.Fatalf("probe=%v current=%v forgets=%d err=%v", probeErr, current, forgetter.calls, err)
			}
		}
	})
}

func TestMusicCallJoinForgetsSupersededGroupForSameChannel(t *testing.T) {
	community, channel, current, old := id.New(), id.New(), id.New(), id.New()
	otherCommunity, otherChannel := id.New(), id.New()
	groups := []native.GroupInfo{
		{ID: old, Kind: 1, Community: &community, Target: channel, State: 2},
		{ID: current, Kind: 1, Community: &community, Target: channel, State: 2},
		{ID: id.New(), Kind: 1, Community: &community, Target: otherChannel, State: 2},
		{ID: id.New(), Kind: 1, Community: &otherCommunity, Target: channel, State: 2},
		{ID: id.New(), Kind: 0, Community: &community, Target: channel, State: 2},
		{ID: id.New(), Kind: 3, Community: &community, Target: channel, State: 2},
		{ID: id.New(), Kind: 1, Community: &community, Target: channel, State: 4},
	}
	f := &musicCallMembershipForgetterFake{}
	if err := forgetSupersededMusicCallGroups(context.Background(), f, groups, community, channel, current); err != nil {
		t.Fatal(err)
	}
	if len(f.groups) != 1 || f.groups[0] != old {
		t.Fatalf("forgot groups %v, want only superseded call %v", f.groups, old)
	}
	f.err = errors.New("storage unavailable")
	if err := forgetSupersededMusicCallGroups(context.Background(), f, groups, community, channel, current); !errors.Is(err, f.err) {
		t.Fatalf("forget failure ignored: %v", err)
	}
}
