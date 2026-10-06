package api_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func communityEnv(t *testing.T) *env {
	t.Helper()
	e := newEnv(t)
	log := slog.New(slog.DiscardHandler)
	api.NewCommunities(e.Repo, e.DS, e.Clk, log).Register(e.Mux)
	// Task 1 ships api.Roles with only the grant route; task 3 adds the other six.
	// Without this registration the mux answers 404, not 403, to the 2FA test below.
	api.NewRoles(e.Repo, e.Clk, "dilla.example", log).Register(e.Mux)
	return e
}

func TestCreateCommunityMakesCreatorOwnerAndMember(t *testing.T) {
	e := communityEnv(t)
	owner, tok := e.NewUser("owner")

	status, body := e.Do(http.MethodPost, "/v1/communities", tok,
		[]any{"Kryptering", []byte(`{"retention_days":0}`), uint64(0), uint64(0)})
	if status != http.StatusCreated {
		t.Fatalf("POST /v1/communities = %d, body %x", status, body)
	}
	var created []cbor.RawMessage
	if err := cborx.Unmarshal(body, &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(created) != 3 {
		t.Fatalf("response has %d elements, want 3", len(created))
	}
	var cid, everyone id.ID
	var version uint64
	mustUnmarshal(t, created[0], &cid)
	mustUnmarshal(t, created[1], &everyone)
	mustUnmarshal(t, created[2], &version)
	if version != 1 {
		t.Fatalf("policy_version = %d, want 1", version)
	}

	got, err := e.Repo.GetCommunity(t.Context(), cid)
	if err != nil {
		t.Fatalf("GetCommunity: %v", err)
	}
	if got.Owner != owner {
		t.Fatalf("owner = %x, want %x", got.Owner, owner)
	}
	members, err := e.Repo.ListMembersOfCommunity(t.Context(), cid, id.ID{}, 10)
	if err != nil {
		t.Fatalf("ListMembersOfCommunity: %v", err)
	}
	if len(members) != 1 || members[0].UserID != owner {
		t.Fatalf("members = %+v, want just the owner", members)
	}
	roles, err := e.Repo.ListRoles(t.Context(), cid)
	if err != nil {
		t.Fatalf("ListRoles: %v", err)
	}
	if len(roles) != 1 || roles[0].ID != everyone || roles[0].Position != 0 || roles[0].Name != "@everyone" {
		t.Fatalf("roles = %+v, want one @everyone at position 0", roles)
	}
}

func TestPolicyRoundTripBumpsVersion(t *testing.T) {
	e := communityEnv(t)
	_, tok := e.NewUser("owner")
	cid := createCommunity(t, e, tok)

	status, body := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), tok,
		[]any{nil, []byte(`{"retention_days":30}`), nil, nil})
	if status != http.StatusOK {
		t.Fatalf("PATCH = %d (%x)", status, body)
	}
	var patched []uint64
	if err := cborx.Unmarshal(body, &patched); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if patched[0] != 2 {
		t.Fatalf("policy_version = %d, want 2", patched[0])
	}

	got, err := e.Repo.GetCommunity(t.Context(), cid)
	if err != nil {
		t.Fatalf("GetCommunity: %v", err)
	}
	if string(got.PolicyJSON) != `{"retention_days":30}` || got.PolicyVersion != 2 {
		t.Fatalf("stored = %+v", got)
	}

	// A PATCH that does not carry a policy does not bump the version.
	if status, _ := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), tok,
		[]any{"Renamed", nil, nil, nil}); status != http.StatusOK {
		t.Fatalf("PATCH name = %d", status)
	}
	got, _ = e.Repo.GetCommunity(t.Context(), cid)
	if got.PolicyVersion != 2 || got.Name != "Renamed" {
		t.Fatalf("after rename = %+v", got)
	}
}

