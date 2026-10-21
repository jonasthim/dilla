package client

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/jonasthim/dilla/internal/id"
)

const maxStoredSequence uint64 = 1<<63 - 1

func (c *Client) Discover(ctx context.Context) (Discovery, error) {
	raw, _, err := c.do(ctx, "", http.MethodGet, "instance", nil, nil, MaxSmallBody, false)
	if err != nil {
		return Discovery{}, err
	}
	a, err := decode(raw, 11)
	if err != nil {
		return Discovery{}, err
	}
	var d Discovery
	d.WireVersions, err = uints(a[0])
	if err != nil {
		return d, err
	}
	if !distinctVersions(d.WireVersions) {
		return d, ErrProtocol
	}
	d.E2EEVersions, err = uints(a[1])
	if err != nil {
		return d, err
	}
	if !distinctVersions(d.E2EEVersions) {
		return d, ErrProtocol
	}
	d.MediaVersions, err = uints(a[2])
	if err != nil {
		return d, err
	}
	if !distinctVersions(d.MediaVersions) {
		return d, ErrProtocol
	}
	if d.InstanceID, _ = asID(a[3]); d.InstanceID.IsZero() {
		return d, ErrProtocol
	}
	if d.Generation, _ = asUint(a[4]); d.Generation == 0 {
		return d, ErrProtocol
	}
	var ok bool
	d.Name, ok = a[5].(string)
	if !ok || d.Name == "" {
		return d, ErrProtocol
	}
	if d.RegistrationMode, ok = asUint(a[6]); !ok || d.RegistrationMode > 2 {
		return d, ErrProtocol
	}
	d.AuthMethods, err = uints(a[7])
	if err != nil {
		return d, err
	}
	if !strictlyIncreasing(d.AuthMethods) {
		return d, ErrProtocol
	}
	if d.PolicyVersion, ok = asUint(a[8]); !ok {
		return d, ErrProtocol
	}
	if d.ExternalSenderKeyID, ok = asID(a[9]); !ok {
		return d, ErrProtocol
	}
	if d.ExternalSenderPub, ok = asBytes(a[10], 32); !ok {
		return d, ErrProtocol
	}
	d.ExternalSenderPub = append([]byte(nil), d.ExternalSenderPub...)
	if !equalID(d.InstanceID, c.instance) {
		return Discovery{}, ErrInstanceChanged
	}
	if !slices.Contains(d.WireVersions, uint64(3)) || !slices.Contains(d.E2EEVersions, uint64(1)) || !slices.Contains(d.MediaVersions, uint64(1)) {
		return Discovery{}, ErrProtocol
	}
	c.discovered.Store(true)
	return d, nil
}
func strictlyIncreasing(a []uint64) bool {
	for i := 1; i < len(a); i++ {
		if a[i] <= a[i-1] {
			return false
		}
	}
	return true
}

func (c *Client) InstanceLimits(ctx context.Context) (Limits, error) {
	var out Limits
	raw, _, err := c.do(ctx, "", http.MethodGet, "instance/limits", nil, nil, MaxSmallBody, false)
	if err != nil {
		return out, err
	}
	a, err := decode(raw, 11)
	if err != nil {
		return out, err
	}
	for i, v := range a {
		n, ok := asUint(v)
		if !ok {
			return Limits{}, ErrProtocol
		}
		out.Values[i] = n
	}
	return out, nil
}
func uints(v any) ([]uint64, error) {
	a, ok := v.([]any)
	if !ok {
		return nil, ErrProtocol
	}
	out := make([]uint64, len(a))
	for i, x := range a {
		n, ok := asUint(x)
		if !ok {
			return nil, ErrProtocol
		}
		out[i] = n
	}
	return out, nil
}

