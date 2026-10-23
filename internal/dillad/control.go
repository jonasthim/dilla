package dillad

import (
	"net/http"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// ControlHandler is what `dillad serve` answers on api.sock (R-UP11), the local control socket
// `dillad media` asks:
//
//   - GET /relay/barred/{device}: the media relay's barred lookup (server.RemoteBarred), answered
//     by the store as the call routes answer it (api.BarredDevices): {"barred": bool}. A store
//     failure is a 503, which the relay treats as a failed lookup: nothing cached, logged at WARN.
//   - GET /media/recent-mints: {"count": n, "window_ms": 60000}, the call tokens the start route
//     minted within the last 60 s, which `dillad media --idle` counts as busy (R-UP4).
//
// serve adds GET /relay/state (whether this process serves a relay itself). The socket itself is
// bound and guarded by server.ListenControl and server.ServeControl.
func (s *Server) ControlHandler() *http.ServeMux {
	mux := http.NewServeMux()
	barred := api.BarredDevices{Repo: s.o.Repo}
	mux.HandleFunc("GET /relay/barred/{device}", func(w http.ResponseWriter, r *http.Request) {
		dev, err := id.Parse(r.PathValue("device"))
		if err != nil {
			http.Error(w, "not a device id", http.StatusBadRequest)
			return
		}
		bar, err := barred.DeviceBarred(r.Context(), dev)
		if err != nil {
			s.o.Log.WarnContext(r.Context(), "api.sock: the barred lookup failed", "device", dev.String(), "err", err)
			http.Error(w, "the store did not answer", http.StatusServiceUnavailable)
			return
		}
		server.WriteControlJSON(w, map[string]bool{"barred": bar})
	})
	mux.HandleFunc("GET /media/recent-mints", func(w http.ResponseWriter, _ *http.Request) {
		n := 0
		if s.calls != nil {
			n = s.calls.RecentMints()
		}
		server.WriteControlJSON(w, map[string]int{"count": n, "window_ms": 60_000})
	})
	return mux
}