func TestJoinBelowMinAccountAgeIsForbidden(t *testing.T) {
	e := communityEnv(t)
	_, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)

	// Require a 7-day-old account.
	if status, _ := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), ownerTok,
		[]any{nil, nil, uint64(7 * 24 * 3600), nil}); status != http.StatusOK {
		t.Fatal("PATCH min_account_age_seconds failed")
	}

	_, newTok := e.NewUser("fresh") // created at e.Clk.Now()
	status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", newTok, []any{nil})
	if status != http.StatusForbidden {
		t.Fatalf("join = %d, want 403", status)
	}
	if code := e.ErrCode(body); code != "E_FORBIDDEN" {
		t.Fatalf("code = %s, want E_FORBIDDEN", code)
	}

	e.Clk.Advance(8 * 24 * time.Hour)
	if status, body := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", newTok, []any{nil}); status != http.StatusOK {
		t.Fatalf("join after ageing = %d (%x)", status, body)
	}
}

func TestRequireMod2FARefusesRoleGrantWithoutASecondFactor(t *testing.T) {
	e := communityEnv(t)
	_, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)
	if status, _ := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), ownerTok,
		[]any{nil, nil, nil, uint64(1)}); status != http.StatusOK {
		t.Fatal("PATCH require_mod_2fa failed")
	}

	target, targetTok := e.NewUser("mod")
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", targetTok, []any{nil}); status != http.StatusOK {
		t.Fatal("join failed")
	}

	// A moderator role is any role whose allow carries a moderation bit.
	modRole := id.New()
	if err := e.Repo.PutRole(t.Context(), store.RoleRow{
		ID: modRole, CommunityID: cid, Name: "mod", Position: 5,
		// store.RoleRow.Allow is uint64 (§4.1/§4.2: roles.allow is a counter);
		// api.Bits is a distinct named type, so the conversion is explicit.
		Allow:   uint64(api.PermManageMessages | api.PermKickMembers),
		Created: e.Clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("PutRole: %v", err)
	}

	path := "/v1/communities/" + cid.String() + "/members/" + target.String() + "/roles/" + modRole.String()
	status, body := e.Do(http.MethodPut, path, ownerTok, []any{})
	if status != http.StatusForbidden {
		t.Fatalf("grant = %d, want 403 (%x)", status, body)
	}
	if code := e.ErrCode(body); code != "E_FORBIDDEN" {
		t.Fatalf("code = %s", code)
	}

	// With TOTP confirmed, the same grant succeeds.
	if err := e.Repo.PutTOTP(t.Context(), newConfirmedTOTP(target, e.Clk.Now().Unix())); err != nil {
		t.Fatalf("PutTOTP: %v", err)
	}
	if status, body := e.Do(http.MethodPut, path, ownerTok, []any{}); status != http.StatusNoContent {
		t.Fatalf("grant after TOTP = %d (%x)", status, body)
	}
}

// A passkey is the other second factor, and it is the branch that silently did
// not work while requireSecondFactor passed an empty rp_id: §4.3 indexes
// webauthn_credentials on (rp_id, user_id), so a query with rp_id = ” matches
// nothing however many passkeys the user holds.
func TestRequireMod2FAAcceptsAPasskeyWithNoTOTP(t *testing.T) {
	e := communityEnv(t)
	_, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)
	if status, _ := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), ownerTok,
		[]any{nil, nil, nil, uint64(1)}); status != http.StatusOK {
		t.Fatal("PATCH require_mod_2fa failed")
	}
	target, targetTok := e.NewUser("mod")
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", targetTok, []any{nil}); status != http.StatusOK {
		t.Fatal("join failed")
	}
	modRole := id.New()
	if err := e.Repo.PutRole(t.Context(), store.RoleRow{
		ID: modRole, CommunityID: cid, Name: "mod", Position: 5,
		Allow: uint64(api.PermManageMessages), Created: e.Clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("PutRole: %v", err)
	}
	// The harness registers api.NewRoles(..., "dilla.example", ...), so the
	// credential must be stored under that rp_id to be found.
	if err := e.Repo.PutWebauthnCredential(t.Context(), newTestCredential(target, "dilla.example", e.Clk.Now().Unix())); err != nil {
		t.Fatalf("PutWebauthnCredential: %v", err)
	}
	path := "/v1/communities/" + cid.String() + "/members/" + target.String() + "/roles/" + modRole.String()
	if status, body := e.Do(http.MethodPut, path, ownerTok, []any{}); status != http.StatusNoContent {
		t.Fatalf("grant with a passkey and no TOTP = %d (%x)", status, body)
	}
	held, err := e.Repo.ListMemberRoles(t.Context(), cid, target)
	if err != nil {
		t.Fatalf("ListMemberRoles: %v", err)
	}
	if len(held) != 1 || held[0] != modRole {
		t.Fatalf("roles held = %v, want [%v]", held, modRole)
	}
}

