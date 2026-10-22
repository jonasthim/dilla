package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/spotifyauth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	spotifyCredentialArea     = uint64(8)
	spotifyCredentialVersion  = uint64(1)
	maxSpotifyCredentialState = 20 << 10
)

var (
	ErrSpotifyCredentials    = errors.New("Spotify credentials unavailable")
	ErrSpotifyState          = errors.New("invalid Spotify credential state")
	ErrSpotifyConflict       = errors.New("Spotify credential state changed")
	ErrSpotifyNoPending      = errors.New("no pending Spotify authorization")
	ErrSpotifyRelinkRequired = errors.New("Spotify authorization was consumed; relink required")
)

type spotifyCredentialRuntime interface {
	ClaimSpotifyCode(context.Context, id.ID) (client.SpotifyCodeClaim, error)
}

type spotifyCredentialNative interface {
	Binding() native.Binding
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}

type spotifyTokenExchanger interface {
	Exchange(context.Context, string, string) (spotifyauth.Token, error)
	Refresh(context.Context, string) (spotifyauth.Token, error)
}

type spotifyHTTPExchanger struct{ clientID, redirect string }

func (e spotifyHTTPExchanger) Exchange(ctx context.Context, code, verifier string) (spotifyauth.Token, error) {
	return spotifyauth.Exchange(ctx, nil, e.clientID, e.redirect, code, verifier)
}
func (e spotifyHTTPExchanger) Refresh(ctx context.Context, refresh string) (spotifyauth.Token, error) {
	return spotifyauth.Refresh(ctx, nil, e.clientID, refresh)
}

// SpotifyCredentials owns one encrypted, installation-bound Spotify token.
type SpotifyCredentials struct {
	runtime   spotifyCredentialRuntime
	native    spotifyCredentialNative
	exchanger spotifyTokenExchanger
	clock     func() time.Time
	binding   native.Binding
}

func NewSpotifyCredentials(runtime spotifyCredentialRuntime, n spotifyCredentialNative, clientID, redirectURL string) (*SpotifyCredentials, error) {
	b := native.Binding{}
	if n != nil {
		b = n.Binding()
	}
	if runtime == nil || n == nil || b.Instance.IsZero() || b.Community.IsZero() || b.Installation.IsZero() || strings.TrimSpace(clientID) == "" || strings.ContainsAny(clientID, "\r\n\x00") || !strings.HasPrefix(redirectURL, "https://") {
		return nil, ErrSpotifyCredentials
	}
	return newSpotifyCredentials(runtime, n, spotifyHTTPExchanger{clientID: clientID, redirect: redirectURL}), nil
}

func newSpotifyCredentials(runtime spotifyCredentialRuntime, n spotifyCredentialNative, x spotifyTokenExchanger) *SpotifyCredentials {
	return &SpotifyCredentials{runtime: runtime, native: n, exchanger: x, clock: time.Now, binding: n.Binding()}
}

// Link claims the brokered PKCE receipt and saves the exchanged token with revision CAS.
// A previously persisted attempt is returned without repeating its one-use exchange.
func (s *SpotifyCredentials) Link(ctx context.Context) error {
	if s == nil || ctx == nil || s.runtime == nil || s.native == nil || s.exchanger == nil {
		return ErrSpotifyCredentials
	}
	state, revision, err := s.read(ctx)
	if err != nil {
		return err
	}
	claim, err := s.runtime.ClaimSpotifyCode(ctx, s.binding.Installation)
	if errors.Is(err, client.ErrSpotifyClaimNotFound) {
		if state != nil {
			return nil
		}
		return ErrSpotifyNoPending
	}
	if err != nil {
		return ErrSpotifyCredentials
	}
	if claim.Attempt.IsZero() || claim.Code == "" || claim.Verifier == "" {
		return ErrSpotifyCredentials
	}
	if state != nil && state.attempt == claim.Attempt {
		return nil
	}
	tok, err := s.exchanger.Exchange(ctx, claim.Code, claim.Verifier)
	if err != nil {
		return ErrSpotifyCredentials
	}
	newState, err := s.fromToken(claim.Attempt, tok)
	if err != nil {
		return err
	}
	if err = s.save(ctx, newState, revision); err != nil {
		return ErrSpotifyRelinkRequired
	}
	return nil
}

// Load returns a valid access token, refreshing and safely persisting rotation when expired.
func (s *SpotifyCredentials) Load(ctx context.Context) (spotifyauth.Token, error) {
	if s == nil || ctx == nil || s.native == nil || s.exchanger == nil {
		return spotifyauth.Token{}, ErrSpotifyCredentials
	}
	state, revision, err := s.read(ctx)
	if err != nil {
		return spotifyauth.Token{}, err
	}
	if state == nil {
		return spotifyauth.Token{}, ErrSpotifyCredentials
	}
	if time.Unix(state.expires, 0).After(s.clock().Add(30 * time.Second)) {
		return spotifyauth.Token{AccessToken: state.access, RefreshToken: state.refresh, TokenType: "Bearer", ExpiresIn: int64(time.Unix(state.expires, 0).Sub(s.clock()).Seconds())}, nil
	}
	tok, err := s.exchanger.Refresh(ctx, state.refresh)
	if err != nil {
		return spotifyauth.Token{}, ErrSpotifyCredentials
	}
	updated, err := s.fromToken(state.attempt, tok)
	if err != nil {
		return spotifyauth.Token{}, err
	}
	if err = s.save(ctx, updated, revision); err != nil {
		latest, _, readErr := s.read(ctx)
		if readErr == nil && latest != nil && latest.attempt == state.attempt && latest.refresh == updated.refresh && latest.access == updated.access && latest.expires == updated.expires {
			return tok, nil
		}
		return spotifyauth.Token{}, err
	}
	return tok, nil
}