func (r *Runtime) ListInstallationsPage(ctx context.Context, after *id.ID) ([]Installation, error) {
	q := url.Values{}
	if after != nil {
		s, e := pathID(*after)
		if e != nil {
			return nil, e
		}
		q.Set("after", s)
	}
	raw, _, err := r.c.do(ctx, r.token, http.MethodGet, "bot-runtime/installations", q, nil, MaxSmallBody, false)
	if err != nil {
		return nil, err
	}
	a, err := decode(raw, -1)
	if err != nil {
		return nil, err
	}
	if len(a) > 100 {
		return nil, ErrProtocol
	}
	out := make([]Installation, len(a))
	var prev id.ID
	for i, v := range a {
		row, ok := v.([]any)
		if !ok || len(row) != 8 {
			return nil, ErrProtocol
		}
		out[i], err = parseInstallation(row)
		if err != nil {
			return nil, err
		}
		if i > 0 && strings.Compare(prev.String(), out[i].ID.String()) >= 0 {
			return nil, ErrProtocol
		}
		if after != nil && i == 0 && strings.Compare(after.String(), out[i].ID.String()) >= 0 {
			return nil, ErrProtocol
		}
		prev = out[i].ID
	}
	return out, nil
}
func (r *Runtime) ListInstallations(ctx context.Context) ([]Installation, error) {
	ctx, cancel := r.c.aggregateContext(ctx)
	defer cancel()
	var out []Installation
	var cursor *id.ID
	seen := map[id.ID]struct{}{}
	for {
		page, err := r.ListInstallationsPage(ctx, cursor)
		if err != nil {
			return nil, err
		}
		if len(out)+len(page) > MaxAggregateRows {
			return nil, ErrPageLimit
		}
		for _, x := range page {
			if _, ok := seen[x.ID]; ok {
				return nil, ErrProtocol
			}
			seen[x.ID] = struct{}{}
			out = append(out, x)
		}
		if len(page) < 100 {
			return out, nil
		}
		last := page[len(page)-1].ID
		cursor = &last
	}
}
func parseInstallation(a []any) (Installation, error) {
	var x Installation
	var ok bool
	if x.ID, ok = asID(a[0]); !ok {
		return x, ErrProtocol
	}
	if x.CommunityID, ok = asID(a[1]); !ok {
		return x, ErrProtocol
	}
	if x.State, ok = asUint(a[2]); !ok {
		return x, ErrProtocol
	}
	if x.Revision, ok = asUint(a[3]); !ok {
		return x, ErrProtocol
	}
	parseNullableID := func(v any) (*id.ID, bool) {
		if v == nil {
			return nil, true
		}
		i, ok := asID(v)
		return &i, ok
	}
	if x.BotUser, ok = parseNullableID(a[4]); !ok {
		return x, ErrProtocol
	}
	if x.BotDevice, ok = parseNullableID(a[5]); !ok {
		return x, ErrProtocol
	}
	if x.Capabilities, ok = asUint(a[6]); !ok {
		return x, ErrProtocol
	}
	if x.UpdatedAt, ok = asUint(a[7]); !ok {
		return x, ErrProtocol
	}
	return x, nil
}
func (r *Runtime) Claim(ctx context.Context, installation, request id.ID) (Claim, error) {
	var out Claim
	i, e := pathID(installation)
	if e != nil {
		return out, e
	}
	if request.IsZero() {
		return out, ErrInvalidConfig
	}
	b, e := encode([]any{request})
	if e != nil {
		return out, e
	}
	raw, _, e := r.c.do(ctx, r.token, http.MethodPost, "bot-runtime/installations/"+i+"/claim", nil, b, MaxSmallBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return out, &APIError{Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown}
	}
	var ok bool
	if out.InstallationID, ok = asID(a[0]); !ok {
		return out, unknown()
	}
	if out.ClaimID, ok = asID(a[1]); !ok {
		return out, unknown()
	}
	if out.Expires, ok = asUint(a[2]); !ok || !equalID(out.InstallationID, installation) {
		return out, unknown()
	}
	return out, nil
}
func (r *Runtime) Enroll(ctx context.Context, installation, request, claim id.ID, umk, ssk, sig []byte, device DeviceRegistration) (Enrollment, error) {
	var out Enrollment
	i, e := pathID(installation)
	if e != nil {
		return out, e
	}
	if request.IsZero() || claim.IsZero() || len(umk) != 32 || len(ssk) != 32 || len(sig) != 64 || device.DeviceID.IsZero() || len(device.DSKPub) != 32 || device.Tier != 0 || device.SignerTier != 0 || len(device.Credential) == 0 || len(device.Credential) > 2048 {
		return out, ErrInvalidConfig
	}
	b, e := encode([]any{request, claim, umk, ssk, sig, []any{device.DeviceID, device.DSKPub, device.Tier, device.SignerTier, device.Credential}})
	if e != nil {
		return out, e
	}
	raw, _, e := r.c.do(ctx, r.token, http.MethodPost, "bot-runtime/installations/"+i+"/enroll", nil, b, MaxRuntimeBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.BotUser, ok = asID(a[0]); !ok {
		return out, unknown()
	}
	if out.BotDevice, ok = asID(a[1]); !ok || !equalID(out.BotDevice, device.DeviceID) {
		return out, unknown()
	}
	out.Username, ok = a[2].(string)
	if !ok || out.Username == "" {
		return Enrollment{}, unknown()
	}
	return out, nil
}

func (c *Client) Challenge(ctx context.Context, device id.ID) (SessionChallenge, error) {
	var out SessionChallenge
	s, e := pathID(device)
	if e != nil {
		return out, e
	}
	b, e := encode([]any{})
	if e != nil {
		return out, e
	}
	raw, _, e := c.do(ctx, "", http.MethodPost, "devices/"+s+"/sessions/challenge", nil, b, MaxSmallBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 2)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.Nonce, ok = asBytes(a[0], 32); !ok {
		return out, unknown()
	}
	out.Nonce = append([]byte(nil), out.Nonce...)
	if out.Expires, ok = asUint(a[1]); !ok {
		return SessionChallenge{}, unknown()
	}
	return out, nil
}

// EstablishSession submits a normal device proof. The signature is produced by
// the native helper over the protocol/02 session preimage and is never logged.
func (c *Client) EstablishSession(ctx context.Context, device id.ID, nonce []byte, purpose uint64, signature []byte, registration any, login []byte) (DeviceSession, error) {
	var out DeviceSession
	s, e := pathID(device)
	if e != nil {
		return out, e
	}
	if len(nonce) != 32 || len(signature) != 64 || purpose > 2 {
		return out, ErrInvalidConfig
	}
	b, e := encode([]any{nonce, purpose, signature, registration, login})
	if e != nil {
		return out, e
	}
	raw, _, e := c.do(ctx, "", http.MethodPost, "devices/"+s+"/sessions", nil, b, MaxSessionBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 7)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.Token, ok = a[0].(string); !ok || out.Token == "" {
		return out, unknown()
	}
	if out.Scope, ok = asUint(a[1]); !ok || out.Scope != 0 {
		return out, unknown()
	}
	if out.UserID, ok = asID(a[2]); !ok {
		return out, unknown()
	}
	if out.DeviceID, ok = asID(a[3]); !ok || !equalID(out.DeviceID, device) {
		return out, unknown()
	}
	if out.Expires, ok = asUint(a[4]); !ok {
		return out, unknown()
	}
	if out.IdleExpires, ok = asUint(a[5]); !ok {
		return out, unknown()
	}
	if out.Generation, ok = asUint(a[6]); !ok {
		return out, unknown()
	}
	return out, nil
}
func (s *Session) Negotiate(ctx context.Context, wire, e2ee, media []uint64) (Negotiated, error) {
	var out Negotiated
	if !distinctVersions(wire) || !distinctVersions(e2ee) || !distinctVersions(media) {
		return out, ErrInvalidConfig
	}
	b, e := encode([]any{wire, e2ee, media})
	if e != nil {
		return out, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodPost, "sessions/negotiate", nil, b, MaxSmallBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.Wire, ok = asUint(a[0]); !ok || out.Wire != 3 {
		return Negotiated{}, unknown()
	}
	if out.E2EE, ok = asUint(a[1]); !ok || out.E2EE != 1 {
		return Negotiated{}, unknown()
	}
	if out.Media, ok = asUint(a[2]); !ok || out.Media != 1 {
		return Negotiated{}, unknown()
	}
	return out, nil
}
func distinctVersions(a []uint64) bool {
	if len(a) == 0 || len(a) > 8 {
		return false
	}
	m := map[uint64]bool{}
	for _, n := range a {
		if n == 0 || m[n] {
			return false
		}
		m[n] = true
	}
	return true
}

func (s *Session) FinalizeCredential(ctx context.Context, installation, request id.ID, revision uint64, credential []byte) (Installation, error) {
	return s.installationMutation(ctx, installation, "credential", request, revision, credential, true)
}
func (s *Session) MarkReady(ctx context.Context, installation, request id.ID, revision uint64) (Installation, error) {
	return s.installationMutation(ctx, installation, "ready", request, revision, nil, false)
}
func (s *Session) installationMutation(ctx context.Context, installation id.ID, action string, request id.ID, revision uint64, credential []byte, put bool) (Installation, error) {
	var out Installation
	i, e := pathID(installation)
	if e != nil {
		return out, e
	}
	if request.IsZero() {
		return out, ErrInvalidConfig
	}
	var body []byte
	if put {
		if len(credential) == 0 || len(credential) > 8192 {
			return out, ErrInvalidConfig
		}
		body, e = encode([]any{request, revision, credential})
	} else {
		body, e = encode([]any{request, revision})
	}
	if e != nil {
		return out, e
	}
	method := http.MethodPost
	if put {
		method = http.MethodPut
	}
	path := "bot-runtime/installations/" + i + "/" + action
	raw, _, e := s.c.do(ctx, s.token, method, path, nil, body, MaxRuntimeBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 8)
	if e != nil {
		return out, unknown()
	}
	out, e = parseInstallation(a)
	if e != nil || !equalID(out.ID, installation) {
		return Installation{}, unknown()
	}
	return out, nil
}

func unknown() error { return &APIError{Code: "E_OUTCOME_UNKNOWN", Outcome: OutcomeUnknown} }

// PublishDeviceList sends the helper-produced signed outer list unchanged.
func (s *Session) PublishDeviceList(ctx context.Context, user id.ID, version uint64, blob, signature, previousHash []byte) error {
	u, e := pathID(user)
	if e != nil {
		return e
	}
	if version == 0 || len(blob) == 0 || len(blob) > MaxSmallBody || len(signature) != 64 || len(previousHash) != 32 {
		return ErrInvalidConfig
	}
	b, e := encode([]any{version, blob, signature, previousHash})
	if e != nil {
		return e
	}
	_, _, e = s.c.do(ctx, s.token, http.MethodPut, "users/"+u+"/device-list", nil, b, MaxSmallBody, true)
	return e
}
func (s *Session) OwnDeviceList(ctx context.Context, user id.ID) ([]byte, error) {
	u, e := pathID(user)
	if e != nil {
		return nil, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "users/"+u+"/device-list", nil, nil, MaxSmallBody, false)
	if e != nil {
		return nil, e
	}
	a, decodeErr := decode(raw, 4)
	if decodeErr != nil {
		return nil, decodeErr
	}
	if _, ok := asUint(a[0]); !ok {
		return nil, ErrProtocol
	}
	if _, ok := asBytes(a[1], -1); !ok {
		return nil, ErrProtocol
	}
	if _, ok := asBytes(a[2], 64); !ok {
		return nil, ErrProtocol
	}
	if _, ok := asBytes(a[3], 32); !ok {
		return nil, ErrProtocol
	}
	return raw, nil
}

func (s *Session) DeviceListHistory(ctx context.Context, user id.ID, after uint64) ([][]any, error) {
	u, e := pathID(user)
	if e != nil {
		return nil, e
	}
	if after > maxStoredSequence {
		return nil, ErrInvalidConfig
	}
	q := url.Values{}
	qnum(q, "after", after)
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "users/"+u+"/device-list", q, nil, MaxBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, -1)
	if e != nil || len(a) > 64 {
		return nil, ErrProtocol
	}
	rows := make([][]any, len(a))
	var last uint64
	for i, value := range a {
		row, ok := value.([]any)
		if !ok || len(row) != 4 {
			return nil, ErrProtocol
		}
		version, ok := asUint(row[0])
		if !ok || version <= after || i > 0 && version <= last {
			return nil, ErrProtocol
		}
		if _, ok := asBytes(row[1], -1); !ok {
			return nil, ErrProtocol
		}
		if _, ok := asBytes(row[2], 64); !ok {
			return nil, ErrProtocol
		}
		if _, ok := asBytes(row[3], 32); !ok {
			return nil, ErrProtocol
		}
		last, rows[i] = version, row
	}
	return rows, nil
}

func (s *Session) PublishKeyPackages(ctx context.Context, packages [][]byte, lastResort []byte) (uint64, error) {
	if len(packages) == 0 {
		return 0, ErrInvalidConfig
	}
	b, e := encode([]any{packages, lastResort})
	if e != nil {
		return 0, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodPost, "keypackages", nil, b, MaxDSBody, true)
	if e != nil {
		return 0, e
	}
	a, e := decode(raw, 1)
	if e != nil {
		return 0, unknown()
	}
	n, ok := asUint(a[0])
	if !ok || n > uint64(len(packages)) {
		return 0, unknown()
	}
	return n, nil
}
func (s *Session) KeyPackage(ctx context.Context, device id.ID) ([]byte, error) {
	d, e := pathID(device)
	if e != nil {
		return nil, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "devices/"+d+"/keypackage", nil, nil, MaxDSBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return nil, e
	}
	if _, ok := asBytes(a[0], -1); !ok {
		return nil, ErrProtocol
	}
	if n, ok := asUint(a[1]); !ok || n > 1 {
		return nil, ErrProtocol
	}
	if _, ok := asBytes(a[2], -1); !ok {
		return nil, ErrProtocol
	}
	return raw, nil
}
func (s *Session) Welcomes(ctx context.Context, after uint64, limit uint64) ([]Welcome, error) {
	if limit == 0 || limit > 64 {
		return nil, ErrInvalidConfig
	}
	if after > maxStoredSequence {
		return nil, ErrInvalidConfig
	}
	q := url.Values{}
	qnum(q, "after", after)
	qnum(q, "limit", limit)
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "welcomes", q, nil, MaxBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, -1)
	if e != nil {
		return nil, e
	}
	if uint64(len(a)) > limit {
		return nil, ErrProtocol
	}
	out := make([]Welcome, len(a))
	last := after
	for i, row := range a {
		v, ok := row.([]any)
		if !ok || len(v) != 7 {
			return nil, ErrProtocol
		}
		if out[i].ID, ok = asUint(v[0]); !ok || out[i].ID == 0 || out[i].ID <= last {
			return nil, ErrProtocol
		}
		last = out[i].ID
		if out[i].GroupID, ok = asID(v[1]); !ok {
			return nil, ErrProtocol
		}
		if out[i].Epoch, ok = asUint(v[2]); !ok {
			return nil, ErrProtocol
		}
		if out[i].CommitSequence, ok = asUint(v[3]); !ok {
			return nil, ErrProtocol
		}
		if out[i].Blob, ok = asBytes(v[4], -1); !ok {
			return nil, ErrProtocol
		}
		if out[i].Tree, ok = asBytes(v[5], -1); !ok {
			return nil, ErrProtocol
		}
		if out[i].TreeHash, ok = asBytes(v[6], 32); !ok {
			return nil, ErrProtocol
		}
	}
	return out, nil
}
func (s *Session) AllWelcomes(ctx context.Context, limit uint64) ([]Welcome, error) {
	if limit == 0 || limit > 64 {
		return nil, ErrInvalidConfig
	}
	ctx, cancel := s.c.aggregateContext(ctx)
	defer cancel()
	var all []Welcome
	var after uint64
	for {
		page, err := s.Welcomes(ctx, after, limit)
		if err != nil {
			return nil, err
		}
		if len(all)+len(page) > MaxAggregateRows {
			return nil, ErrPageLimit
		}
		all = append(all, page...)
		if uint64(len(page)) < limit {
			return all, nil
		}
		if len(page) == 0 || page[len(page)-1].ID <= after {
			return nil, ErrProtocol
		}
		after = page[len(page)-1].ID
	}
}
func (s *Session) AcknowledgeWelcome(ctx context.Context, welcome uint64) error {
	if welcome == 0 || welcome > maxStoredSequence {
		return ErrInvalidConfig
	}
	_, _, e := s.c.do(ctx, s.token, http.MethodDelete, "welcomes/"+strconv.FormatUint(welcome, 10), nil, nil, MaxSmallBody, true)
	return e
}

