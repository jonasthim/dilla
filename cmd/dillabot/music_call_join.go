//go:build linux

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	maxMusicCallJoinLeaves = 1024
	maxMusicCallJoinBytes  = 4 << 20
)

// ensureMusicCallGroupJoined performs the same security sequence as the browser call join:
// stage an external join, refresh signed device-list pins, gate the staged call epoch, post the
// exact commit, and resolve the helper intent from the accepted resync sequence.
func ensureMusicCallGroupJoined(ctx context.Context, calls *client.Session, core *native.Client, installation, community, channel id.ID, policy uint64) error {
	if ctx == nil || calls == nil || core == nil || installation.IsZero() || community.IsZero() || channel.IsZero() || policy == 0 {
		return errors.New("music call-group join dependencies unavailable")
	}
	call, err := calls.ChannelCall(ctx, channel)
	if err != nil {
		return err
	}
	if call.CallID == nil || call.GroupID == nil || *call.CallID != channel || call.GroupID.IsZero() {
		return errors.New("music channel has no active call group")
	}
	group := *call.GroupID
	groups, err := core.Groups(ctx)
	if err != nil {
		return err
	}
	var localJoinEpoch uint64
	for _, existing := range groups {
		if existing.ID != group {
			continue
		}
		if existing.State == 4 {
			if err = core.CallGroupForget(ctx, group); err != nil {
				return err
			}
			continue
		}
		if existing.State == 2 {
			_, err = core.CallMediaEpoch(ctx, channel)
			return err
		}
		if existing.State != 1 {
			return errors.New("music call-group state is not joinable")
		}
		localJoinEpoch = existing.Epoch
	}
	info, err := calls.GroupInfo(ctx, group)
	if err != nil {
		return err
	}
	baseEpoch := info.Epoch
	if localJoinEpoch > 0 {
		baseEpoch = localJoinEpoch - 1
	}
	operation := musicCallJoinOperation(installation, group, baseEpoch)

	intent, err := core.GroupIntentResult(ctx, operation)
	if err != nil {
		return err
	}
	var joined native.GroupExternalJoinResult
	if intent != nil {
		if intent.Kind != 5 || intent.Group != group || intent.State != 0 || len(intent.Result) == 0 {
			return errors.New("music call-group join intent is not resumable")
		}
		joined, err = decodeMusicExternalJoinResult(intent.Result)
		if err != nil {
			return err
		}
	} else {
		tree, treeErr := calls.GroupTree(ctx, group)
		if treeErr != nil {
			return treeErr
		}
		if info.Epoch != tree.Epoch || !bytes.Equal(info.TreeHash, tree.TreeHash) {
			return errors.New("music call-group snapshot changed during join")
		}
		infoBody, encodeErr := cborx.Marshal([]any{info.Epoch, info.Info, info.TreeHash, info.NextSequence})
		if encodeErr != nil {
			return client.ErrProtocol
		}
		treeBody, encodeErr := cborx.Marshal([]any{tree.Epoch, tree.Tree, tree.TreeHash})
		if encodeErr != nil {
			return client.ErrProtocol
		}
		joined, err = core.ExternalJoin(ctx, operation, group, channel, 1, policy, infoBody, treeBody)
		if err != nil {
			return err
		}
	}
	if err = refreshMusicCallJoinLeaves(ctx, calls, core, group); err != nil {
		return err
	}
	if err = core.CallJoinCheck(ctx, channel); err != nil {
		return err
	}
	accepted, err := calls.Resync(ctx, group, joined.Commit, joined.GroupInfo)
	if err != nil {
		var apiErr *client.APIError
		if errors.As(err, &apiErr) && apiErr.Outcome == client.OutcomeDefinitive {
			if discardErr := core.DiscardGroup(ctx, operation, group); discardErr != nil {
				return errors.Join(err, discardErr)
			}
			return err
		}
		// A lost response is resolved only when the exact staged GroupInfo is now current.
		current, readErr := calls.GroupInfo(ctx, group)
		if readErr != nil || current.NextSequence == 0 || !bytes.Equal(current.Info, joined.GroupInfo) {
			return err
		}
		accepted.Sequence = current.NextSequence - 1
	}
	if accepted.Sequence == 0 || accepted.Sequence > math.MaxInt64 {
		return errors.New("music call-group resync returned an invalid sequence")
	}
	if err = core.GroupJoined(ctx, operation, group, accepted.Sequence); err != nil {
		return err
	}
	if _, err = core.CallMediaEpoch(ctx, channel); err != nil {
		return err
	}
	return nil
}