// communities.policy_json is TEXT and the API is the only thing standing
// between a client and a blob no engine-side JSON function can read: without
// the check, one engine stores the bytes and the other answers 500.
func TestANonJSONPolicyIsRefusedOnBothEngines(t *testing.T) {
	e := communityEnv(t)
	_, tok := e.NewUser("owner")
	status, body := e.Do(http.MethodPost, "/v1/communities", tok,
		[]any{"c", []byte("not json"), uint64(0), uint64(0)})
	if status != http.StatusBadRequest {
		t.Fatalf("POST with a non-JSON policy = %d (%x), want 400", status, body)
	}
	if code := e.ErrCode(body); code != "E_INVALID_REQUEST" {
		t.Fatalf("code = %s, want E_INVALID_REQUEST", code)
	}
}

// The policy document carries the join mode, the stored-not-enforced screening
// flag (R17) and the two halves of retention (R28): archival, default
// indefinite, and delivery, which a community may only shorten. It is stored
// byte for byte, and a document the later tasks could not read is refused
// rather than stored.
func TestPolicyDocumentCarriesJoinScreeningAndRetention(t *testing.T) {
	e := communityEnv(t)
	_, tok := e.NewUser("owner")

	full := []byte(`{"join":"invite","screening":true,"retention_days":365,"delivery_retention_days":7}`)
	status, body := e.Do(http.MethodPost, "/v1/communities", tok,
		[]any{"c", full, uint64(0), uint64(0)})
	if status != http.StatusCreated {
		t.Fatalf("POST with a full policy = %d (%x)", status, body)
	}
	var created []cbor.RawMessage
	mustUnmarshal(t, body, &created)
	var cid id.ID
	mustUnmarshal(t, created[0], &cid)

	status, body = e.Do(http.MethodGet, "/v1/communities/"+cid.String(), tok, nil)
	if status != http.StatusOK {
		t.Fatalf("GET = %d (%x)", status, body)
	}
	var doc []cbor.RawMessage
	mustUnmarshal(t, body, &doc)
	if len(doc) != 8 {
		t.Fatalf("GET has %d elements, want 8", len(doc))
	}
	var policy []byte
	mustUnmarshal(t, doc[3], &policy)
	if !bytes.Equal(policy, full) {
		t.Fatalf("policy read back = %s, want %s", policy, full)
	}

	parsed, err := api.ParseCommunityPolicy(policy)
	if err != nil {
		t.Fatalf("ParseCommunityPolicy: %v", err)
	}
	if !parsed.InviteOnly() || !parsed.Screening || parsed.RetentionDays != 365 || parsed.DeliveryRetentionDays != 7 {
		t.Fatalf("parsed = %+v", parsed)
	}
	// The empty document is every default: open, unscreened, retained indefinitely.
	def, err := api.ParseCommunityPolicy([]byte(`{}`))
	if err != nil {
		t.Fatalf("ParseCommunityPolicy({}): %v", err)
	}
	if def.InviteOnly() || def.Screening || def.RetentionDays != 0 || def.DeliveryRetentionDays != 0 {
		t.Fatalf("defaults = %+v", def)
	}

	for _, bad := range []string{
		`[1]`,                            // not an object
		`null`,                           // not an object
		`{"retension_days":3}`,           // a misspelt key is refused, not ignored
		`{"join":"closed"}`,              // not a join mode
		`{"screening":"yes"}`,            // wrong type
		`{"retention_days":-1}`,          // negative
		`{"retention_days":1.5}`,         // fractional
		`{"retention_days":36501}`,       // over a century
		`{"delivery_retention_days":31}`, // may only shorten the 30-day window
		`{"retention_days":1} {}`,        // trailing document
		"{\"join\":\"open\xff\"}",        // not UTF-8
	} {
		status, body := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), tok,
			[]any{nil, []byte(bad), nil, nil})
		if status != http.StatusBadRequest || e.ErrCode(body) != "E_INVALID_REQUEST" {
			t.Errorf("PATCH policy %q = %d (%x), want 400 E_INVALID_REQUEST", bad, status, body)
		}
	}
	got, _ := e.Repo.GetCommunity(t.Context(), cid)
	if got.PolicyVersion != 1 || !bytes.Equal(got.PolicyJSON, full) {
		t.Fatalf("a refused PATCH changed the policy: %+v", got)
	}
}

