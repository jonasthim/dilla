package server

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// RealIP returns the client address. X-Forwarded-For is honoured ONLY when the
// immediate peer is inside one of the configured trusted prefixes; otherwise a
// client could name its own address and walk around every per-address bucket.
func RealIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	peer := peerAddr(r)
	if len(trusted) == 0 || !inAny(peer, trusted) {
		return peer
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return peer
	}
	parts := strings.Split(xff, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		addr, err := netip.ParseAddr(strings.TrimSpace(parts[i]))
		if err != nil {
			continue
		}
		if inAny(addr, trusted) {
			continue // another hop of our own proxy chain
		}
		return addr
	}
	return peer
}

func peerAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	return addr.Unmap()
}

func inAny(a netip.Addr, prefixes []netip.Prefix) bool {
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// RateKey is the bucket key for an address: IPv4 by address, IPv6 by /64. A
// residential IPv6 customer holds a /56 or a /64, so keying by /128 would give
// one household unlimited buckets.
func RateKey(a netip.Addr) string {
	if !a.IsValid() {
		return "invalid"
	}
	if a.Is4() {
		return a.String()
	}
	p, err := a.Prefix(64)
	if err != nil {
		return a.String()
	}
	return p.String()
}