func (s *Session) GroupInfo(ctx context.Context, group id.ID) (GroupInfo, error) {
	var out GroupInfo
	g, e := pathID(group)
	if e != nil {
		return out, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "groups/"+g+"/info", nil, nil, MaxBody, false)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 4)
	if e != nil {
		return out, e
	}
	var ok bool
	if out.Epoch, ok = asUint(a[0]); !ok {
		return out, ErrProtocol
	}
	if out.Info, ok = asBytes(a[1], -1); !ok {
		return out, ErrProtocol
	}
	if out.TreeHash, ok = asBytes(a[2], 32); !ok {
		return out, ErrProtocol
	}
	if out.NextSequence, ok = asUint(a[3]); !ok {
		return out, ErrProtocol
	}
	return out, nil
}
func (s *Session) GroupTree(ctx context.Context, group id.ID) (GroupTree, error) {
	var out GroupTree
	g, e := pathID(group)
	if e != nil {
		return out, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "groups/"+g+"/tree", nil, nil, MaxBody, false)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return out, e
	}
	var ok bool
	if out.Epoch, ok = asUint(a[0]); !ok {
		return out, ErrProtocol
	}
	if out.Tree, ok = asBytes(a[1], -1); !ok {
		return out, ErrProtocol
	}
	if out.TreeHash, ok = asBytes(a[2], 32); !ok {
		return out, ErrProtocol
	}
	return out, nil
}
func (s *Session) RegisterGroup(ctx context.Context, group id.ID, binding, info, tree []byte) (uint64, error) {
	_, e := pathID(group)
	if e != nil {
		return 0, e
	}
	if len(binding) == 0 || len(info) == 0 || len(tree) == 0 {
		return 0, ErrInvalidConfig
	}
	b, e := encode([]any{group, binding, info, tree})
	if e != nil {
		return 0, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodPost, "groups", nil, b, MaxDSBody, true)
	if e != nil {
		return 0, e
	}
	a, e := decode(raw, 2)
	if e != nil {
		return 0, unknown()
	}
	got, ok := asID(a[0])
	if !ok || !equalID(got, group) {
		return 0, unknown()
	}
	n, ok := asUint(a[1])
	if !ok {
		return 0, unknown()
	}
	return n, nil
}
func (s *Session) GroupPage(ctx context.Context, group id.ID, kind string, from, limit uint64) (Page, error) {
	var out Page
	if kind != "messages" && kind != "handshakes" {
		return out, ErrInvalidConfig
	}
	g, e := pathID(group)
	if e != nil {
		return out, e
	}
	if limit == 0 || limit > 256 || from > maxStoredSequence {
		return out, ErrInvalidConfig
	}
	q := url.Values{}
	qnum(q, "from", from)
	qnum(q, "limit", limit)
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "groups/"+g+"/"+kind, q, nil, MaxBody, false)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, -1)
	if e != nil {
		return out, e
	}
	if uint64(len(a)) > limit {
		return out, ErrProtocol
	}
	out.Rows = make([][]any, len(a))
	var prev uint64
	for i, row := range a {
		v, ok := row.([]any)
		want := 9
		if kind == "handshakes" {
			want = 5
		}
		if !ok || len(v) != want {
			return Page{}, ErrProtocol
		}
		seq, ok := asUint(v[0])
		if !ok || seq <= prev || seq < from || seq > maxStoredSequence {
			return Page{}, ErrProtocol
		}
		if kind == "messages" {
			if _, ok = asUint(v[1]); !ok {
				return Page{}, ErrProtocol
			}
			if _, ok = asID(v[2]); !ok {
				return Page{}, ErrProtocol
			}
			if v[3] != nil {
				if _, ok = asBytes(v[3], -1); !ok {
					return Page{}, ErrProtocol
				}
			}
			if v[4] != nil {
				if _, ok = asBytes(v[4], -1); !ok {
					return Page{}, ErrProtocol
				}
			}
			if _, ok = asBytes(v[5], 32); !ok {
				return Page{}, ErrProtocol
			}
			if _, ok = asUint(v[6]); !ok {
				return Page{}, ErrProtocol
			}
			if n, yes := asUint(v[7]); !yes || n > 1 {
				return Page{}, ErrProtocol
			}
			if v[8] != nil {
				if n, yes := asUint(v[8]); !yes || n > 1 {
					return Page{}, ErrProtocol
				}
			}
		} else {
			if _, ok = asUint(v[1]); !ok {
				return Page{}, ErrProtocol
			}
			if n, yes := asUint(v[2]); !yes || n > 2 {
				return Page{}, ErrProtocol
			}
			if v[3] != nil {
				if n, yes := asUint(v[3]); !yes || n > 1<<32-1 {
					return Page{}, ErrProtocol
				}
			}
			if _, ok = asBytes(v[4], -1); !ok {
				return Page{}, ErrProtocol
			}
		}
		prev = seq
		out.Rows[i] = v
	}
	out.Next = from
	if len(a) > 0 {
		if prev == ^uint64(0) {
			return Page{}, ErrProtocol
		}
		out.Next = prev + 1
	}
	return out, nil
}