func TestCommunityFieldBounds(t *testing.T) {
	e := communityEnv(t)
	_, tok := e.NewUser("owner")
	for name, req := range map[string][]any{
		"empty name":       {"", []byte(`{}`), uint64(0), uint64(0)},
		"control in name":  {"a\x00b", []byte(`{}`), uint64(0), uint64(0)},
		"long name":        {string(bytes.Repeat([]byte("x"), 256)), []byte(`{}`), uint64(0), uint64(0)},
		"require_mod_2fa":  {"c", []byte(`{}`), uint64(0), uint64(2)},
		"min account age":  {"c", []byte(`{}`), uint64(1) << 63, uint64(0)},
		"five elements":    {"c", []byte(`{}`), uint64(0), uint64(0), uint64(0)},
		"policy too large": {"c", append(append([]byte(`{"x":"`), bytes.Repeat([]byte("a"), 16*1024)...), '"', '}'), uint64(0), uint64(0)},
	} {
		status, body := e.Do(http.MethodPost, "/v1/communities", tok, req)
		if status != http.StatusBadRequest {
			t.Errorf("%s: POST = %d (%x), want 400", name, status, body)
		}
	}
}

// Membership is the gate on every community read: a non-member learns nothing,
// not even that the community exists, and only the owner may change it.
func TestCommunityMembershipGates(t *testing.T) {
	e := communityEnv(t)
	owner, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)
	base := "/v1/communities/" + cid.String()

	outsider, outsiderTok := e.NewUser("outsider")
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, base},
		{http.MethodGet, base + "/members"},
		{http.MethodDelete, base},
	} {
		status, body := e.Do(c.method, c.path, outsiderTok, nil)
		if status != http.StatusNotFound || e.ErrCode(body) != "E_NOT_FOUND" {
			t.Errorf("outsider %s %s = %d (%x), want 404", c.method, c.path, status, body)
		}
	}
	if status, _ := e.Do(http.MethodGet, base, "", nil); status != http.StatusUnauthorized {
		t.Errorf("GET without a session = %d, want 401", status)
	}
	if status, _ := e.Do(http.MethodGet, "/v1/communities/"+id.New().String(), ownerTok, nil); status != http.StatusNotFound {
		t.Errorf("GET unknown = %d, want 404", status)
	}
	if status, _ := e.Do(http.MethodGet, "/v1/communities/NOT-HEX", ownerTok, nil); status != http.StatusBadRequest {
		t.Errorf("GET malformed id = %d, want 400", status)
	}

	// Joining is idempotent and keeps the member's nick.
	if status, _ := e.Do(http.MethodPost, base+"/join", outsiderTok, []any{nil}); status != http.StatusOK {
		t.Fatal("join failed")
	}
	if err := e.Repo.PutMember(t.Context(), store.MemberOfCommunityRow{
		CommunityID: cid, UserID: outsider, Joined: e.Clk.Now().Unix(), Nick: "Åsa 🌲",
	}); err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	if status, _ := e.Do(http.MethodPost, base+"/join", outsiderTok, []any{nil}); status != http.StatusOK {
		t.Fatal("second join failed")
	}
	if m, err := e.Repo.GetMember(t.Context(), cid, outsider); err != nil || m.Nick != "Åsa 🌲" {
		t.Fatalf("second join rewrote the member: %+v, %v", m, err)
	}

	// A member reads the community and the member list, but may not change it.
	status, body := e.Do(http.MethodGet, base+"/members", outsiderTok, nil)
	if status != http.StatusOK {
		t.Fatalf("GET members = %d (%x)", status, body)
	}
	var members []struct {
		_        struct{} `cbor:",toarray"`
		UserID   id.ID
		Joined   int64
		Nick     string
		Roles    []id.ID
		Username string
		Display  string
		Kind     uint64
	}
	mustUnmarshal(t, body, &members)
	if len(members) != 2 {
		t.Fatalf("members = %+v, want 2", members)
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPatch, base, []any{"mine", nil, nil, nil}},
		{http.MethodDelete, base, nil},
		{http.MethodDelete, base + "/members/" + owner.String(), nil},
	} {
		status, body := e.Do(c.method, c.path, outsiderTok, c.body)
		if status != http.StatusForbidden || e.ErrCode(body) != "E_FORBIDDEN" {
			t.Errorf("member %s %s = %d (%x), want 403", c.method, c.path, status, body)
		}
	}

	// The owner cannot leave and cannot be removed; a member can do both.
	if status, _ := e.Do(http.MethodPost, base+"/leave", ownerTok, []any{}); status != http.StatusForbidden {
		t.Errorf("owner leave = %d, want 403", status)
	}
	if status, _ := e.Do(http.MethodDelete, base+"/members/"+owner.String(), ownerTok, nil); status != http.StatusForbidden {
		t.Errorf("owner removing themself = %d, want 403", status)
	}
	if status, body := e.Do(http.MethodPost, base+"/leave", outsiderTok, []any{}); status != http.StatusNoContent {
		t.Fatalf("leave = %d (%x)", status, body)
	}
	if status, _ := e.Do(http.MethodGet, base, outsiderTok, nil); status != http.StatusNotFound {
		t.Errorf("GET after leaving = %d, want 404", status)
	}
	if status, _ := e.Do(http.MethodPost, base+"/join", outsiderTok, []any{nil}); status != http.StatusOK {
		t.Fatal("re-join failed")
	}
	if status, body := e.Do(http.MethodDelete, base+"/members/"+outsider.String(), ownerTok, nil); status != http.StatusNoContent {
		t.Fatalf("owner removing a member = %d (%x)", status, body)
	}
	if status, _ := e.Do(http.MethodDelete, base+"/members/"+outsider.String(), ownerTok, nil); status != http.StatusNotFound {
		t.Errorf("removing a non-member = %d, want 404", status)
	}

	// A disabled account cannot join.
	disabled, disabledTok := e.NewUser("disabled")
	at := e.Clk.Now().Unix()
	if err := e.Repo.SetUserDisabled(t.Context(), disabled, &at); err != nil {
		t.Fatalf("SetUserDisabled: %v", err)
	}
	if status, _ := e.Do(http.MethodPost, base+"/join", disabledTok, []any{nil}); status != http.StatusForbidden {
		t.Errorf("disabled join = %d, want 403", status)
	}

	// A session that is not enrolled is refused even where the middleware let
	// it through: every community route is "E" in protocol/09.
	_, pendingTok := e.NewUser("pending")
	s := e.sess[pendingTok]
	s.Scope = auth.ScopePending
	e.sess[pendingTok] = s
	if status, _ := e.Do(http.MethodPost, "/v1/communities", pendingTok,
		[]any{"c", []byte(`{}`), uint64(0), uint64(0)}); status != http.StatusForbidden {
		t.Errorf("pending session creating a community = %d, want 403", status)
	}

	// Deleting tombstones the community for everyone, the owner included.
	if status, body := e.Do(http.MethodDelete, base, ownerTok, nil); status != http.StatusNoContent {
		t.Fatalf("DELETE = %d (%x)", status, body)
	}
	if status, _ := e.Do(http.MethodGet, base, ownerTok, nil); status != http.StatusNotFound {
		t.Errorf("GET after delete = %d, want 404", status)
	}
	if status, _ := e.Do(http.MethodPost, base+"/join", outsiderTok, []any{nil}); status != http.StatusNotFound {
		t.Errorf("join after delete = %d, want 404", status)
	}
}

