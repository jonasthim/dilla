package client

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestSessionCurrentMemberLookupIsScopedAndProvidesWelcomeName(t *testing.T) {
	userID := testID(18)
	communityID := testID(17)
	var gotPath, gotAuth string
	var calls int
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		calls++
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		reply(w, http.StatusOK, []any{userID, "Ada", "ada", "Ada Lovelace"})
	}, 0)
	session, err := c.Session("member-session")
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := session.CommunityMembers(communityID)
	if err != nil {
		t.Fatal(err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := lookup.ResolveCurrentMember(canceled, userID); err == nil {
		t.Fatal("canceled lookup context was ignored")
	}
	present, name, err := lookup.ResolveCurrentMember(context.Background(), userID)
	if err != nil || !present || name != "Ada" {
		t.Fatalf("ResolveCurrentMember = (%v, %q, %v)", present, name, err)
	}
	if calls != 1 {
		t.Fatalf("member profile API calls = %d, want one", calls)
	}
	if gotPath != "/v1/communities/"+communityID.String()+"/members/"+userID.String() {
		t.Fatalf("path = %q", gotPath)
	}
	if gotAuth != "Bearer member-session" {
		t.Fatalf("authorization = %q", gotAuth)
	}
}

func TestSessionCurrentMemberLookupTreats404AsAbsent(t *testing.T) {
	userID := testID(18)
	communityID := testID(17)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		reply(w, http.StatusNotFound, []any{"E_NOT_FOUND", "no such object", nil})
	}, 0)
	session, err := c.Session("member-session")
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := session.CommunityMembers(communityID)
	if err != nil {
		t.Fatal(err)
	}
	present, name, err := lookup.ResolveCurrentMember(context.Background(), userID)
	if err != nil || present || name != "" {
		t.Fatalf("absent ResolveCurrentMember = (%v, %q, %v)", present, name, err)
	}
}

func TestMemberResolverPropagatesAPIError(t *testing.T) {
	communityID, userID := testID(17), testID(18)
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		reply(w, http.StatusInternalServerError, []any{"E_INTERNAL", "unavailable", nil})
	}, 0)
	session, err := c.Session("member-session")
	if err != nil {
		t.Fatal(err)
	}
	lookup, err := session.CommunityMembers(communityID)
	if err != nil {
		t.Fatal(err)
	}
	present, name, err := lookup.ResolveCurrentMember(context.Background(), userID)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || present || name != "" {
		t.Fatalf("ResolveCurrentMember = (%v, %q, %v), want propagated API error", present, name, err)
	}
}

func TestSessionChannelPermissionsUsesAuthenticatedChannelRoute(t *testing.T) {
	channelID := testID(27)
	var gotPath, gotAuth string
	c := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/instance" {
			reply(w, http.StatusOK, discovery(testID(99)))
			return
		}
		gotPath, gotAuth = r.URL.Path, r.Header.Get("Authorization")
		reply(w, http.StatusOK, uint64(65))
	}, 0)
	session, err := c.Session("member-session")
	if err != nil {
		t.Fatal(err)
	}
	bits, err := session.ChannelPermissions(context.Background(), channelID)
	if err != nil || bits != 65 {
		t.Fatalf("ChannelPermissions = (%d, %v), want (65, nil)", bits, err)
	}
	if gotPath != "/v1/channels/"+channelID.String()+"/permissions" || gotAuth != "Bearer member-session" {
		t.Fatalf("request = %q with authorization %q", gotPath, gotAuth)
	}
}
