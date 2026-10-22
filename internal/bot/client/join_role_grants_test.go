package client

import (
	"context"
	"io"
	"net/http"
	"testing"
)

func TestGrantJoinRoleUsesDeterministicEpisodeRequestAndStableReceipt(t *testing.T) {
	community, installation, member, episode, role := testID(11), testID(12), testID(13), testID(14), testID(15)
	var calls int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		calls++
		if r.Method == http.MethodGet && r.URL.Path == "/v1/communities/"+community.String()+"/bot/members/"+member.String()+"/episode" {
			reply(w, http.StatusOK, []any{member, episode})
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/v1/communities/"+community.String()+"/bot/join-role-grants" || r.Header.Get("Authorization") != "Bearer bot-session" {
			t.Errorf("request = %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		a, err := decode(body, 3)
		reqID, _ := asID(a[0])
		gotMember, _ := asID(a[1])
		gotEpisode, _ := asID(a[2])
		if err != nil || reqID != joinRoleGrantRequestID(installation, member, episode) || gotMember != member || gotEpisode != episode {
			t.Errorf("grant request body = %#v, err=%v", a, err)
		}
		reply(w, http.StatusOK, []any{joinRoleGrantRequestID(installation, member, episode), installation, community, member, episode, role})
	}, 0)
	session, _ := c.Session("bot-session")
	lookup, _ := session.CommunityMembers(community)
	first, granted, err := lookup.GrantJoinRole(context.Background(), installation, member, episode)
	if err != nil || !granted || first.RoleID != role {
		t.Fatalf("first grant = %#v, %v, %v", first, granted, err)
	}
	second, granted, err := lookup.GrantJoinRole(context.Background(), installation, member, episode)
	if err != nil || !granted || second != first || calls != 4 {
		t.Fatalf("replay = %#v, %v, %v calls=%d", second, granted, err, calls)
	}
}

func TestGrantJoinRoleTreatsOnlyNoContentAsPolicyAbsent(t *testing.T) {
	community, installation, member, episode := testID(21), testID(22), testID(23), testID(24)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}, 0)
	session, _ := c.Session("bot-session")
	_, granted, err := session.GrantJoinRole(context.Background(), community, installation, member, episode)
	if err != nil || granted {
		t.Fatalf("absent policy = granted %v, err %v", granted, err)
	}
}
