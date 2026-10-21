// Package client is the bounded HTTP transport used by one managed bot
// installation. Runtime provisioning and device sessions are deliberately
// different types: a runtime credential cannot call device-session methods.
package client

import (
	"bytes"
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	DefaultTimeout   = 30 * time.Second
	MaxBody          = 32 << 20
	MaxCommitBody    = 16 << 20
	MaxDSBody        = 2 << 20
	MaxRuntimeBody   = 16 << 10
	MaxSmallBody     = 64 << 10
	MaxSessionBody   = 8192
	MaxAggregateRows = 10000
)

var (
	ErrInvalidConfig   = errors.New("bot client: invalid configuration")
	ErrInstanceChanged = errors.New("bot client: instance identity changed")
	ErrProtocol        = errors.New("bot client: invalid protocol response")
	ErrPageLimit       = errors.New("bot client: aggregate page limit exceeded; continue with page methods")
)

// Config pins the instance identity. AllowLoopbackHTTP is intended for an
// explicitly configured same-host instance and local tests only.
type Config struct {
	BaseURL           string
	HTTPClient        *http.Client
	InstanceID        id.ID
	AllowLoopbackHTTP bool
	Timeout           time.Duration
}

type Client struct {
	base       *url.URL
	http       *http.Client
	instance   id.ID
	timeout    time.Duration
	discovered atomic.Bool
}

type Runtime struct {
	c     *Client
	token string
}
type Session struct {
	c     *Client
	token string
}

func New(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u == nil || u.Opaque != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || u.Path != "" && u.Path != "/" || u.RawPath != "" || u.Hostname() == "" {
		return nil, ErrInvalidConfig
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return nil, ErrInvalidConfig
	}
	if u.Scheme == "http" {
		host := strings.ToLower(u.Hostname())
		ip := net.ParseIP(host)
		if !cfg.AllowLoopbackHTTP || !(ip != nil && ip.IsLoopback() || host == "localhost") {
			return nil, ErrInvalidConfig
		}
	}
	if cfg.InstanceID.IsZero() {
		return nil, ErrInvalidConfig
	}
	h := cfg.HTTPClient
	if h == nil {
		h = &http.Client{}
	}
	// Preserve the caller's transport, timeout, jar and other settings while
	// enforcing same-origin credential handling even when an injected client
	// follows redirects by default.
	hcopy := *h
	hcopy.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	hcopy.Jar = nil
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	u.Path, u.RawPath, u.RawQuery, u.Fragment = "", "", "", ""
	return &Client{base: u, http: &hcopy, instance: cfg.InstanceID, timeout: timeout}, nil
}

func (c *Client) Runtime(token string) (*Runtime, error) {
	if c == nil || strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return nil, ErrInvalidConfig
	}
	return &Runtime{c: c, token: token}, nil
}
func (c *Client) Session(token string) (*Session, error) {
	if c == nil || strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return nil, ErrInvalidConfig
	}
	return &Session{c: c, token: token}, nil
}

// Origin returns the pinned origin for a sibling gateway client. It contains
// no path, query, fragment, or credential.
func (c *Client) Origin() string    { return c.base.Scheme + "://" + c.base.Host }
func (c *Client) InstanceID() id.ID { return c.instance }

// BearerToken supplies the current device session to the separate gateway
// client. Callers must keep it out of logs and persistent diagnostics.
func (s *Session) BearerToken() string { return s.token }

type Outcome uint8

const (
	OutcomeDefinitive Outcome = iota + 1
	OutcomeUnknown
)

// APIError contains stable refusal data needed for recovery. Free-form server
// details and opaque response bytes are omitted from Error() to avoid leaking
// potentially private values into logs.
type APIError struct {
	Status                                    int
	Code                                      string
	Outcome                                   Outcome
	RetryAfterMS                              *uint64
	WireVersions, E2EEVersions, MediaVersions []uint64
	WinningCommit                             []byte
	Proposals                                 [][]byte
	Rule                                      string
}

func (e *APIError) Error() string { return fmt.Sprintf("bot client: %s (HTTP %d)", e.Code, e.Status) }