func (s *Session) AllGroupPages(ctx context.Context, group id.ID, kind string, from, limit uint64) ([][]any, error) {
	if limit == 0 {
		return nil, ErrInvalidConfig
	}
	ctx, cancel := s.c.aggregateContext(ctx)
	defer cancel()
	var all [][]any
	cursor := from
	for {
		page, err := s.GroupPage(ctx, group, kind, cursor, limit)
		if err != nil {
			return nil, err
		}
		if len(all)+len(page.Rows) > MaxAggregateRows {
			return nil, ErrPageLimit
		}
		all = append(all, page.Rows...)
		if uint64(len(page.Rows)) < limit {
			return all, nil
		}
		if len(page.Rows) == 0 || page.Next <= cursor {
			return nil, ErrProtocol
		}
		if page.Next > maxStoredSequence {
			return all, nil
		}
		cursor = page.Next
	}
}
func (s *Session) Proposals(ctx context.Context, group id.ID) ([][]any, error) {
	g, e := pathID(group)
	if e != nil {
		return nil, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "groups/"+g+"/proposals", nil, nil, MaxBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, -1)
	if e != nil {
		return nil, e
	}
	out := make([][]any, len(a))
	refs := map[string]bool{}
	for i, row := range a {
		v, ok := row.([]any)
		if !ok || len(v) != 5 {
			return nil, ErrProtocol
		}
		ref, ok := asBytes(v[0], -1)
		if !ok || len(ref) == 0 || refs[string(ref)] {
			return nil, ErrProtocol
		}
		refs[string(ref)] = true
		out[i] = v
	}
	return out, nil
}

