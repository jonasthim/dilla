package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/announcements"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type announcementInteractionNative struct {
	binding native.Binding
	value   native.StateValue
}

func (n *announcementInteractionNative) Binding() native.Binding { return n.binding }
func (n *announcementInteractionNative) StateGet(context.Context, uint64, []byte) (native.StateValue, error) {
	return n.value, nil
}
func (n *announcementInteractionNative) StateTransaction(_ context.Context, _ id.ID, changes []native.StateChange) ([]uint64, error) {
	if len(changes) != 1 || changes[0].ExpectedRevision != n.value.Revision {
		return nil, errors.New("state revision conflict")
	}
	n.value.Revision++
	n.value.Value = append([]byte(nil), changes[0].Value...)
	return []uint64{n.value.Revision}, nil
}

type announcementInteractionAuth struct {
	revision uint64
	allowed  bool
	user     id.ID
}

func (a *announcementInteractionAuth) CurrentRevision(context.Context, id.ID) (uint64, error) {
	return a.revision, nil
}
func (a *announcementInteractionAuth) CanManageCommunity(_ context.Context, user, community id.ID) (bool, error) {
	a.user = user
	return a.allowed && !user.IsZero() && !community.IsZero(), nil
}

type announcementInteractionDestination struct{}

func (announcementInteractionDestination) ResolveTextGroup(context.Context, id.ID, id.ID) (id.ID, error) {
	return interactionID(44), nil
}

type announcementInteractionPostAuth bool

func (a announcementInteractionPostAuth) CanAnnounce(context.Context, id.ID) (bool, error) {
	return bool(a), nil
}

type announcementInteractionSender struct{}

func (announcementInteractionSender) SendAnnouncement(context.Context, announcements.SendRequest) (protocol.SendReceipt, error) {
	return protocol.SendReceipt{}, nil
}
func (announcementInteractionSender) LookupAnnouncement(context.Context, announcements.SendRequest) (protocol.SendReceipt, bool, error) {
	return protocol.SendReceipt{}, false, nil
}