func TestRoleGrantGates(t *testing.T) {
	e := communityEnv(t)
	_, ownerTok := e.NewUser("owner")
	cid := createCommunity(t, e, ownerTok)
	member, memberTok := e.NewUser("member")
	if status, _ := e.Do(http.MethodPost, "/v1/communities/"+cid.String()+"/join", memberTok, []any{nil}); status != http.StatusOK {
		t.Fatal("join failed")
	}
	role := id.New()
	if err := e.Repo.PutRole(t.Context(), store.RoleRow{
		ID: role, CommunityID: cid, Name: "helper", Position: 1,
		Allow: uint64(api.PermPinMessages), Created: e.Clk.Now().Unix(),
	}); err != nil {
		t.Fatalf("PutRole: %v", err)
	}
	grant := func(tok string, user, r id.ID) int {
		status, _ := e.Do(http.MethodPut, "/v1/communities/"+cid.String()+"/members/"+user.String()+"/roles/"+r.String(), tok, []any{})
		return status
	}
	if got := grant(memberTok, member, role); got != http.StatusForbidden {
		t.Errorf("a non-owner granting = %d, want 403", got)
	}
	if got := grant(ownerTok, member, id.New()); got != http.StatusNotFound {
		t.Errorf("granting an unknown role = %d, want 404", got)
	}
	if got := grant(ownerTok, id.New(), role); got != http.StatusNotFound {
		t.Errorf("granting to a non-member = %d, want 404", got)
	}
	// A role of another community is not grantable here.
	otherCid := createCommunity(t, e, ownerTok)
	other := id.New()
	if err := e.Repo.PutRole(t.Context(), store.RoleRow{ID: other, CommunityID: otherCid, Name: "x", Created: 1}); err != nil {
		t.Fatalf("PutRole: %v", err)
	}
	if got := grant(ownerTok, member, other); got != http.StatusNotFound {
		t.Errorf("granting another community's role = %d, want 404", got)
	}
	// require_mod_2fa is 0 and the role carries no moderation bit: no second
	// factor is needed.
	if got := grant(ownerTok, member, role); got != http.StatusNoContent {
		t.Fatalf("grant = %d, want 204", got)
	}
	status, body := e.Do(http.MethodGet, "/v1/communities/"+cid.String()+"/members", ownerTok, nil)
	if status != http.StatusOK {
		t.Fatalf("GET members = %d", status)
	}
	var members []struct {
		_        struct{} `cbor:",toarray"`
		UserID   id.ID
		Joined   int64
		Nick     string
		Roles    []id.ID
		Username string
		Display  string
		Kind     uint64
	}
	mustUnmarshal(t, body, &members)
	for _, m := range members {
		if m.UserID == member && (len(m.Roles) != 1 || m.Roles[0] != role) {
			t.Fatalf("member roles = %v, want [%v]", m.Roles, role)
		}
	}
}