// HealStatus reports whether this server generation needs the client's post-restore snapshot.
func (s *Session) HealStatus(ctx context.Context, group id.ID) (HealStatus, error) {
	var out HealStatus
	g, err := pathID(group)
	if err != nil {
		return out, err
	}
	raw, _, err := s.c.do(ctx, s.token, http.MethodGet, "groups/"+g+"/heal", nil, nil, MaxSmallBody, false)
	if err != nil {
		return out, err
	}
	a, err := decode(raw, 4)
	if err != nil {
		return out, err
	}
	values := []*uint64{&out.Epoch, &out.NextSequence, &out.Generation, &out.NeedFromSequence}
	for i, v := range values {
		n, ok := asUint(a[i])
		if !ok {
			return HealStatus{}, ErrProtocol
		}
		*v = n
	}
	return out, nil
}

// Heal uploads a client-authenticated snapshot and its bounded handshake tail after a restore.
// Each tail row is [sequence, epoch, kind, sender-or-null, blob].
func (s *Session) Heal(ctx context.Context, group id.ID, groupInfo []byte, tail [][]any, ratchetTree []byte) (HealResult, error) {
	var out HealResult
	if len(groupInfo) == 0 || len(tail) > 64 {
		return out, ErrInvalidConfig
	}
	for _, row := range tail {
		if len(row) != 5 {
			return out, ErrInvalidConfig
		}
		if _, ok := asUint(row[0]); !ok {
			return out, ErrInvalidConfig
		}
		if _, ok := asUint(row[1]); !ok {
			return out, ErrInvalidConfig
		}
		kind, ok := asUint(row[2])
		if !ok || kind > 255 {
			return out, ErrInvalidConfig
		}
		if row[3] != nil {
			sender, ok := asUint(row[3])
			if !ok || sender > 1<<32-1 {
				return out, ErrInvalidConfig
			}
		}
		blob, ok := asBytes(row[4], -1)
		if !ok || len(blob) == 0 {
			return out, ErrInvalidConfig
		}
	}
	g, err := pathID(group)
	if err != nil {
		return out, err
	}
	b, err := encode([]any{groupInfo, tail, nullableBytes(ratchetTree)})
	if err != nil {
		return out, err
	}
	raw, _, err := s.c.do(ctx, s.token, http.MethodPost, "groups/"+g+"/heal", nil, b, MaxDSBody, true)
	if err != nil {
		return out, err
	}
	a, err := decode(raw, 2)
	if err != nil {
		return out, unknown()
	}
	if out.Epoch, _ = asUint(a[0]); a[0] == nil {
		return HealResult{}, unknown()
	}
	if out.NextSequence, _ = asUint(a[1]); a[1] == nil {
		return HealResult{}, unknown()
	}
	if _, ok := asUint(a[0]); !ok {
		return HealResult{}, unknown()
	}
	if _, ok := asUint(a[1]); !ok {
		return HealResult{}, unknown()
	}
	return out, nil
}

