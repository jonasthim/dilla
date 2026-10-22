//go:build linux

package main

import (
	"context"
	"errors"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/bot/service"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type nativeInteractionSnapshots struct {
	native       *native.Client
	session      *client.Session
	installation id.ID
}

func (p nativeInteractionSnapshots) InteractionSnapshot(ctx context.Context, event native.GroupEvent) (native.InteractionGroupExpected, []byte, error) {
	var expected native.InteractionGroupExpected
	if p.native == nil || p.session == nil || p.installation.IsZero() || event.Body == nil {
		return expected, nil, errors.New("missing interaction snapshot dependency")
	}
	request, err := protocol.DecodeRequest(*event.Body)
	if err != nil {
		return expected, nil, err
	}
	wire, err := p.session.BotInteractionContextSnapshot(ctx, p.installation, request.RequestID, event.Group, event.SenderUser, event.SenderDevice)
	if err != nil {
		return expected, nil, err
	}
	var envelope []any
	if cborx.Unmarshal(wire, &envelope) != nil || len(envelope) != 2 {
		return expected, nil, errors.New("invalid signed interaction context envelope")
	}
	payload, ok := envelope[0].([]byte)
	if !ok || len(payload) == 0 {
		return expected, nil, errors.New("invalid signed interaction context payload")
	}
	var fields []any
	if cborx.Unmarshal(payload, &fields) != nil || len(fields) != 18 {
		return expected, nil, errors.New("invalid signed interaction context fields")
	}
	identity, err := p.native.Identity(ctx)
	if err != nil || identity.User == nil || identity.Device == nil || identity.Instance == nil {
		return expected, nil, errors.New("native bot identity is unavailable")
	}
	binding, ok := fields[7].([]any)
	if !ok || len(binding) != 9 {
		return expected, nil, errors.New("invalid signed interaction binding")
	}
	minimumRevision, revOK := fields[12].(uint64)
	serverNow, nowOK := fields[4].(uint64)
	policyVersion, policyOK := fields[13].(uint64)
	instance, instanceOK := interactionSnapshotID(fields[1])
	botUser, userOK := interactionSnapshotID(binding[3])
	community, communityOK := interactionSnapshotID(binding[2])
	participant, participantOK := interactionSnapshotID(binding[4])
	participantDevice, deviceOK := interactionSnapshotID(binding[5])
	if !revOK || !nowOK || !policyOK || !instanceOK || !userOK || !communityOK || !participantOK || !deviceOK ||
		instance != p.native.Binding().Instance || botUser != *identity.User || community != event.Community ||
		participant != event.SenderUser || participantDevice != event.SenderDevice {
		return expected, nil, errors.New("signed interaction context does not match native event")
	}
	expected = native.InteractionGroupExpected{Instance: instance, Installation: p.installation, Community: community,
		BotUser: botUser, BotDevice: *identity.Device, ParticipantUser: participant, ParticipantDevice: participantDevice,
		Group: event.Group, MinimumEligibilityRevision: minimumRevision, ServerNow: serverNow, PolicyVersion: policyVersion}
	return expected, wire, nil
}

func interactionSnapshotID(value any) (id.ID, bool) {
	var out id.ID
	raw, ok := value.([]byte)
	if !ok || len(raw) != len(out) {
		return out, false
	}
	copy(out[:], raw)
	return out, true
}

type durableInteractionResponseSender struct {
	api    *client.Client
	outbox *service.InteractionResponseOutbox
}

func (s durableInteractionResponseSender) ResumeInteractionResponse(ctx context.Context, event native.GroupEvent) (bool, error) {
	if s.outbox == nil {
		return false, errors.New("missing interaction response outbox")
	}
	receipt, found, err := s.outbox.Resume(ctx, event)
	if err != nil || !found {
		return false, err
	}
	if receipt.Outcome != protocol.ReceiptAccepted {
		return false, errInteractionResponseNotAccepted
	}
	return true, nil
}

func (s durableInteractionResponseSender) SendInteractionResponse(ctx context.Context, event native.GroupEvent, response string) (bool, error) {
	if s.api == nil || s.outbox == nil || response == "" {
		return false, errors.New("missing interaction response sender dependency")
	}
	discovery, _, err := s.api.DiscoverObserved(ctx)
	if err != nil {
		return false, err
	}
	receipt, err := s.outbox.Send(ctx, event, []byte(response), id.New(), id.New(), uint64(time.Now().Unix()), discovery.Generation)
	if err != nil {
		return false, err
	}
	if receipt.Outcome != protocol.ReceiptAccepted {
		return false, errInteractionResponseNotAccepted
	}
	return true, nil
}
