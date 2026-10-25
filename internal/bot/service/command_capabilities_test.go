package service

import (
	"bytes"
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type commandCapabilitiesAuthorityFake struct {
	result  client.ActorAuthority
	present bool
	calls   int
	actor   id.ID
}

func (f *commandCapabilitiesAuthorityFake) BotActorAuthority(_ context.Context, community, actor id.ID) (client.ActorAuthority, bool, error) {
	f.calls++
	f.actor = actor
	return f.result, f.present, nil
}

func TestCommandCapabilitiesAllowsMemberSafeDiscoveryAndPreservesManagerGate(t *testing.T) {
	community, installation, bot, actor := interactionID(2), interactionID(3), interactionID(4), interactionID(6)
	authority := &commandCapabilitiesAuthorityFake{present: true}
	h := CommandCapabilitiesInteractions{Authority: authority, CommunityID: community, InstallationID: installation, BotUserID: bot,
		Capabilities: 0xff, Supported: []protocol.Operation{protocol.OpReminderList, protocol.OpMusicSearch, protocol.OpCapabilities,
			protocol.OpPollVote, protocol.OpPollClose, protocol.OpOverviewGet, protocol.OpPollCreate, protocol.OpPollVote, 999}}
	handler := h.Handlers()[protocol.OpCapabilities].Handle
	result, err := handler(context.Background(), InteractionActor{User: actor, Kind: 0}, protocol.Request{CommunityID: community, Operation: protocol.OpCapabilities})
	if err != nil || result.Status != 0 {
		t.Fatalf("member capabilities = %+v, %v; want success", result, err)
	}
	var data []any
	if err := cborx.Unmarshal(result.Data, &data); err != nil || len(data) != 5 || len(result.Data) > commandCapabilitiesDataLimit {
		t.Fatalf("capabilities = %x, decoded=%#v, err=%v", result.Data, data, err)
	}
	installBytes, installOK := data[1].([]byte)
	botBytes, botOK := data[2].([]byte)
	operations, operationsOK := data[4].([]any)
	if data[0] != uint64(1) || !installOK || !bytes.Equal(installBytes, installation[:]) || !botOK || !bytes.Equal(botBytes, bot[:]) || data[3] != uint64(1) || !operationsOK {
		t.Fatalf("capabilities tuple = %#v", data)
	}
	want := []uint64{3, 70, 73, 81}
	if len(operations) != len(want) {
		t.Fatalf("ordinary member operations = %#v, want %#v", operations, want)
	}
	for i := range want {
		if operations[i] != want[i] {
			t.Fatalf("ordinary member operations = %#v, want %#v", operations, want)
		}
	}
	if authority.calls != 1 || authority.actor != actor {
		t.Fatalf("authority calls=%d actor=%s, want one fresh lookup for sender %s", authority.calls, authority.actor, actor)
	}

	// Op 0 remains manager-only even though capability discovery itself is
	// member-safe. A delegated manager gets it through the current server bits.
	h.Supported = []protocol.Operation{protocol.OpOverviewGet, protocol.OpCapabilities}
	h.Authority = &commandCapabilitiesAuthorityFake{result: client.ActorAuthority{EffectiveBits: manageCommunityBit}, present: true}
	result, err = h.Handlers()[protocol.OpCapabilities].Handle(context.Background(), InteractionActor{User: actor}, protocol.Request{CommunityID: community, Operation: protocol.OpCapabilities})
	if err != nil || result.Status != 0 || cborx.Unmarshal(result.Data, &data) != nil || len(data[4].([]any)) != 2 {
		t.Fatalf("manager capability tuple=%#v err=%v", data, err)
	}

	h.Authority = &commandCapabilitiesAuthorityFake{present: false}
	result, err = h.Handlers()[protocol.OpCapabilities].Handle(context.Background(), InteractionActor{User: actor}, protocol.Request{CommunityID: community, Operation: protocol.OpCapabilities})
	if err != nil || result.Status != interactionStatusForbidden || len(result.Data) != 0 {
		t.Fatalf("nonmember capabilities = %+v, %v; want forbidden", result, err)
	}
}

func TestCommandCapabilitiesRejectsForeignCommunityAndBotActor(t *testing.T) {
	authority := &commandCapabilitiesAuthorityFake{present: true}
	community := interactionID(2)
	h := CommandCapabilitiesInteractions{Authority: authority, CommunityID: community, InstallationID: interactionID(3), BotUserID: interactionID(4), Supported: []protocol.Operation{protocol.OpCapabilities}}
	handler := h.Handlers()[protocol.OpCapabilities].Handle
	if _, err := handler(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{CommunityID: interactionID(90), Operation: protocol.OpCapabilities}); err == nil || authority.calls != 0 {
		t.Fatalf("foreign community err=%v calls=%d, want refusal before lookup", err, authority.calls)
	}
	if _, err := handler(context.Background(), InteractionActor{User: interactionID(6), Kind: 1}, protocol.Request{CommunityID: community, Operation: protocol.OpCapabilities}); err == nil || authority.calls != 0 {
		t.Fatalf("bot actor err=%v calls=%d, want refusal before lookup", err, authority.calls)
	}
}

func TestCommandOperationAllowedUsesInstallationCapabilitiesAndActorPermissions(t *testing.T) {
	actor := client.ActorAuthority{EffectiveBits: commandPermConnect}
	if commandOperationAllowed(protocol.OpMusicSearch, 0, actor) {
		t.Fatal("music operation exposed without approved installation capability")
	}
	if commandOperationAllowed(protocol.OpMusicSearch, commandCapMusic, client.ActorAuthority{}) {
		t.Fatal("music operation exposed without current actor permission")
	}
	if !commandOperationAllowed(protocol.OpMusicSearch, commandCapMusic, actor) {
		t.Fatal("music operation hidden with current actor permission and approved capability")
	}
	if commandOperationAllowed(commandOpMusicProvidersStatus, commandCapMusic, client.ActorAuthority{}) {
		t.Fatal("music provider status exposed without current manager permission")
	}
	if !commandOperationAllowed(commandOpMusicProvidersStatus, commandCapMusic, client.ActorAuthority{EffectiveBits: manageCommunityBit}) {
		t.Fatal("music provider status hidden from a current manager with approved music capability")
	}
}