// ForkReport records an authenticated divergence report. It is accepted with HTTP 202 and [];
// callers must not retry when the outcome is unknown.
func (s *Session) ForkReport(ctx context.Context, group id.ID, epoch, sequence uint64, reason string) error {
	if reason == "" {
		return ErrInvalidConfig
	}
	g, err := pathID(group)
	if err != nil {
		return err
	}
	b, err := encode([]any{epoch, sequence, reason})
	if err != nil {
		return err
	}
	raw, _, err := s.c.do(ctx, s.token, http.MethodPost, "groups/"+g+"/fork-report", nil, b, MaxSmallBody, true)
	if err != nil {
		return err
	}
	a, err := decode(raw, 0)
	if err != nil {
		return unknown()
	}
	_ = a
	return nil
}

func nullableBytes(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}
func (s *Session) Commit(ctx context.Context, group id.ID, epoch uint64, commit, info []byte, welcomes [][]any, tree []byte) (SequenceResult, error) {
	if len(commit) == 0 || len(info) == 0 || len(welcomes) > 256 {
		return SequenceResult{}, ErrInvalidConfig
	}
	seen := make(map[id.ID]bool, len(welcomes))
	for _, w := range welcomes {
		if len(w) != 2 {
			return SequenceResult{}, ErrInvalidConfig
		}
		device, ok := w[0].(id.ID)
		if !ok || device.IsZero() {
			return SequenceResult{}, ErrInvalidConfig
		}
		if seen[device] {
			return SequenceResult{}, ErrInvalidConfig
		}
		seen[device] = true
		if _, ok := w[1].([]byte); !ok {
			return SequenceResult{}, ErrInvalidConfig
		}
	}
	return s.groupMutation(ctx, group, "commit", []any{epoch, commit, info, welcomes, tree}, true)
}
func (s *Session) Proposal(ctx context.Context, group id.ID, epoch uint64, proposal []byte) (uint64, error) {
	if len(proposal) == 0 {
		return 0, ErrInvalidConfig
	}
	res, e := s.groupMutation(ctx, group, "proposal", []any{epoch, proposal}, false)
	return res.Sequence, e
}
func (s *Session) Resync(ctx context.Context, group id.ID, commit, info []byte) (SequenceResult, error) {
	if len(commit) == 0 || len(info) == 0 {
		return SequenceResult{}, ErrInvalidConfig
	}
	return s.groupMutation(ctx, group, "resync", []any{commit, info}, true)
}

