package sfu

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func TestRemoteUsesLoopbackEndpointAndSharedRoomTokenKey(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Error("RoomService request has no bearer token")
		}
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	u, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	remote := NewRemote(Config{BindAddress: host, Port: port, APIKey: "dilla", APISecret: "0123456789abcdef0123456789abcdef"})
	if remote.HTTPURL() != upstream.URL {
		t.Fatalf("remote URL = %q, want %q", remote.HTTPURL(), upstream.URL)
	}
	token, err := remote.Token("room", "device", PublishGrant(true, false, false), nil)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := remote.VerifyToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Room != "room" || claims.Identity != "device" {
		t.Fatalf("token claims = %+v", claims)
	}
	if err := remote.CreateRoom(t.Context(), "room"); err == nil {
		t.Fatal("remote RoomService failure was ignored")
	}
}
