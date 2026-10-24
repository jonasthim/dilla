package api

import (
	"net/http"

	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

func (d Deps) registerBotRuntimeDJRoles(m *server.Mux) {
	path := "GET /v1/bot-runtime/installations/{installation}/music/dj-roles"
	m.Handle(path, BotSessionRoute(d.Sessions, d.Limiter)(path, http.HandlerFunc(d.getBotRuntimeDJRoles)))
}

// getBotRuntimeDJRoles returns current policy to the enrolled Bot session only
// when its exact installation is still ready and Music-enabled. The route does
// not expose policy to runtime credentials or unrelated human sessions.
func (d Deps) getBotRuntimeDJRoles(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	s, ok := session(r)
	if !ok || s.Bot == nil {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "Bot session required"))
		return
	}
	if err := requireBotWire(s.WireVersion); err != nil {
		server.WriteError(w, err)
		return
	}
	installationID, err := server.PathID(r, "installation")
	if err != nil || installationID.IsZero() {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "invalid installation"))
		return
	}
	if installationID != s.Bot.InstallationID {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "Bot session does not own installation"))
		return
	}
	installation, err := d.Repo.GetActiveBotInstallationByCommunity(r.Context(), s.Bot.CommunityID)
	if err != nil || installation.ID != installationID || installation.CommunityID != s.Bot.CommunityID ||
		installation.State != store.BotInstallationReady || installation.RemovedAt != nil || uint64(installation.Capabilities)&botCapMusic == 0 {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "Music installation is unavailable"))
		return
	}
	rows, err := d.Repo.ListDJRolePolicy(r.Context(), installationID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	roles := make([]any, len(rows))
	for i, row := range rows {
		if row.InstallationID != installationID || row.RoleID.IsZero() {
			server.WriteError(w, server.Errorf(server.CodeUnavailable, "DJ policy is inconsistent"))
			return
		}
		roles[i] = row.RoleID
	}
	if err := server.EncodeBody(w, http.StatusOK, []any{s.Bot.CommunityID, installationID, uint64(installation.Capabilities), roles}); err != nil {
		server.WriteError(w, err)
	}
}
