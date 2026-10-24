package client

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/jonasthim/dilla/internal/id"
)

var (
	ErrSpotifyClaim         = errors.New("bot client: invalid Spotify authorization claim")
	ErrSpotifyClaimNotFound = errors.New("bot client: no pending Spotify authorization")
)

// SpotifyCodeClaim is the short-lived PKCE handoff from the installation broker.
// Its code and verifier are credentials and must not be logged or persisted.
type SpotifyCodeClaim struct {
	Attempt  id.ID
	Code     string
	Verifier string
}

func (SpotifyCodeClaim) String() string               { return "client.SpotifyCodeClaim{credentials:[redacted]}" }
func (SpotifyCodeClaim) GoString() string             { return "client.SpotifyCodeClaim{credentials:[redacted]}" }
func (SpotifyCodeClaim) MarshalJSON() ([]byte, error) { return []byte(`"[redacted]"`), nil }

// ClaimSpotifyCode retrieves the pending Spotify authorization for this
// installation. The broker scopes claims to this runtime and installation and
// replays the same claim until expiry so a lost HTTP response can be retried.
func (r *Runtime) ClaimSpotifyCode(ctx context.Context, installation id.ID) (SpotifyCodeClaim, error) {
	var out SpotifyCodeClaim
	i, err := pathID(installation)
	if err != nil {
		return out, err
	}
	raw, _, err := r.c.do(ctx, r.token, http.MethodPost, "bot-runtime/installations/"+i+"/spotify/claim", nil, nil, MaxSmallBody, true)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound && apiErr.Code == "E_NOT_FOUND" {
			return out, ErrSpotifyClaimNotFound
		}
		return out, err
	}
	a, err := decode(raw, 3)
	if err != nil {
		return out, ErrSpotifyClaim
	}
	var ok bool
	if out.Attempt, ok = asID(a[0]); !ok {
		return SpotifyCodeClaim{}, ErrSpotifyClaim
	}
	if out.Code, ok = a[1].(string); !ok || out.Code == "" || len(out.Code) > 2048 || strings.ContainsAny(out.Code, "\r\n\x00") {
		return SpotifyCodeClaim{}, ErrSpotifyClaim
	}
	if out.Verifier, ok = a[2].(string); !ok || !validSpotifyVerifier(out.Verifier) {
		return SpotifyCodeClaim{}, ErrSpotifyClaim
	}
	return out, nil
}

func validSpotifyVerifier(v string) bool {
	if len(v) < 43 || len(v) > 128 {
		return false
	}
	for _, c := range v {
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') && (c < '0' || c > '9') && !strings.ContainsRune("-._~", c) {
			return false
		}
	}
	return true
}