func announcementInteractionsFixture(t *testing.T) (AnnouncementInteractions, *announcementInteractionAuth) {
	t.Helper()
	community := interactionID(2)
	n := &announcementInteractionNative{binding: native.Binding{Instance: interactionID(1), Community: community, Installation: interactionID(3)}}
	scheduler, err := announcements.NewScheduler(n, announcements.SchedulerOptions{
		Destination: announcementInteractionDestination{}, Authorization: announcementInteractionPostAuth(true),
		Sender: announcementInteractionSender{}, ReceiptLookup: announcementInteractionSender{},
		Now: func() time.Time { return time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	auth := &announcementInteractionAuth{revision: 7, allowed: true}
	return AnnouncementInteractions{Scheduler: scheduler, Authority: auth, CommunityID: community}, auth
}

func announcementPayload(t *testing.T, announcementID id.ID, text string, revision uint64) []byte {
	t.Helper()
	b, err := cborx.Marshal([]any{uint64(1), announcementID, interactionID(21), text, "daily", "UTC", "", uint64(10), uint64(0), uint64(0), uint64(1), revision})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAnnouncementInteractionsPutUsesAuthenticatedActorAndScheduleCAS(t *testing.T) {
	h, auth := announcementInteractionsFixture(t)
	handlers := h.Handlers()
	if _, decodeErr := decodeAnnouncementValue(announcementPayload(t, interactionID(20), "private schedule text", 1)); decodeErr != nil {
		t.Fatalf("decode: %v", decodeErr)
	}
	revision := uint64(7)
	request := protocol.Request{Revision: &revision, Args: []any{nil, announcementPayload(t, interactionID(20), "private schedule text", 1)}}
	result, err := handlers[protocol.OpAnnouncementsPut].Handle(context.Background(), InteractionActor{User: interactionID(6)}, request)
	if err != nil || result.Status != 0 || auth.user != interactionID(6) || result.Revision == nil || *result.Revision != 1 {
		t.Fatalf("put result=%+v auth user=%v err=%v", result, auth.user, err)
	}
	stale := protocol.Request{Revision: &revision, Args: []any{interactionID(20), announcementPayload(t, interactionID(20), "private schedule text", 1)}}
	result, err = handlers[protocol.OpAnnouncementsPut].Handle(context.Background(), InteractionActor{User: interactionID(6)}, stale)
	if err != nil || result.Status != interactionStatusConflict {
		t.Fatalf("stale put result=%+v err=%v, want conflict", result, err)
	}
}

func TestAnnouncementInteractionsListIncludesTextAndPaginatesToFit(t *testing.T) {
	h, _ := announcementInteractionsFixture(t)
	put := h.Handlers()[protocol.OpAnnouncementsPut].Handle
	maxText := strings.Repeat("x", maxAnnouncementInteractionText)
	for _, announcementID := range []id.ID{interactionID(20), interactionID(22)} {
		result, err := put(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{nil, announcementPayload(t, announcementID, maxText, 1)}})
		if err != nil || result.Status != 0 {
			t.Fatalf("seed put result=%+v err=%v", result, err)
		}
	}
	list := h.Handlers()[protocol.OpAnnouncementsList].Handle
	first, err := list(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{uint64(0)}})
	if err != nil || first.Status != 0 || len(first.Data) > announcementDataLimit {
		t.Fatalf("first list result=%+v err=%v", first, err)
	}
	var firstData []any
	if err := cborx.Unmarshal(first.Data, &firstData); err != nil || len(firstData) != 4 {
		t.Fatalf("first page data=%v err=%v", firstData, err)
	}
	page, ok := firstData[3].([]any)
	if !ok || len(page) != 1 {
		t.Fatalf("first page rows=%v, want one max-size entry within response limit", firstData[3])
	}
	row, ok := page[0].([]any)
	if !ok || len(row) != 11 || row[2] != maxText {
		t.Fatalf("first row text roundtrip failed: %v", page[0])
	}
	second, err := list(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{uint64(1)}})
	if err != nil || second.Status != 0 || len(second.Data) > announcementDataLimit {
		t.Fatalf("second list result=%+v err=%v", second, err)
	}
	var secondData []any
	if err := cborx.Unmarshal(second.Data, &secondData); err != nil || len(secondData) != 4 {
		t.Fatalf("second page data=%v err=%v", secondData, err)
	}
	secondPage, ok := secondData[3].([]any)
	if !ok || len(secondPage) != 1 || secondPage[0].([]any)[2] != maxText {
		t.Fatalf("second page did not return remaining max-size text: %v", secondData[3])
	}
}

func TestAnnouncementInteractionsRejectsMalformedPayloadAndDeletesAtScheduleRevision(t *testing.T) {
	h, auth := announcementInteractionsFixture(t)
	malformed, _ := cborx.Marshal([]any{uint64(1), interactionID(20), interactionID(21), uint64(99), "daily", "UTC", "", uint64(10), uint64(0), uint64(0), uint64(1), uint64(1)})
	result, err := h.Handlers()[protocol.OpAnnouncementsPut].Handle(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{nil, malformed}})
	if err != nil || result.Status != interactionStatusUnavailable {
		t.Fatalf("malformed payload result=%+v err=%v", result, err)
	}
	put := h.Handlers()[protocol.OpAnnouncementsPut].Handle
	if result, err := put(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{nil, announcementPayload(t, interactionID(20), "scheduled", 1)}}); err != nil || result.Status != 0 {
		t.Fatalf("seed schedule result=%+v err=%v", result, err)
	}
	remove := h.Handlers()[protocol.OpAnnouncementsDelete].Handle
	result, err = remove(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{interactionID(20), uint64(2)}})
	if err != nil || result.Status != interactionStatusConflict {
		t.Fatalf("stale delete result=%+v err=%v", result, err)
	}
	result, err = remove(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{interactionID(20), uint64(1)}})
	if err != nil || result.Status != 0 {
		t.Fatalf("delete result=%+v err=%v", result, err)
	}
	auth.allowed = false
	result, err = remove(context.Background(), InteractionActor{User: interactionID(6)}, protocol.Request{Args: []any{interactionID(20), uint64(1)}})
	if err != nil || result.Status != interactionStatusForbidden {
		t.Fatalf("unauthorized delete result=%+v err=%v", result, err)
	}
}