func (c *Client) endpoint(path string, q url.Values) *url.URL {
	u := *c.base
	u.Path = "/v1/" + strings.TrimPrefix(path, "/")
	u.RawPath = ""
	u.RawQuery = q.Encode()
	return &u
}

func (c *Client) do(ctx context.Context, token, method, path string, query url.Values, body []byte, max int64, mutation bool) ([]byte, int, error) {
	if path != "instance" && !c.discovered.Load() {
		return nil, 0, errors.New("bot client: discovery required before API use")
	}
	if len(body) > MaxBody || max > 0 && int64(len(body)) > max {
		return nil, 0, ErrProtocol
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint(path, query).String(), reader)
	if err != nil {
		return nil, 0, ErrInvalidConfig
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/cbor")
	}
	req.Header.Set("Accept", "application/cbor")
	resp, err := c.http.Do(req)
	if err != nil {
		if mutation {
			return nil, 0, &APIError{Status: 0, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
		}
		return nil, 0, errors.New("bot client: request failed")
	}
	defer resp.Body.Close()
	wantStatus, routeOK := expectedStatus(method, path)
	if !routeOK {
		if mutation {
			return nil, resp.StatusCode, unknown()
		}
		return nil, resp.StatusCode, ErrProtocol
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && resp.StatusCode != wantStatus {
		if mutation {
			return nil, resp.StatusCode, unknown()
		}
		return nil, resp.StatusCode, ErrProtocol
	}
	if resp.StatusCode != http.StatusNoContent {
		mediaType, _, parseErr := mime.ParseMediaType(resp.Header.Get("Content-Type"))
		if parseErr != nil || mediaType != "application/cbor" {
			if mutation {
				return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
			}
			return nil, resp.StatusCode, ErrProtocol
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		errorLimit := errorBodyLimit(path)
		b, readErr := io.ReadAll(io.LimitReader(resp.Body, errorLimit+1))
		if mutation && resp.StatusCode >= 500 || mutation && (resp.StatusCode >= 300 && resp.StatusCode < 400) || readErr != nil || int64(len(b)) > errorLimit {
			return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
		}
		code := "E_HTTP_ERROR"
		var a []any
		if int64(len(b)) <= errorLimit && cborx.Unmarshal(b, &a) == nil && errorShape(a) {
			if s, ok := a[0].(string); ok && knownErrorCode(s) {
				code = s
			} else {
				code = "E_HTTP_ERROR"
			}
		} else if resp.StatusCode >= 500 {
			code = "E_INTERNAL"
		} else if mutation {
			return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
		} else {
			return nil, resp.StatusCode, ErrProtocol
		}
		return nil, resp.StatusCode, parseAPIError(resp.StatusCode, code, a)
	}
	if max <= 0 || max > MaxBody {
		max = MaxBody
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil || int64(len(b)) > max {
		if mutation {
			return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
		}
		return nil, resp.StatusCode, ErrProtocol
	}
	if resp.StatusCode == http.StatusNoContent {
		if len(b) != 0 {
			if mutation {
				return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
			}
			return nil, resp.StatusCode, ErrProtocol
		}
		return nil, resp.StatusCode, nil
	}
	if len(b) == 0 || cborx.CheckDeterministic(b) != nil {
		if mutation {
			return nil, resp.StatusCode, &APIError{Status: resp.StatusCode, Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
		}
		return nil, resp.StatusCode, ErrProtocol
	}
	return b, resp.StatusCode, nil
}

func errorBodyLimit(path string) int64 {
	switch {
	case strings.HasSuffix(path, "/commit"):
		return MaxCommitBody
	case strings.HasSuffix(path, "/message"), strings.HasSuffix(path, "/resync"):
		return MaxDSBody
	default:
		return MaxSmallBody
	}
}

func (c *Client) aggregateContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithTimeout(ctx, c.timeout)
}

func errorShape(a []any) bool {
	if len(a) < 3 || len(a) > 6 {
		return false
	}
	if _, ok := a[0].(string); !ok {
		return false
	}
	if _, ok := a[1].(string); !ok {
		return false
	}
	var retry *uint64
	if a[2] != nil {
		n, ok := asUint(a[2])
		if !ok {
			return false
		}
		retry = &n
	}
	switch a[0] {
	case "E_COMMIT_CONFLICT":
		if retry != nil || len(a) != 5 {
			return false
		}
		if _, ok := asBytes(a[3], -1); !ok {
			return false
		}
		return byteRows(a[4])
	case "E_COMMIT_REQUIRED":
		return retry != nil && len(a) == 4 && byteRows(a[3])
	case "E_COMMIT_INVALID":
		if retry != nil || len(a) != 4 {
			return false
		}
		_, ok := a[3].(string)
		return ok
	case "E_VERSION":
		if retry != nil || len(a) != 6 {
			return false
		}
		for i := 3; i < 6; i++ {
			versions, err := uints(a[i])
			if err != nil || !distinctVersions(versions) {
				return false
			}
		}
		return true
	default:
		if len(a) != 3 {
			return false
		}
		if (a[0] == "E_RATE_LIMITED" || a[0] == "E_UNAVAILABLE") && retry == nil {
			return false
		}
		if retry != nil && a[0] != "E_RATE_LIMITED" && a[0] != "E_COMMIT_REQUIRED" && a[0] != "E_UNAVAILABLE" {
			return false
		}
		return true
	}
}
func byteRows(v any) bool {
	rows, ok := v.([]any)
	if !ok || len(rows) > 10000 {
		return false
	}
	for _, row := range rows {
		_, ok := asBytes(row, -1)
		if !ok {
			return false
		}
	}
	return true
}
func knownErrorCode(s string) bool {
	switch s {
	case "E_INVALID_REQUEST", "E_BINDING_INVALID", "E_UNAUTHENTICATED", "E_FORBIDDEN", "E_LEAF_NOT_CURRENT", "E_MODE_READABLE", "E_NOT_UPLOADER", "E_NOT_FOUND", "E_GROUP_EXISTS", "E_COMMIT_CONFLICT", "E_CALL_FULL", "E_CALL_SHARERS_FULL", "E_CALL_NOT_ALONE", "E_REMOVE_PENDING", "E_PRUNED", "E_INVITE_INVALID", "E_TOO_LARGE", "E_COMMIT_INVALID", "E_COMMITMENT_INVALID", "E_COMMIT_REQUIRED", "E_RATE_LIMITED", "E_STORAGE_FULL", "E_UNAVAILABLE", "E_VERSION", "E_INTERNAL", "E_PROVISIONAL_OUTSIDE_PAIRING", "E_ENVELOPE_SHAPE", "E_ENVELOPE_TYPE", "E_ENVELOPE_LIMIT", "E_CHANNEL_MODE", "E_FACTOR_REQUIRED", "E_TARGET_NO_FACTOR", "E_STEP_UP", "E_PASSKEY_UNKNOWN":
		return true
	default:
		return false
	}
}
func parseAPIError(status int, code string, a []any) *APIError {
	e := &APIError{Status: status, Code: code, Outcome: OutcomeDefinitive}
	if !knownErrorCode(code) {
		return e
	}
	if len(a) > 2 && a[2] != nil {
		n, _ := asUint(a[2])
		e.RetryAfterMS = &n
	}
	switch code {
	case "E_VERSION":
		e.WireVersions, _ = uints(a[3])
		e.E2EEVersions, _ = uints(a[4])
		e.MediaVersions, _ = uints(a[5])
	case "E_COMMIT_CONFLICT":
		e.WinningCommit, _ = asBytes(a[3], -1)
		e.Proposals = copyByteRows(a[4])
	case "E_COMMIT_REQUIRED":
		e.Proposals = copyByteRows(a[3])
	case "E_COMMIT_INVALID":
		e.Rule, _ = a[3].(string)
	}
	return e
}
func copyByteRows(v any) [][]byte {
	rows, _ := v.([]any)
	out := make([][]byte, len(rows))
	for i, r := range rows {
		b, _ := asBytes(r, -1)
		out[i] = append([]byte(nil), b...)
	}
	return out
}

func expectedStatus(method, path string) (int, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 1 && parts[0] == "instance" && method == http.MethodGet {
		return 200, true
	}
	if len(parts) == 2 && parts[0] == "instance" && parts[1] == "limits" && method == http.MethodGet {
		return 200, true
	}
	if len(parts) >= 2 && parts[0] == "bot-runtime" && parts[1] == "installations" {
		if len(parts) == 2 && method == http.MethodGet {
			return 200, true
		}
		if len(parts) == 4 && parts[3] == "claim" && method == http.MethodPost {
			return 200, true
		}
		if len(parts) == 4 && parts[3] == "enroll" && method == http.MethodPost {
			return 201, true
		}
		if len(parts) == 4 && parts[3] == "credential" && method == http.MethodPut {
			return 200, true
		}
		if len(parts) == 4 && parts[3] == "ready" && method == http.MethodPost {
			return 200, true
		}
	}
	if len(parts) >= 2 && parts[0] == "devices" {
		if len(parts) == 4 && parts[2] == "sessions" && parts[3] == "challenge" && method == http.MethodPost {
			return 201, true
		}
		if len(parts) == 3 && parts[2] == "sessions" && method == http.MethodPost {
			return 201, true
		}
		if len(parts) == 3 && parts[2] == "keypackage" && method == http.MethodGet {
			return 200, true
		}
	}
	if len(parts) == 2 && parts[0] == "sessions" && parts[1] == "negotiate" && method == http.MethodPost {
		return 200, true
	}
	if len(parts) == 3 && parts[0] == "users" && parts[2] == "device-list" {
		if method == http.MethodGet {
			return 200, true
		}
		if method == http.MethodPut {
			return 204, true
		}
	}
	if len(parts) == 1 && parts[0] == "keypackages" && method == http.MethodPost {
		return 201, true
	}
	if len(parts) == 1 && parts[0] == "welcomes" && method == http.MethodGet {
		return 200, true
	}
	if len(parts) == 2 && parts[0] == "welcomes" && method == http.MethodDelete {
		return 204, true
	}
	if len(parts) == 1 && parts[0] == "groups" && method == http.MethodPost {
		return 201, true
	}
	if len(parts) == 3 && parts[0] == "groups" {
		switch parts[2] {
		case "info", "tree", "handshakes", "messages", "proposals", "heal":
			if method == http.MethodGet {
				return 200, true
			}
			if parts[2] == "heal" && method == http.MethodPost {
				return 200, true
			}
		case "commit", "proposal", "resync", "message":
			if method == http.MethodPost {
				return 200, true
			}
		case "cursor":
			if method == http.MethodPost {
				return 204, true
			}
		case "fork-report":
			if method == http.MethodPost {
				return 202, true
			}
		}
	}
	if len(parts) == 1 && parts[0] == "communities" && method == http.MethodGet {
		return 200, true
	}
	if len(parts) == 3 && parts[0] == "communities" && parts[2] == "channels" && method == http.MethodGet {
		return 200, true
	}
	return 0, false
}

func decode(raw []byte, n int) ([]any, error) {
	var a []any
	if err := cborx.Unmarshal(raw, &a); err != nil || n >= 0 && len(a) != n {
		return nil, ErrProtocol
	}
	return a, nil
}
func asUint(v any) (uint64, bool) { n, ok := v.(uint64); return n, ok }
func asBytes(v any, size int) ([]byte, bool) {
	b, ok := v.([]byte)
	return b, ok && (size < 0 || len(b) == size)
}
func asID(v any) (id.ID, bool) {
	b, ok := asBytes(v, 16)
	var out id.ID
	if ok {
		copy(out[:], b)
	}
	return out, ok && !out.IsZero()
}
func encode(v any) ([]byte, error) {
	b, e := cborx.Marshal(v)
	if e != nil {
		return nil, ErrProtocol
	}
	return b, nil
}
func pathID(v id.ID) (string, error) {
	if v.IsZero() {
		return "", ErrInvalidConfig
	}
	return v.String(), nil
}
func equalID(a, b id.ID) bool                 { return subtle.ConstantTimeCompare(a[:], b[:]) == 1 }
func qnum(q url.Values, key string, n uint64) { q.Set(key, strconv.FormatUint(n, 10)) }