func (s *Session) SendMessage(ctx context.Context, group id.ID, epoch uint64, ciphertext []byte, class uint64) (MessageResult, error) {
	var out MessageResult
	if len(ciphertext) == 0 || class > 1 {
		return out, ErrInvalidConfig
	}
	g, e := pathID(group)
	if e != nil {
		return out, e
	}
	b, e := encode([]any{epoch, ciphertext, class})
	if e != nil {
		return out, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodPost, "groups/"+g+"/message", nil, b, MaxDSBody, true)
	if e != nil {
		return out, e
	}
	a, e := decode(raw, 3)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.Sequence, ok = asUint(a[0]); !ok {
		return MessageResult{}, unknown()
	}
	if out.FrankingTag, ok = asBytes(a[1], 32); !ok {
		return MessageResult{}, unknown()
	}
	if out.ReceivedAt, ok = asUint(a[2]); !ok {
		return MessageResult{}, unknown()
	}
	return out, nil
}
func (s *Session) groupMutation(ctx context.Context, group id.ID, action string, payload []any, two bool) (SequenceResult, error) {
	var out SequenceResult
	g, e := pathID(group)
	if e != nil {
		return out, e
	}
	b, e := encode(payload)
	if e != nil {
		return out, e
	}
	max := int64(MaxBody)
	if action == "commit" {
		max = MaxCommitBody
	} else {
		max = MaxDSBody
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodPost, "groups/"+g+"/"+action, nil, b, max, true)
	if e != nil {
		return out, e
	}
	n := 2
	if !two {
		n = 1
	}
	a, e := decode(raw, n)
	if e != nil {
		return out, unknown()
	}
	var ok bool
	if out.Sequence, ok = asUint(a[0]); !ok {
		return SequenceResult{}, unknown()
	}
	if two {
		if out.Epoch, ok = asUint(a[1]); !ok {
			return SequenceResult{}, unknown()
		}
	}
	return out, nil
}
func (s *Session) AdvanceCursor(ctx context.Context, group id.ID, sequence, epoch uint64) error {
	g, e := pathID(group)
	if e != nil {
		return e
	}
	if sequence > maxStoredSequence {
		return ErrInvalidConfig
	}
	b, e := encode([]any{sequence, epoch})
	if e != nil {
		return e
	}
	_, _, e = s.c.do(ctx, s.token, http.MethodPost, "groups/"+g+"/cursor", nil, b, MaxSmallBody, true)
	return e
}

