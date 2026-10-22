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
	profileEndpoint    = "https://api.spotify.com/v1/me"
	maxProfileResponse = 16 << 10
	maxAccountID       = 128
)

var ErrProfile = errors.New("spotify profile request failed")

// Profile returns the stable Spotify account_id for the account represented by
// accessToken. It deliberately ignores profile fields that are not needed for
// identity, including product, which is deprecated for development mode.
func Profile(ctx context.Context, httpClient *http.Client, accessToken string) (string, error) {
	return profileAt(ctx, profileEndpoint, httpClient, accessToken)
}

// profileAt permits endpoint injection within this package for tests only.
func profileAt(ctx context.Context, endpoint string, httpClient *http.Client, accessToken string) (string, error) {
	if ctx == nil || len(accessToken) == 0 || len(accessToken) > 8192 || strings.ContainsAny(accessToken, "\r\n\x00") {
		return "", ErrProfile
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return "", ErrProfile
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", ErrProfile
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	clientCopy := *httpClient
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if clientCopy.Timeout == 0 || clientCopy.Timeout > 10*time.Second {
		clientCopy.Timeout = 10 * time.Second
	}
	resp, err := clientCopy.Do(req)
	if err != nil {
		return "", ErrProfile
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", ErrProfile
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	if mediaType != "application/json" {
		return "", ErrProfile
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProfileResponse+1))
	if err != nil || len(body) > maxProfileResponse {
		return "", ErrProfile
	}
	var profile struct {
		AccountID string `json:"account_id"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err = dec.Decode(&profile); err != nil {
		return "", ErrProfile
	}
	var trailing any
	if err = dec.Decode(&trailing); err != io.EOF {
		return "", ErrProfile
	}
	if !safeAccountID(profile.AccountID) {
		return "", ErrProfile
	}
	return profile.AccountID, nil
}

func safeAccountID(id string) bool {
	if len(id) == 0 || len(id) > maxAccountID {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}
