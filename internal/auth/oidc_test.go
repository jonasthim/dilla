package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
	"golang.org/x/oauth2"
)

// newAuthRepo returns a repository over a migrated temporary database. It is
// the same shape newPasskeys builds its store half from, without the ceremony
// runner: the OIDC mapping test needs nothing but the two identity queries.
func newAuthRepo(t *testing.T) store.Repository {
	t.Helper()
	path := filepath.Join(t.TempDir(), "oidc.db")
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatalf("OpenWrite: %v", err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatalf("provider: %v", err)
	}
	if _, err := p.Up(context.Background()); err != nil {
		t.Fatalf("up: %v", err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatalf("OpenRead: %v", err)
	}
	repo := sqlite.New(write, read)
	t.Cleanup(func() { repo.Close() })
	return repo
}

// fakeIdP serves a discovery document, a JWKS and a token endpoint, so the whole
// flow is exercised without a network. The token endpoint switches on the `code`
// form value, so one server serves the good case and the three refusals.
func fakeIdP(t *testing.T) *httptest.Server {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", "test"),
	)
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	sign := func(t *testing.T, issuer, audience, nonce string) string {
		t.Helper()
		now := time.Now()
		claims := map[string]any{
			"iss": issuer, "aud": audience, "sub": "sub-123", "email": "jonas@example",
			"nonce": nonce, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
		}
		body, err := json.Marshal(claims)
		if err != nil {
			t.Fatalf("marshal claims: %v", err)
		}
		signed, err := signer.Sign(body)
		if err != nil {
			t.Fatalf("sign: %v", err)
		}
		raw, err := signed.CompactSerialize()
		if err != nil {
			t.Fatalf("serialize: %v", err)
		}
		return raw
	}

	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"issuer":%q,"authorization_endpoint":%q,"token_endpoint":%q,"jwks_uri":%q,`+
			`"id_token_signing_alg_values_supported":["RS256"]}`,
			srv.URL, srv.URL+"/authorize", srv.URL+"/token", srv.URL+"/jwks")
	})
	mux.HandleFunc("GET /jwks", func(w http.ResponseWriter, r *http.Request) {
		set := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: key.Public(), KeyID: "test", Algorithm: "RS256", Use: "sig"},
		}}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(set); err != nil {
			t.Errorf("encode jwks: %v", err)
		}
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		var idToken string
		switch r.Form.Get("code") {
		case "code-good":
			idToken = sign(t, srv.URL, "dilla", "nonce")
		case "code-wrong-aud":
			idToken = sign(t, srv.URL, "someone-else", "nonce")
		case "code-wrong-iss":
			idToken = sign(t, "https://evil.example", "dilla", "nonce")
		case "code-wrong-nonce":
			idToken = sign(t, srv.URL, "dilla", "not-the-nonce")
		default:
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":"at","token_type":"Bearer","expires_in":3600,"id_token":%q}`, idToken)
	})
	return srv
}

