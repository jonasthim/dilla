package client

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

func TestCommunityMembersPageUsesAfterAndValidatesRowsAndOrder(t *testing.T) {
	community, after, first, second, role := testID(1), testID(2), testID(3), testID(4), testID(5)
	var seen int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		seen++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/communities/"+community.String()+"/members" || r.URL.Query().Get("after") != after.String() || r.Header.Get("Authorization") != "Bearer bot-session" {
			t.Errorf("request = %s %s auth=%q", r.Method, r.URL.RequestURI(), r.Header.Get("Authorization"))
		}
		reply(w, http.StatusOK, []any{
			[]any{first, int64(1), "", []any{}, "ada", "Ada", uint64(0)},
			[]any{second, int64(2), "nick", []any{role}, "bot", "Bot", uint64(1)},
		})
	}, 0)
	s, _ := c.Session("bot-session")
	page, err := s.CommunityMembersPage(context.Background(), community, after)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Members) != 2 || page.Members[0].UserID != first || page.Members[0].Kind != 0 || len(page.Members[1].Roles) != 1 || page.Members[1].Roles[0] != role || page.Members[1].Kind != 1 || seen != 1 {
		t.Fatalf("page = %+v, requests=%d", page, seen)
	}
}

func TestCommunityMembersPageRejectsMalformedOrNonIncreasingPages(t *testing.T) {
	community, after, first := testID(1), testID(2), testID(3)
	for _, tc := range []struct {
		name string
		rows []any
	}{
		{"short-row", []any{[]any{first, int64(1)}}},
		{"zero-user", []any{[]any{id.ID{}, int64(1), "", []any{}, "ada", "Ada", uint64(0)}}},
		{"invalid-kind", []any{[]any{first, int64(1), "", []any{}, "ada", "Ada", uint64(2)}}},
		{"duplicate-role", []any{[]any{first, int64(1), "", []any{testID(4), testID(4)}, "ada", "Ada", uint64(0)}}},
		{"not-after-cursor", []any{[]any{after, int64(1), "", []any{}, "ada", "Ada", uint64(0)}}},
		{"out-of-order", []any{
			[]any{testID(5), int64(1), "", []any{}, "a", "A", uint64(0)},
			[]any{testID(4), int64(1), "", []any{}, "b", "B", uint64(0)},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/instance" {
					reply(w, http.StatusOK, discovery(testID(99)))
					return
				}
				reply(w, http.StatusOK, tc.rows)
			}, 0)
			s, _ := c.Session("bot-session")
			if _, err := s.CommunityMembersPage(context.Background(), community, after); !errors.Is(err, ErrProtocol) {
				t.Fatalf("error = %v, want ErrProtocol", err)
			}
		})
	}
}
