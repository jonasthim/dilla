// Package spotifyauth exchanges brokered authorization-code PKCE credentials
// with Spotify. It deliberately does not persist tokens or configure playback.
package spotifyauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	tokenEndpoint    = "https://accounts.spotify.com/api/token"
	maxTokenResponse = 32 << 10
)

var ErrExchange = errors.New("spotify token request failed")

type Token struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func (Token) String() string               { return "spotifyauth.Token{credentials:[redacted]}" }
func (Token) GoString() string             { return "spotifyauth.Token{credentials:[redacted]}" }
func (Token) MarshalJSON() ([]byte, error) { return []byte(`"[redacted]"`), nil }

// Exchange sends a PKCE authorization-code grant to Spotify's fixed HTTPS
// token endpoint. The caller must treat both returned tokens as secrets.
func Exchange(ctx context.Context, httpClient *http.Client, clientID, redirectURL, code, verifier string) (Token, error) {
	return exchangeAt(ctx, tokenEndpoint, httpClient, clientID, redirectURL, code, verifier)
}

// Refresh exchanges a stored refresh token for a new access token. Spotify may
// rotate the refresh token; when it does not, the existing one remains valid.
func Refresh(ctx context.Context, httpClient *http.Client, clientID, refreshToken string) (Token, error) {
	return refreshAt(ctx, tokenEndpoint, httpClient, clientID, refreshToken)
}

// refreshAt is endpoint-injectable only within this package for tests.
func refreshAt(ctx context.Context, endpoint string, httpClient *http.Client, clientID, refreshToken string) (Token, error) {
	var empty Token
	if ctx == nil || strings.TrimSpace(clientID) == "" || strings.ContainsAny(clientID, "\r\n\x00") || len(refreshToken) == 0 || len(refreshToken) > 8192 || strings.ContainsAny(refreshToken, "\r\n\x00") {
		return empty, ErrExchange
	}
	return postToken(ctx, endpoint, httpClient, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {clientID},
	}, refreshToken)
}

func exchangeAt(ctx context.Context, endpoint string, httpClient *http.Client, clientID, redirectURL, code, verifier string) (Token, error) {
	var empty Token
	if ctx == nil || strings.TrimSpace(clientID) == "" || strings.ContainsAny(clientID, "\r\n\x00") || code == "" || len(code) > 2048 || strings.ContainsAny(code, "\r\n\x00") || !validVerifier(verifier) {
		return empty, ErrExchange
	}
	redirect, err := url.Parse(redirectURL)
	if err != nil || redirect.Scheme != "https" || redirect.Host == "" || redirect.User != nil || redirect.Fragment != "" {
		return empty, ErrExchange
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirectURL},
		"client_id":     {clientID},
		"code_verifier": {verifier},
	}
	return postToken(ctx, endpoint, httpClient, form, "")
}

func postToken(ctx context.Context, endpoint string, httpClient *http.Client, form url.Values, fallbackRefreshToken string) (Token, error) {
	var empty Token
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" {
		return empty, ErrExchange
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, u.String(), strings.NewReader(form.Encode()))
	if err != nil {
		return empty, ErrExchange
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	clientCopy := *httpClient
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := clientCopy.Do(req)
	if err != nil {
		return empty, ErrExchange
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return empty, ErrExchange
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		return empty, ErrExchange
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxTokenResponse+1))
	if err != nil || len(body) > maxTokenResponse {
		return empty, ErrExchange
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var token Token
	if err = dec.Decode(&token); err != nil {
		return empty, ErrExchange
	}
	var trailing any
	if err = dec.Decode(&trailing); err != io.EOF {
		return empty, ErrExchange
	}
	if token.RefreshToken == "" {
		token.RefreshToken = fallbackRefreshToken
	}
	if token.AccessToken == "" || len(token.AccessToken) > 8192 || token.TokenType != "Bearer" || token.ExpiresIn <= 0 || token.ExpiresIn > 365*24*60*60 || token.RefreshToken == "" || len(token.RefreshToken) > 8192 || strings.ContainsAny(token.AccessToken+token.RefreshToken, "\r\n\x00") {
		return empty, ErrExchange
	}
	return token, nil
}

func validVerifier(v string) bool {
	if len(v) < 43 || len(v) > 128 {
		return false
	}
	for _, c := range v {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~", c)) {
			return false
		}
	}
	return true
}