func TestPKCEIsAlwaysS256AndTheVerifierIsSingleUse(t *testing.T) {
	c := config.Default().Auth.OIDC
	c.Enabled = true
	c.Issuer = "https://idp.example/app"
	c.ClientID = "dilla"
	c.RedirectURL = "https://chat.example/v1/auth/oidc/callback"
	o := auth.NewOIDC(c, "secret", clock.System())
	state, nonce, verifier := auth.NewVerifierAndState()
	if len(verifier) < 43 {
		t.Fatalf("verifier is %d characters; oauth2.GenerateVerifier produces 32 octets of randomness", len(verifier))
	}
	raw, err := o.AuthURLOffline(state, nonce, verifier) // no discovery needed
	if err != nil {
		t.Fatalf("AuthURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	if q.Get("code_challenge_method") != "S256" {
		t.Fatalf("code_challenge_method = %q, want S256", q.Get("code_challenge_method"))
	}
	if q.Get("code_challenge") == "" || q.Get("code_challenge") == verifier {
		t.Fatal("the challenge is missing or is the verifier in the clear")
	}
	if q.Get("state") != state || q.Get("nonce") != nonce {
		t.Fatal("state or nonce is missing from the authorization URL")
	}
	if want := oauth2.S256ChallengeFromVerifier(verifier); q.Get("code_challenge") != want {
		t.Fatalf("challenge = %q, want %q", q.Get("code_challenge"), want)
	}
}

func TestStateCookieIsSecurePrefixedAndScopedToTheCallback(t *testing.T) {
	// __Secure-, not __Host-: RFC 6265bis §4.1.3.2 makes a browser REJECT a
	// __Host- cookie whose Path is not exactly "/", so __Host- plus a narrow
	// path is a cookie no client ever stores and an OIDC login that can never
	// complete. The narrow path is the property worth keeping (deviation ID10).
	c := auth.StateCookie("__Secure-dilla-oidc", "value", 300)
	if !strings.HasPrefix(c.Name, "__Secure-") {
		t.Fatalf("cookie name %q is not __Secure- prefixed", c.Name)
	}
	if strings.HasPrefix(c.Name, "__Host-") {
		t.Fatal("a __Host- cookie with a path other than / is rejected by every browser")
	}
	if !c.Secure {
		t.Fatal("the state cookie is not Secure; __Secure- requires it")
	}
	if c.Domain != "" {
		t.Fatal("the state cookie sets a Domain")
	}
	if c.Path != "/v1/auth/oidc/callback" {
		t.Fatalf("cookie path = %q; the state cookie is scoped to the callback route only", c.Path)
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie flags: HttpOnly=%v SameSite=%v; the callback is a cross-site top-level navigation, so Lax is the tightest that works",
			c.HttpOnly, c.SameSite)
	}
}

func TestIssuerAndAudienceMismatchesAreRefused(t *testing.T) {
	idp := fakeIdP(t)
	defer idp.Close()
	c := config.Default().Auth.OIDC
	c.Enabled = true
	c.Issuer = idp.URL
	c.ClientID = "dilla"
	c.RedirectURL = "https://chat.example/v1/auth/oidc/callback"
	o := auth.NewOIDC(c, "secret", clock.System())
	ctx := context.Background()

	if _, _, _, err := o.Exchange(ctx, "code-wrong-aud", "verifier", "nonce"); err == nil {
		t.Fatal("an id_token for another audience was accepted")
	}
	if _, _, _, err := o.Exchange(ctx, "code-wrong-iss", "verifier", "nonce"); err == nil {
		t.Fatal("an id_token from another issuer was accepted")
	}
	if _, _, _, err := o.Exchange(ctx, "code-wrong-nonce", "verifier", "nonce"); err == nil {
		t.Fatal("an id_token with a different nonce was accepted; Verify does not check the nonce for you")
	}
	issuer, subject, email, err := o.Exchange(ctx, "code-good", "verifier", "nonce")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if issuer != idp.URL || subject != "sub-123" || email != "jonas@example" {
		t.Fatalf("claims = %q/%q/%q", issuer, subject, email)
	}
}

func TestMappingIsBySubjectSoAChangedEmailDoesNotRemap(t *testing.T) {
	repo := newAuthRepo(t)
	ctx := context.Background()
	user := seedAuthUser(t, repo)
	if err := repo.PutOIDCIdentity(ctx, "https://idp.example/app", "sub-123", user, 1); err != nil {
		t.Fatalf("PutOIDCIdentity: %v", err)
	}
	got, err := repo.GetOIDCIdentity(ctx, "https://idp.example/app", "sub-123")
	if err != nil || got != user {
		t.Fatalf("GetOIDCIdentity = %s, %v", got, err)
	}
	// A different subject is a different identity even with the same email.
	if _, err := repo.GetOIDCIdentity(ctx, "https://idp.example/app", "sub-456"); err == nil {
		t.Fatal("a different subject resolved to an existing account")
	}
}

func TestDiscoveryIsLazySoADownIdPDoesNotBlockStartUp(t *testing.T) {
	c := config.Default().Auth.OIDC
	c.Enabled = true
	c.Issuer = "https://127.0.0.1:1/does-not-exist"
	c.ClientID = "dilla"
	done := make(chan struct{})
	go func() {
		auth.NewOIDC(c, "secret", clock.System())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("NewOIDC blocked on discovery; it must be lazy")
	}
}