func (s *Session) Communities(ctx context.Context) ([]Community, error) {
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "communities", nil, nil, MaxBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, -1)
	if e != nil {
		return nil, e
	}
	out := make([]Community, len(a))
	seen := map[id.ID]bool{}
	for i, row := range a {
		v, ok := row.([]any)
		if !ok || len(v) != 4 {
			return nil, ErrProtocol
		}
		cid, ok := asID(v[0])
		if !ok || seen[cid] {
			return nil, ErrProtocol
		}
		name, ok := v[1].(string)
		if !ok || name == "" {
			return nil, ErrProtocol
		}
		owner, ok := asID(v[2])
		if !ok {
			return nil, ErrProtocol
		}
		policy, ok := asUint(v[3])
		if !ok {
			return nil, ErrProtocol
		}
		seen[cid] = true
		out[i] = Community{ID: cid, Name: name, OwnerID: owner, PolicyVersion: policy}
	}
	return out, nil
}
func (s *Session) Channels(ctx context.Context, community id.ID) ([]Channel, error) {
	c, e := pathID(community)
	if e != nil {
		return nil, e
	}
	raw, _, e := s.c.do(ctx, s.token, http.MethodGet, "communities/"+c+"/channels", nil, nil, MaxBody, false)
	if e != nil {
		return nil, e
	}
	a, e := decode(raw, -1)
	if e != nil {
		return nil, e
	}
	out := make([]Channel, len(a))
	seen := map[id.ID]bool{}
	for i, row := range a {
		v, ok := row.([]any)
		if !ok || len(v) != 11 {
			return nil, ErrProtocol
		}
		cid, ok := asID(v[0])
		if !ok || seen[cid] {
			return nil, ErrProtocol
		}
		ch := Channel{ID: cid, CommunityID: community}
		if ch.Kind, ok = asUint(v[1]); !ok {
			return nil, ErrProtocol
		}
		if ch.Mode, ok = asUint(v[2]); !ok {
			return nil, ErrProtocol
		}
		if ch.Visibility, ok = asUint(v[3]); !ok {
			return nil, ErrProtocol
		}
		if ch.ParentID, ok = nullableID(v[4]); !ok {
			return nil, ErrProtocol
		}
		if ch.Name, ok = v[5].(string); !ok {
			return nil, ErrProtocol
		}
		if ch.Topic, ok = v[6].(string); !ok {
			return nil, ErrProtocol
		}
		if ch.Position, ok = asUint(v[7]); !ok {
			return nil, ErrProtocol
		}
		if ch.Slowmode, ok = asUint(v[8]); !ok {
			return nil, ErrProtocol
		}
		if ch.Sequence, ok = asUint(v[9]); !ok {
			return nil, ErrProtocol
		}
		if ch.TextGroupID, ok = nullableID(v[10]); !ok {
			return nil, ErrProtocol
		}
		seen[cid] = true
		out[i] = ch
	}
	return out, nil
}

func nullableID(v any) (*id.ID, bool) {
	if v == nil {
		return nil, true
	}
	x, ok := asID(v)
	return &x, ok
}
