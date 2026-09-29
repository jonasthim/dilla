package api

import (
	"errors"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

// RedeemInvite is POST /v1/invites/redeem: [code] →
// [invite_id, community_id|null, grants_admin]. It SPENDS a use, which is why
// it is a POST and why the landing page below is not.
func (d Deps) RedeemInvite(w http.ResponseWriter, r *http.Request) {
	var req struct {
		_    struct{} `cbor:",toarray"`
		Code string
	}
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		server.WriteError(w, err)
		return
	}
	candidates, err := auth.CanonicalizeInviteCode(req.Code)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInviteInvalid, "invite code: %v", err))
		return
	}
	var invite store.InviteRow
	now := d.Clock.Now().Unix()
	err = d.Repo.Tx(r.Context(), func(tx store.Repository) error {
		var rerr error
		invite, rerr = redeem(r.Context(), tx, candidates, now)
		return rerr
	})
	if err != nil {
		if errors.Is(err, store.ErrExhausted) || errors.Is(err, store.ErrNotFound) {
			server.WriteError(w, server.Errorf(server.CodeInviteInvalid,
				"the invite is spent, expired, revoked or unknown"))
			return
		}
		server.WriteError(w, d.storeError(r, err))
		return
	}
	var community any
	if invite.CommunityID != nil {
		community = *invite.CommunityID
	}
	d.write(w, r, http.StatusOK, []any{invite.ID, community, uint64(invite.GrantsAdmin)})
}

// landingPage is the invite landing page. It carries no script, no external
// reference and no form: it is one paragraph a human reads before pasting the
// code into a client, and anything more is a phishing surface an instance hands
// out to strangers by construction.
var landingPage = template.Must(template.New("invite").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Invitation to {{.Instance}}</title>
</head><body>
<h1>You have been invited to {{.Instance}}</h1>
{{if .Community}}<p>Community: {{.Community}}</p>{{end}}
<p>Invite code: <code>{{.Code}}</code></p>
<p>This invitation is valid until {{.Expires}} and can be used {{.Remaining}} more time(s).</p>
<p>Open a dilla client, choose &ldquo;join an instance&rdquo;, enter <code>{{.Instance}}</code>
and paste the code above. This page never asks for a password.</p>
</body></html>
`))

type landingData struct {
	Instance  string
	Community string
	Code      string
	Expires   string
	Remaining uint64
}

// InviteLanding is GET /i/{code}. It NEVER mutates: a link pasted into a chat
// is fetched by every preview bot that sees it, and a landing page that spent a
// use would burn every invite the moment it was shared. The use is spent by
// POST /v1/invites/redeem and by POST /v1/accounts, both of which a bot does
// not issue.
func (d Deps) InviteLanding(w http.ResponseWriter, r *http.Request) {
	// no-store keeps the code out of shared caches; no-referrer keeps it out of
	// the Referer header of anything this page could ever link to.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")

	candidates, err := auth.CanonicalizeInviteCode(r.PathValue("code"))
	if err != nil {
		d.landingRefusal(w, r, server.Errorf(server.CodeInviteInvalid, "invite code: %v", err))
		return
	}
	var invite store.InviteRow
	found := false
	for _, c := range candidates {
		row, gerr := d.Repo.GetInviteByHash(r.Context(), auth.HashInviteCode(c))
		if gerr == nil {
			invite, found = row, true
			break
		}
		if !errors.Is(gerr, store.ErrNotFound) {
			d.landingRefusal(w, r, d.storeError(r, gerr))
			return
		}
	}
	now := d.Clock.Now().Unix()
	if !found || invite.RevokedAt != nil || invite.ExpiresAt <= now || invite.UsedCount >= invite.MaxUses {
		d.landingRefusal(w, r, server.Errorf(server.CodeInviteInvalid,
			"the invite is spent, expired, revoked or unknown"))
		return
	}

	community := ""
	if invite.CommunityID != nil {
		// Part 1a has no communities table, so the identifier is all this
		// instance can name. Plan 2 task 1 resolves it to a name.
		community = invite.CommunityID.String()
	}
	if wantsCBOR(r) {
		var communityValue any
		if invite.CommunityID != nil {
			communityValue = *invite.CommunityID
		}
		d.write(w, r, http.StatusOK, []any{d.Domain, communityValue, uint64(invite.ExpiresAt)}) //nolint:gosec // G115: a unix second or row id this server wrote, never negative
		return
	}
	d.generation(w)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if err := landingPage.Execute(w, landingData{
		Instance:  d.Domain,
		Community: community,
		Code:      r.PathValue("code"),
		Expires:   time.Unix(invite.ExpiresAt, 0).UTC().Format(time.RFC3339),
		Remaining: invite.MaxUses - invite.UsedCount,
	}); err != nil {
		d.logf(r, "api: render invite landing", "err", err)
	}
}

// landingRefusal answers in the format the caller asked for: CBOR for a client,
// a bare status for a browser. The refusal is identical for an unknown, spent,
// expired and revoked code, so the page is not an invite oracle.
func (d Deps) landingRefusal(w http.ResponseWriter, r *http.Request, err error) {
	if wantsCBOR(r) {
		server.WriteError(w, err)
		return
	}
	var e *server.Error
	status := http.StatusGone
	if errors.As(err, &e) {
		status = e.Status()
	}
	http.Error(w, "This invitation is no longer valid.", status)
}

// wantsCBOR is the content negotiation of GET /i/{code}: a client asks for CBOR
// explicitly, and everything else — a browser, a preview bot, curl — gets HTML.
func wantsCBOR(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept"), ",") {
		mt, _, _ := strings.Cut(part, ";")
		if strings.TrimSpace(mt) == "application/cbor" {
			return true
		}
	}
	return false
}