// createCommunity posts ["c", {}, 0, 0] and returns the decoded community_id.
func createCommunity(t *testing.T, e *env, tok string) id.ID {
	t.Helper()
	status, body := e.Do(http.MethodPost, "/v1/communities", tok,
		[]any{"c", []byte("{}"), uint64(0), uint64(0)})
	if status != http.StatusCreated {
		t.Fatalf("POST /v1/communities = %d (%x)", status, body)
	}
	var created []cbor.RawMessage
	mustUnmarshal(t, body, &created)
	var cid id.ID
	mustUnmarshal(t, created[0], &cid)
	return cid
}

// mustUnmarshal is cborx.Unmarshal with t.Fatalf.
func mustUnmarshal(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := cborx.Unmarshal(data, v); err != nil {
		t.Fatalf("cborx.Unmarshal(%x): %v", data, err)
	}
}

// newConfirmedTOTP is a store.TOTPRow with ConfirmedAt set.
func newConfirmedTOTP(user id.ID, now int64) store.TOTPRow {
	return store.TOTPRow{
		UserID: user, Secret: make([]byte, 20), Digits: 6, Period: 30,
		Algorithm: "SHA1", ConfirmedAt: &now, Created: now,
	}
}

// newTestCredential is a store.WebauthnCredentialRow under rpID with the
// minimum non-null columns of §4.3.
func newTestCredential(user id.ID, rpID string, now int64) store.WebauthnCredentialRow {
	cred := id.New()
	return store.WebauthnCredentialRow{
		CredID: cred[:], RPID: rpID, UserID: user, PublicKey: []byte{1},
		Flags: []byte{0}, ExtensionsJSON: "{}", Created: now,
	}
}
