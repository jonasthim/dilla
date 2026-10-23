package service

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
)

func TestWelcomePreviewRequiresCurrentManagerAndOnlyRendersText(t *testing.T) {
	h, auth := announcementInteractionsFixture(t)
	preview := WelcomeInteractions{Authority: auth, CommunityID: h.CommunityID}
	actor := InteractionActor{User: interactionID(6)}
	request := protocol.Request{RequestID: interactionID(30), CommunityID: h.CommunityID, Operation: protocol.OpWelcomePreview, Args: []any{"Hi {member} from {server} in {channel}"}}
	result, err := preview.Handlers()[protocol.OpWelcomePreview].Handle(context.Background(), actor, request)
	if err != nil || result.Status != 0 || auth.user != actor.User {
		t.Fatalf("preview result=%+v auth=%v err=%v", result, auth.user, err)
	}
	var fields []any
	if err := cborx.Unmarshal(result.Data, &fields); err != nil || len(fields) != 2 || fields[0] != uint64(1) || fields[1] != "Hi member from server in channel" {
		t.Fatalf("preview data=%x fields=%#v err=%v", result.Data, fields, err)
	}
	auth.allowed = false
	result, err = preview.Handlers()[protocol.OpWelcomePreview].Handle(context.Background(), actor, request)
	if err != nil || result.Status != interactionStatusForbidden || len(result.Data) != 0 {
		t.Fatalf("revoked preview result=%+v err=%v", result, err)
	}
	request.CommunityID = interactionID(99)
	result, err = preview.Handlers()[protocol.OpWelcomePreview].Handle(context.Background(), actor, request)
	if err != nil || result.Status != interactionStatusForbidden || len(result.Data) != 0 {
		t.Fatalf("foreign preview result=%+v err=%v", result, err)
	}
}