type spotifyCredentialState struct {
	attempt         id.ID
	access, refresh string
	expires         int64
}

func (s *SpotifyCredentials) read(ctx context.Context) (*spotifyCredentialState, uint64, error) {
	v, err := s.native.StateGet(ctx, spotifyCredentialArea, s.key())
	if err != nil {
		return nil, 0, ErrSpotifyCredentials
	}
	if v.Tombstone {
		return nil, v.Revision, ErrSpotifyState
	}
	if v.Revision == 0 {
		if len(v.Value) != 0 {
			return nil, 0, ErrSpotifyState
		}
		return nil, 0, nil
	}
	if len(v.Value) == 0 || len(v.Value) > maxSpotifyCredentialState {
		return nil, v.Revision, ErrSpotifyState
	}
	var a []any
	if cborx.ExpectMajor(v.Value, cborx.MajorArray) != nil || cborx.Unmarshal(v.Value, &a) != nil || len(a) != 8 {
		return nil, v.Revision, ErrSpotifyState
	}
	version, ok := a[0].(uint64)
	if !ok || version != spotifyCredentialVersion {
		return nil, v.Revision, ErrSpotifyState
	}
	instance, iok := spotifyStateID(a[1])
	community, cok := spotifyStateID(a[2])
	installation, ok := spotifyStateID(a[3])
	if !iok || !cok || !ok || instance != s.binding.Instance || community != s.binding.Community || installation != s.binding.Installation {
		return nil, v.Revision, ErrSpotifyState
	}
	attempt, ok := spotifyStateID(a[4])
	if !ok || attempt.IsZero() {
		return nil, v.Revision, ErrSpotifyState
	}
	access, aok := a[5].(string)
	refresh, rok := a[6].(string)
	expiry, eok := a[7].(uint64)
	if !aok || !rok || !eok || !validSpotifySecret(access) || !validSpotifySecret(refresh) || expiry == 0 || expiry > math.MaxInt64 {
		return nil, v.Revision, ErrSpotifyState
	}
	return &spotifyCredentialState{attempt: attempt, access: access, refresh: refresh, expires: int64(expiry)}, v.Revision, nil
}

func spotifyStateID(v any) (id.ID, bool) {
	b, ok := v.([]byte)
	if !ok || len(b) != len(id.ID{}) {
		return id.ID{}, false
	}
	var out id.ID
	copy(out[:], b)
	return out, true
}

func (s *SpotifyCredentials) fromToken(attempt id.ID, t spotifyauth.Token) (*spotifyCredentialState, error) {
	now := s.clock()
	if attempt.IsZero() || !validSpotifySecret(t.AccessToken) || !validSpotifySecret(t.RefreshToken) || t.ExpiresIn <= 0 || t.ExpiresIn > 365*24*60*60 || now.Unix() > math.MaxInt64-t.ExpiresIn {
		return nil, ErrSpotifyCredentials
	}
	return &spotifyCredentialState{attempt: attempt, access: t.AccessToken, refresh: t.RefreshToken, expires: now.Unix() + t.ExpiresIn}, nil
}

func (s *SpotifyCredentials) save(ctx context.Context, st *spotifyCredentialState, revision uint64) error {
	body, err := cborx.Marshal([]any{spotifyCredentialVersion, s.binding.Instance, s.binding.Community, s.binding.Installation, st.attempt, st.access, st.refresh, uint64(st.expires)})
	if err != nil || len(body) > maxSpotifyCredentialState {
		return ErrSpotifyState
	}
	// Native transaction receipts outlive this call. A fresh operation ID keeps
	// a later stale write with identical bytes from replaying an earlier receipt.
	tx := id.New()
	_, err = s.native.StateTransaction(ctx, tx, []native.StateChange{{Area: spotifyCredentialArea, Key: s.key(), ExpectedRevision: revision, Value: body}})
	if err != nil {
		return ErrSpotifyConflict
	}
	return nil
}

func (s *SpotifyCredentials) key() []byte {
	return []byte(fmt.Sprintf("dilla.bot.spotify.v1/%x/%x/%x", s.binding.Instance, s.binding.Community, s.binding.Installation))
}
func validSpotifySecret(v string) bool {
	return v != "" && len(v) <= 8192 && !strings.ContainsAny(v, "\r\n\x00")
}