func musicCallJoinOperation(installation, group id.ID, epoch uint64) id.ID {
	input := append([]byte("dilla.bot.music-call-join.v1\x00"), installation[:]...)
	input = append(input, group[:]...)
	var encodedEpoch [8]byte
	for i := range encodedEpoch {
		encodedEpoch[len(encodedEpoch)-1-i] = byte(epoch >> (8 * i))
	}
	input = append(input, encodedEpoch[:]...)
	digest := sha256.Sum256(input)
	var operation id.ID
	copy(operation[:], digest[:len(operation)])
	return operation
}

func decodeMusicExternalJoinResult(body []byte) (native.GroupExternalJoinResult, error) {
	var row []any
	if len(body) == 0 || cborx.Unmarshal(body, &row) != nil || len(row) != 2 {
		return native.GroupExternalJoinResult{}, client.ErrProtocol
	}
	commit, ok := row[0].([]byte)
	if !ok || len(commit) == 0 {
		return native.GroupExternalJoinResult{}, client.ErrProtocol
	}
	info, ok := row[1].([]byte)
	if !ok || len(info) == 0 {
		return native.GroupExternalJoinResult{}, client.ErrProtocol
	}
	return native.GroupExternalJoinResult{Commit: append([]byte(nil), commit...), GroupInfo: append([]byte(nil), info...)}, nil
}

func refreshMusicCallJoinLeaves(ctx context.Context, calls *client.Session, core *native.Client, group id.ID) error {
	leaves, err := core.PendingLeaves(ctx)
	if err != nil {
		return err
	}
	var pending []native.GroupPendingLeaf
	for _, leaf := range leaves {
		if leaf.Group == group {
			pending = append(pending, leaf)
		}
	}
	if len(pending) > maxMusicCallJoinLeaves {
		return errors.New("music call-group trust refresh exceeds limit")
	}
	for _, leaf := range pending {
		history, head, err := musicDeviceListHistory(ctx, calls, leaf.User, leaf.CachedVersion)
		if err != nil {
			return err
		}
		now := time.Now().Unix()
		if now < 0 {
			return errors.New("music call-group trust refresh clock is invalid")
		}
		if _, err = core.TrustSender(ctx, group, uint64(leaf.Leaf), leaf.User, history, head, uint64(now)); err != nil {
			return err
		}
	}
	return nil
}

func musicDeviceListHistory(ctx context.Context, calls *client.Session, user id.ID, cachedVersion uint64) ([]byte, []byte, error) {
	const maxVersions = 1024
	headRaw, err := calls.OwnDeviceList(ctx, user)
	if err != nil {
		return nil, nil, err
	}
	var head []any
	if cborx.Unmarshal(headRaw, &head) != nil || len(head) != 4 {
		return nil, nil, client.ErrProtocol
	}
	version, ok := head[0].(uint64)
	if !ok || version == 0 || version < cachedVersion {
		return nil, nil, client.ErrProtocol
	}
	headList, ok := head[1].([]byte)
	if !ok || len(headList) == 0 {
		return nil, nil, client.ErrProtocol
	}
	rows := make([]any, 0, min(maxVersions, int(version-cachedVersion+1)))
	after := cachedVersion
	if cachedVersion > 0 {
		after = cachedVersion - 1
	}
	for after < version {
		page, pageErr := calls.DeviceListHistory(ctx, user, after)
		if pageErr != nil || len(page) == 0 {
			return nil, nil, client.ErrProtocol
		}
		for _, row := range page {
			rowVersion, valid := row[0].(uint64)
			if !valid || rowVersion != after+1 || rowVersion > version || len(rows) >= maxVersions {
				return nil, nil, client.ErrProtocol
			}
			rows = append(rows, row)
			after = rowVersion
			if after == version {
				break
			}
		}
	}
	if len(rows) == 0 || version-cachedVersion+1 > maxVersions {
		return nil, nil, client.ErrProtocol
	}
	last, err := cborx.Marshal(rows[len(rows)-1])
	if err != nil || !bytes.Equal(last, headRaw) {
		return nil, nil, client.ErrProtocol
	}
	history, err := cborx.Marshal(rows)
	if err != nil || len(history) > maxMusicCallJoinBytes {
		return nil, nil, client.ErrProtocol
	}
	return history, headList, nil
}
