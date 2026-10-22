package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/id"
)

type fakeRemovalNative struct {
	binding native.Binding
	group   native.GroupInfo
	cursor  uint64
	ingests [][]native.RemovalFeedEntry
}

func (n *fakeRemovalNative) Binding() native.Binding { return n.binding }
func (n *fakeRemovalNative) InspectGroup(context.Context, id.ID) (native.GroupInfo, error) {
	return n.group, nil
}
func (n *fakeRemovalNative) IngestRemovals(_ context.Context, _ id.ID, entries []native.RemovalFeedEntry) (uint64, error) {
	if len(entries) == 0 {
		return n.cursor, nil
	}
	if entries[0].Revision != n.cursor+1 {
		return 0, errors.New("fake native revision gap")
	}
	n.ingests = append(n.ingests, entries)
	n.cursor = entries[len(entries)-1].Revision
	return n.cursor, nil
}

type fakeRemovalSession struct {
	pages map[uint64]client.ModerationRemovalPage
	reads []uint64
}

func (s *fakeRemovalSession) ModerationRemovals(_ context.Context, _ id.ID, after, limit uint64) (client.ModerationRemovalPage, error) {
	if limit != removalSyncPageLimit {
		return client.ModerationRemovalPage{}, errors.New("unexpected page limit")
	}
	s.reads = append(s.reads, after)
	return s.pages[after], nil
}

func TestRemovalSyncAppliesOrderedProofRowsAndPersistsCursor(t *testing.T) {
	community, group := id.New(), id.New()
	n := &fakeRemovalNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		group: native.GroupInfo{ID: group, Kind: 0, Community: &community, State: 2}, cursor: 5}
	s := &fakeRemovalSession{pages: map[uint64]client.ModerationRemovalPage{5: {Rows: []client.ModerationRemoval{
		{Revision: 6, Proof: []byte{1}, Signature: []byte{2}, AcceptedAt: 20},
		{Revision: 7, Proof: []byte{3}, Signature: []byte{4}, AcceptedAt: 21},
	}, NextRevision: 7}}}
	syncer, err := newRemovalSync(n)
	if err != nil {
		t.Fatal(err)
	}
	cursor, more, err := syncer.sync(t.Context(), s, group)
	if err != nil || cursor != 7 || more || len(n.ingests) != 1 || len(n.ingests[0]) != 2 || n.ingests[0][1].AcceptedAt != 21 {
		t.Fatalf("sync = cursor %d more %v err %v ingests %v", cursor, more, err, n.ingests)
	}
	if len(s.reads) != 1 || s.reads[0] != 5 {
		t.Fatalf("feed reads = %v", s.reads)
	}
}

func TestRemovalSyncRejectsUnboundGroupAndGapBeforeIngest(t *testing.T) {
	community, group := id.New(), id.New()
	n := &fakeRemovalNative{binding: native.Binding{Instance: id.New(), Community: community, Installation: id.New()},
		group: native.GroupInfo{ID: group, Kind: 0, Community: &community, State: 2}}
	s := &fakeRemovalSession{pages: map[uint64]client.ModerationRemovalPage{0: {Rows: []client.ModerationRemoval{{Revision: 2}}, NextRevision: 2}}}
	syncer, err := newRemovalSync(n)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := syncer.sync(t.Context(), s, group); err == nil || len(n.ingests) != 0 {
		t.Fatalf("gap accepted: err=%v ingests=%v", err, n.ingests)
	}
	n.group.Community = nil
	if _, _, err := syncer.sync(t.Context(), s, group); err == nil || len(n.ingests) != 0 {
		t.Fatalf("unbound group accepted: err=%v ingests=%v", err, n.ingests)
	}
}
