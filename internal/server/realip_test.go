package server_test

import (
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/jonasthim/dilla/internal/server"
)

func TestRealIPTrustsOnlyConfiguredProxies(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 127.0.0.1")
	if got := server.RealIP(r, trusted); got.String() != "203.0.113.9" {
		t.Fatalf("RealIP = %s, want the client address through a trusted proxy", got)
	}
	r.RemoteAddr = "198.51.100.4:5000"
	if got := server.RealIP(r, trusted); got.String() != "198.51.100.4" {
		t.Fatalf("RealIP = %s; an untrusted peer must not be able to forge its address", got)
	}
}

func TestIPv6IsKeyedBySlash64(t *testing.T) {
	a := netip.MustParseAddr("2001:db8:1:2:aaaa::1")
	b := netip.MustParseAddr("2001:db8:1:2:bbbb::9")
	c := netip.MustParseAddr("2001:db8:1:3::1")
	if server.RateKey(a) != server.RateKey(b) {
		t.Fatal("two addresses in one /64 must share a bucket")
	}
	if server.RateKey(a) == server.RateKey(c) {
		t.Fatal("two different /64s must not share a bucket")
	}
}
