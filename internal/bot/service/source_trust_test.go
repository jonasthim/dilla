package service

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

type fakeDeviceListSession struct {
	heads   [][]byte
	rows    map[uint64][][]any
	queries []uint64
}

func (s *fakeDeviceListSession) OwnDeviceList(context.Context, id.ID) ([]byte, error) {
	if len(s.heads) == 0 {
		return nil, errors.New("no head")
	}
	raw := s.heads[0]
	if len(s.heads) > 1 {
		s.heads = s.heads[1:]
	}
	return raw, nil
}
func (s *fakeDeviceListSession) DeviceListHistory(_ context.Context, _ id.ID, after uint64) ([][]any, error) {
	s.queries = append(s.queries, after)
	return s.rows[after], nil
}

func outerDeviceList(t *testing.T, version uint64, signed []byte) []byte {
	t.Helper()
	raw, err := cborx.Marshal([]any{version, signed, make([]byte, 64), make([]byte, 32)})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestReadSenderHistoryPassesInnerSignedListAndCachedAnchor(t *testing.T) {
	user := sid(15)
	row1 := []any{uint64(1), []byte("signed-list-one"), make([]byte, 64), make([]byte, 32)}
	row2 := []any{uint64(2), []byte("signed-list-two"), make([]byte, 64), make([]byte, 32)}
	head2, err := cborx.Marshal(row2)
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeDeviceListSession{heads: [][]byte{head2, head2}, rows: map[uint64][][]any{0: {row1, row2}}}
	history, head, version, err := readSenderHistory(context.Background(), s, user, 1)
	if err != nil {
		t.Fatal(err)
	}
	if version != 2 || !reflect.DeepEqual(head, []byte("signed-list-two")) {
		t.Fatalf("inner head=%q version=%d", head, version)
	}
	var got [][]any
	if err = cborx.Unmarshal(history, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0][0] != uint64(1) || got[1][0] != uint64(2) {
		t.Fatalf("history omitted cached anchor: %#v", got)
	}
	if !reflect.DeepEqual(s.queries, []uint64{0}) {
		t.Fatalf("history queried after %v, want cachedVersion-1 anchor", s.queries)
	}
}

func TestReadSenderHistoryRejectsGapBeforeTrust(t *testing.T) {
	user := sid(16)
	head := outerDeviceList(t, 3, []byte("signed-list-three"))
	s := &fakeDeviceListSession{heads: [][]byte{head}, rows: map[uint64][][]any{0: {{uint64(1), []byte("one"), make([]byte, 64), make([]byte, 32)}, {uint64(3), []byte("three"), make([]byte, 64), make([]byte, 32)}}}}
	if _, _, _, err := readSenderHistory(context.Background(), s, user, 1); !errors.Is(err, ErrSenderHistoryStale) {
		t.Fatalf("gap accepted: %v", err)
	}
}

func TestReadSenderHistoryRetriesOnceAfterCurrentHeadMoves(t *testing.T) {
	user := sid(17)
	row1 := []any{uint64(1), []byte("one"), make([]byte, 64), make([]byte, 32)}
	row2 := []any{uint64(2), []byte("two"), make([]byte, 64), make([]byte, 32)}
	row3 := []any{uint64(3), []byte("three"), make([]byte, 64), make([]byte, 32)}
	head2, err := cborx.Marshal(row2)
	if err != nil {
		t.Fatal(err)
	}
	head3, err := cborx.Marshal(row3)
	if err != nil {
		t.Fatal(err)
	}
	s := &fakeDeviceListSession{heads: [][]byte{head2, head3, head3, head3}, rows: map[uint64][][]any{0: {row1, row2, row3}}}
	_, head, version, err := readSenderHistory(context.Background(), s, user, 1)
	if err != nil {
		t.Fatal(err)
	}
	if version != 3 || !reflect.DeepEqual(head, []byte("three")) {
		t.Fatalf("after one head race got head=%q version=%d", head, version)
	}
}

func TestReadSenderHistoryRejectsRewindAndVersionBudget(t *testing.T) {
	user := sid(18)
	for _, tc := range []struct {
		name    string
		version uint64
		cached  uint64
	}{
		{name: "rewind", version: 1, cached: 2},
		{name: "version budget", version: 1026, cached: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			head := outerDeviceList(t, tc.version, []byte("signed-list"))
			s := &fakeDeviceListSession{heads: [][]byte{head}, rows: map[uint64][][]any{}}
			if _, _, _, err := readSenderHistory(context.Background(), s, user, tc.cached); !errors.Is(err, ErrSenderHistoryStale) {
				t.Fatalf("invalid history accepted: %v", err)
			}
		})
	}
}
