package dilladtest

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"

	"github.com/jonasthim/dilla/internal/sfu"
)

// Default ports of the harness SFU, the same as dillad's own livekit.port and livekit.udp_port.
const (
	DefaultSFUPort    = 7880
	DefaultSFUUDPPort = 7882
)

// testSFUConfig is the in-process LiveKit a browser can reach on a one-interface box and on a CI
// runner: node_ip 127.0.0.1 with the loopback candidate on, **and** advertise_internal_ip, which
// also offers the host's LAN address. Firefox's nICEr never pairs a non-loopback local candidate
// with a loopback remote one (ice_component.cpp:1088-1090 at FIREFOX_155_0_RELEASE), so with
// loopback alone Firefox fails "could not establish pc connection" while Chromium connects (G35
// runs L2 and A1). sfu.DefaultConfig() leaves AdvertiseInternalIP false and must never be used
// unmodified for a browser test.
func testSFUConfig(port, udpPort int, apiKey, secret string) sfu.Config {
	c := sfu.DefaultConfig()
	c.Port = port
	c.UDPPort = udpPort
	c.BindAddress = "127.0.0.1"
	c.NodeIP = "127.0.0.1"
	c.EnableLoopbackCandidate = true
	c.AdvertiseInternalIP = true
	c.APIKey = apiKey
	c.APISecret = secret
	return c
}

// newSFUSecret is a fresh 64-hex-character LiveKit API secret, well over the 32 characters
// sfu.Config.YAML insists on.
func newSFUSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// SFU is the in-process LiveKit the host started, or nil when HostOptions.SFU was false.
func (h *Host) SFU() *sfu.Server { return h.sfu }

// mountSFU adds the two SFU routes to the control listener. They are test-only and never on the
// public mux: GET /debug/sfu names the SFU's signalling URLs, and POST /debug/sfu/token mints a raw
// LiveKit token with every grant for any room and identity, which is exactly what a browser test
// needs to connect to LiveKit directly — the SFU-as-adversary case dillad's /rtc gate cannot
// produce (plan MD-13).
func (h *Host) mountSFU(mux *http.ServeMux) {
	mux.HandleFunc("GET /debug/sfu", func(w http.ResponseWriter, _ *http.Request) {
		if h.sfu == nil {
			http.Error(w, "this host runs no SFU (start it with -sfu)", http.StatusNotFound)
			return
		}
		writeJSON(w, map[string]string{"url": h.sfu.URL(), "http_url": h.sfu.HTTPURL()})
	})
	mux.HandleFunc("POST /debug/sfu/token", func(w http.ResponseWriter, r *http.Request) {
		if h.sfu == nil {
			http.Error(w, "this host runs no SFU (start it with -sfu)", http.StatusNotFound)
			return
		}
		var body struct {
			Room     string `json:"room"`
			Identity string `json:"identity"`
			// Create asks for the room to exist before the token is used. LiveKit creates a room
			// on its first join while room.auto_create is true, which it is until task 10 turns
			// it off and makes this field call CreateRoom; until then it changes nothing.
			Create bool `json:"create"`
		}
		if !decode(w, r, &body) {
			return
		}
		if body.Room == "" || body.Identity == "" {
			http.Error(w, "room and identity are both required", http.StatusBadRequest)
			return
		}
		token, err := h.sfu.Token(body.Room, body.Identity)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]string{"url": h.sfu.URL(), "http_url": h.sfu.HTTPURL(), "token": token})
	})
}
