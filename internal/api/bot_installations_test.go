package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	botruntime "github.com/jonasthim/dilla/internal/bot/runtime"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestBotInstallationEnableRequiresStepUpAndReplaysOnlyTheSameRequest(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) { testBotInstallationEnableRequiresStepUpAndReplaysOnlyTheSameRequest(t, repo) })
	}
}

func testBotInstallationEnableRequiresStepUpAndReplaysOnlyTheSameRequest(t *testing.T, repo store.Repository) {
	h, deps := newTestAPIWithRepository(t, repo, func(d *api.Deps) {
		d.StepUps = api.NewStepUps(d.Clock, time.Minute)
	})
	owner, _, token := seedAPISession(t, deps)
	cid := id.New()
	ctx := context.Background()
	if err := deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: cid, Owner: owner.ID, Name: "test", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: deps.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: owner.ID, Joined: deps.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutRole(ctx, store.RoleRow{ID: id.New(), CommunityID: cid, Name: "@everyone", Position: 0, Created: deps.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	negotiate, _ := cborx.Marshal([]any{[]any{uint64(3)}, []any{uint64(1)}, []any{uint64(1)}})
	nonManager, _, nonManagerToken := seedAPISession(t, deps)
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: nonManager.ID, Joined: deps.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if rec := postCBORAuth(h, "/v1/sessions/negotiate", negotiate, nonManagerToken); rec.Code != http.StatusOK {
		t.Fatalf("nonmanager negotiate wire 3 = %d (%x)", rec.Code, rec.Body.Bytes())
	}
	if rec := postCBORAuth(h, "/v1/sessions/negotiate", negotiate, token); rec.Code != http.StatusOK {
		t.Fatalf("negotiate wire 3 = %d (%x)", rec.Code, rec.Body.Bytes())
	}
	path := "/v1/communities/" + cid.String() + "/bot"
	unauthorizedBody, _ := cborx.Marshal([]any{id.New(), nil, uint64(0), ""})
	if denied := putCBORAuth(h, path, unauthorizedBody, nonManagerToken); denied.Code != http.StatusForbidden {
		t.Fatalf("nonmanager enable = %d (%x), want 403", denied.Code, denied.Body.Bytes())
	}
	requestID := id.New()
	encode := func(step string) []byte {
		body, err := cborx.Marshal([]any{requestID, nil, uint64(0), step})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	for _, step := range []string{"", "forged-step-up"} {
		rec := putCBORAuth(h, path, encode(step), token)
		if rec.Code == http.StatusCreated || rec.Code == http.StatusOK {
			t.Fatalf("enable with step-up %q unexpectedly succeeded", step)
		}
	}
	step, _ := deps.StepUps.Issue(owner.ID, func() []byte {
		s, err := deps.Sessions.Resolve(ctx, token)
		if err != nil {
			t.Fatal(err)
		}
		return s.TokenHash
	}())
	first := putCBORAuth(h, path, encode(step), token)
	if first.Code != http.StatusCreated {
		t.Fatalf("enable = %d (%x), want 201", first.Code, first.Body.Bytes())
	}
	replay := putCBORAuth(h, path, encode(""), token)
	if replay.Code != http.StatusOK {
		t.Fatalf("matching completed replay = %d (%x), want 200", replay.Code, replay.Body.Bytes())
	}
	noopID := id.New()
	noopBody, _ := cborx.Marshal([]any{noopID, uint64(1), uint64(0), ""})
	if noop := putCBORAuth(h, path, noopBody, token); noop.Code != http.StatusOK {
		t.Fatalf("new no-op capability approval = %d (%x), want 200", noop.Code, noop.Body.Bytes())
	}
	repurposedNoop, _ := cborx.Marshal([]any{noopID, uint64(1), uint64(1), ""})
	if conflict := putCBORAuth(h, path, repurposedNoop, token); conflict.Code != http.StatusConflict {
		t.Fatalf("reusing no-op request id for changed capabilities = %d (%x), want 409", conflict.Code, conflict.Body.Bytes())
	}

	conflictID := id.New()
	conflict, _ := cborx.Marshal([]any{conflictID, nil, uint64(0), ""})
	if rec := putCBORAuth(h, path, conflict, token); rec.Code != http.StatusConflict {
		t.Fatalf("new request with stale nil revision = %d, want 409", rec.Code)
	}
	row, err := deps.Repo.GetActiveBotInstallationByCommunity(ctx, cid)
	if err != nil || row.State != store.BotInstallationPending || row.Revision != 1 {
		t.Fatalf("installation after retries = %+v, %v; want pending revision 1", row, err)
	}
}

func TestRuntimeRoutesRejectOrdinaryHumanBearer(t *testing.T) {
	h, deps := newTestAPI(t)
	_, _, humanToken := seedAPISession(t, deps)
	installation := id.New().String()
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/v1/bot-runtime/installations"},
		{http.MethodPost, "/v1/bot-runtime/installations/" + installation + "/claim"},
		{http.MethodPost, "/v1/bot-runtime/installations/" + installation + "/enroll"},
	} {
		rec := doBotCBOR(h, tc.method, tc.path, nil, "Bearer "+humanToken)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s with human bearer = %d (%x), want 401", tc.method, tc.path, rec.Code, rec.Body.Bytes())
		}
	}
}

func TestRuntimeClaimEnrollmentAndReplayUseVerifiedBotCredential(t *testing.T) {
	for engine, repo := range policyEngines(t) {
		t.Run(engine, func(t *testing.T) { testRuntimeClaimEnrollmentAndReplayUseVerifiedBotCredential(t, repo) })
	}
}

func testRuntimeClaimEnrollmentAndReplayUseVerifiedBotCredential(t *testing.T, repo store.Repository) {
	var manager *botruntime.Manager
	h, deps := newTestAPIWithRepository(t, repo, func(d *api.Deps) {
		d.StepUps = api.NewStepUps(d.Clock, time.Minute)
		manager = botruntime.New(d.Repo, d.Clock.Now)
		d.BotRuntime = manager
	})
	owner, _, humanToken := seedAPISession(t, deps)
	cid := seedBotCommunity(t, deps, owner.ID)
	negotiate, _ := cborx.Marshal([]any{[]any{uint64(3)}, []any{uint64(1)}, []any{uint64(1)}})
	if rec := postCBORAuth(h, "/v1/sessions/negotiate", negotiate, humanToken); rec.Code != http.StatusOK {
		t.Fatalf("negotiate wire 3 = %d (%x)", rec.Code, rec.Body.Bytes())
	}
	ownerSession, err := deps.Sessions.Resolve(context.Background(), humanToken)
	if err != nil {
		t.Fatal(err)
	}
	step, _ := deps.StepUps.Issue(owner.ID, ownerSession.TokenHash)
	communityPath := "/v1/communities/" + cid.String() + "/bot"
	configureID := id.New()
	configure, _ := cborx.Marshal([]any{configureID, nil, uint64(0), step})
	enabled := putCBORAuth(h, communityPath, configure, humanToken)
	if enabled.Code != http.StatusCreated {
		t.Fatalf("enable = %d (%x)", enabled.Code, enabled.Body.Bytes())
	}
	var installationResponse []any
	if err := cborx.Unmarshal(enabled.Body.Bytes(), &installationResponse); err != nil {
		t.Fatal(err)
	}
	installationID := mustBotID(t, installationResponse[0])
	var runtimeID id.ID
	var runtimeToken string
	if _, err := manager.Create(context.Background(), func(got id.ID, token string) error {
		runtimeID, runtimeToken = got, token
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	authHeader := "Bearer " + runtimeToken
	claimRequestID := id.New()
	claimBody, _ := cborx.Marshal([]any{claimRequestID})
	claim := doBotCBOR(h, http.MethodPost, "/v1/bot-runtime/installations/"+installationID.String()+"/claim", claimBody, authHeader)
	if claim.Code != http.StatusOK {
		t.Fatalf("claim = %d (%x)", claim.Code, claim.Body.Bytes())
	}
	var claimResponse []any
	if err := cborx.Unmarshal(claim.Body.Bytes(), &claimResponse); err != nil {
		t.Fatal(err)
	}
	claimID := mustBotID(t, claimResponse[1])
	deviceID := id.New()
	credential := makeTestCredential(t, deviceID, 1)
	enrollRequestID := id.New()
	enrollPath := "/v1/bot-runtime/installations/" + installationID.String() + "/enroll"
	makeEnrollBody := func(request id.ID, identity testHumanCredential, umk, ssk, dsk, raw []byte) []byte {
		t.Helper()
		body, err := cborx.Marshal([]any{request, claimID, umk, ssk, identity.SigUMKSSK,
			[]any{deviceID, dsk, uint64(0), uint64(0), raw}})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	humanCredential := makeTestCredential(t, deviceID, 0)
	wrongDSK := append([]byte(nil), credential.DSKPub...)
	wrongDSK[0] ^= 1
	wrongUMK := append([]byte(nil), credential.UMKPub...)
	wrongUMK[0] ^= 1
	wrongSSK := append([]byte(nil), credential.SSKPub...)
	wrongSSK[0] ^= 1
	badSignature := append([]byte(nil), credential.Credential...)
	badSignature[len(badSignature)-1] ^= 1
	wrongTier := mutateBotCredential(t, credential, id.ID{}, 1, 0)
	wrongUser := id.New()
	wrongUserCredential := mutateBotCredential(t, credential, wrongUser, 0, 0)
	for _, invalid := range []struct {
		name      string
		identity  testHumanCredential
		umk, ssk  []byte
		dsk, blob []byte
	}{
		{name: "human kind", identity: humanCredential, umk: humanCredential.UMKPub, ssk: humanCredential.SSKPub, dsk: humanCredential.DSKPub, blob: humanCredential.Credential},
		{name: "foreign DSK", identity: credential, umk: credential.UMKPub, ssk: credential.SSKPub, dsk: wrongDSK, blob: credential.Credential},
		{name: "mismatched UMK", identity: credential, umk: wrongUMK, ssk: credential.SSKPub, dsk: credential.DSKPub, blob: credential.Credential},
		{name: "mismatched SSK", identity: credential, umk: credential.UMKPub, ssk: wrongSSK, dsk: credential.DSKPub, blob: credential.Credential},
		{name: "browser tier", identity: credential, umk: credential.UMKPub, ssk: credential.SSKPub, dsk: credential.DSKPub, blob: wrongTier},
		{name: "assigned foreign user", identity: credential, umk: credential.UMKPub, ssk: credential.SSKPub, dsk: credential.DSKPub, blob: wrongUserCredential},
		{name: "bad signature", identity: credential, umk: credential.UMKPub, ssk: credential.SSKPub, dsk: credential.DSKPub, blob: badSignature},
	} {
		bad := doBotCBOR(h, http.MethodPost, enrollPath,
			makeEnrollBody(id.New(), invalid.identity, invalid.umk, invalid.ssk, invalid.dsk, invalid.blob), authHeader)
		if bad.Code != http.StatusBadRequest {
			t.Errorf("enrollment with %s = %d (%x), want 400", invalid.name, bad.Code, bad.Body.Bytes())
		}
	}
	enrollBody := makeEnrollBody(enrollRequestID, credential, credential.UMKPub, credential.SSKPub, credential.DSKPub, credential.Credential)
	enrolled := doBotCBOR(h, http.MethodPost, enrollPath, enrollBody, authHeader)
	if enrolled.Code != http.StatusCreated {
		t.Fatalf("enroll = %d (%x)", enrolled.Code, enrolled.Body.Bytes())
	}
	var enrollmentResult []any
	if err := cborx.Unmarshal(enrolled.Body.Bytes(), &enrollmentResult); err != nil {
		t.Fatal(err)
	}
	userID := mustBotID(t, enrollmentResult[0])
	user, err := deps.Repo.GetUser(context.Background(), userID)
	if err != nil || user.Kind != 1 {
		t.Fatalf("enrolled user = %+v, %v; want Kind=1", user, err)
	}
	nonce, _, err := deps.Sessions.Challenge(context.Background(), deviceID)
	if err != nil {
		t.Fatalf("challenge for enrolled bot = %v", err)
	}
	preimage := auth.SessionPreimage(deps.Sessions.InstanceID(), deviceID, nonce, auth.PurposeSession)
	botSession, err := deps.Sessions.Establish(context.Background(), auth.EstablishRequest{
		DeviceID: deviceID, Nonce: nonce, Purpose: auth.PurposeSession,
		Sig: ed25519.Sign(ed25519.PrivateKey(credential.DSKPriv), preimage),
	})
	if err != nil {
		t.Fatalf("establish bound bot session = %v", err)
	}
	botToken := botSession.Token
	if negotiated := postCBORAuth(h, "/v1/sessions/negotiate", negotiate, botToken); negotiated.Code != http.StatusOK {
		t.Fatalf("bot negotiate wire 3 = %d (%x)", negotiated.Code, negotiated.Body.Bytes())
	}
	finalCredential := mutateBotCredential(t, credential, userID, 0, 0)
	credentialRequestID := id.New()
	credentialBody, _ := cborx.Marshal([]any{credentialRequestID, uint64(2), finalCredential})
	credentialPath := "/v1/bot-runtime/installations/" + installationID.String() + "/credential"
	finalized := putCBORAuth(h, credentialPath, credentialBody, botToken)
	if finalized.Code != http.StatusOK {
		t.Fatalf("finalize assigned bot credential = %d (%x)", finalized.Code, finalized.Body.Bytes())
	}
	if retry := putCBORAuth(h, credentialPath, credentialBody, botToken); retry.Code != http.StatusOK {
		t.Fatalf("matching final credential replay while joining = %d (%x)", retry.Code, retry.Body.Bytes())
	}
	installationAfterRetry, err := deps.Repo.GetActiveBotInstallationByCommunity(context.Background(), cid)
	if err != nil || installationAfterRetry.Revision != 3 || installationAfterRetry.State != store.BotInstallationJoining {
		t.Fatalf("matching credential retry changed installation phase/revision: %+v, %v", installationAfterRetry, err)
	}
	changedCredential := append([]byte(nil), finalCredential...)
	changedCredential[len(changedCredential)-1] ^= 1
	changedBody, _ := cborx.Marshal([]any{credentialRequestID, uint64(2), changedCredential})
	if changed := putCBORAuth(h, credentialPath, changedBody, botToken); changed.Code != http.StatusConflict {
		t.Fatalf("same credential request id with changed payload = %d (%x), want 409", changed.Code, changed.Body.Bytes())
	}
	credentialReceipt, err := deps.Repo.GetBotOperation(context.Background(), cid, credentialRequestID)
	if err != nil || credentialReceipt.ActorKind != 2 {
		t.Fatalf("final credential receipt actor kind = %d, %v; want bot actor kind 2", credentialReceipt.ActorKind, err)
	}
	wrongActorRequestID := id.New()
	wrongActorPayload, _ := cborx.Marshal(struct {
		Request, Installation id.ID
		Revision              uint64
		Credential            []byte
	}{wrongActorRequestID, installationID, 3, finalCredential})
	wrongActorHash := sha256.Sum256(wrongActorPayload)
	deviceActor := deviceID
	if err := deps.Repo.CreateBotOperation(context.Background(), store.BotOperationRow{
		CommunityID: cid, RequestID: wrongActorRequestID, InstallationID: installationID,
		ActorKind: 0, ActorID: userID, ActorDevice: &deviceActor, Operation: 6,
		PayloadHash: wrongActorHash[:], ResultCBOR: []byte{0x80}, Created: deps.Clock.Now().Unix(),
	}); err != nil {
		t.Fatal(err)
	}
	wrongActorBody, _ := cborx.Marshal([]any{wrongActorRequestID, uint64(3), finalCredential})
	if rejected := putCBORAuth(h, credentialPath, wrongActorBody, botToken); rejected.Code != http.StatusConflict {
		t.Fatalf("receipt substituted with a human actor kind = %d (%x), want 409", rejected.Code, rejected.Body.Bytes())
	}
	readyBody, _ := cborx.Marshal([]any{id.New(), uint64(3)})
	readyPath := "/v1/bot-runtime/installations/" + installationID.String() + "/ready"
	if ready := postCBORAuth(h, readyPath, readyBody, botToken); ready.Code != http.StatusConflict {
		t.Fatalf("ready without signed device list/key packages = %d (%x), want 409", ready.Code, ready.Body.Bytes())
	}
	if fake, ok := deps.Clock.(interface{ Advance(time.Duration) }); ok {
		fake.Advance(601 * time.Second)
	} else {
		t.Fatal("test clock does not support advancing time")
	}
	if replay := doBotCBOR(h, http.MethodPost, enrollPath, enrollBody, authHeader); replay.Code != http.StatusOK {
		t.Fatalf("same enrollment replay after claim expiry = %d (%x), want 200", replay.Code, replay.Body.Bytes())
	}
	if err := manager.Rotate(context.Background(), runtimeID, func(got id.ID, token string) error {
		if got != runtimeID {
			t.Fatalf("rotation changed runtime id from %s to %s", runtimeID, got)
		}
		runtimeToken = token
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	listOld := doBotCBOR(h, http.MethodGet, "/v1/bot-runtime/installations", nil, authHeader)
	if listOld.Code != http.StatusUnauthorized {
		t.Fatalf("old runtime credential after rotation = %d, want 401", listOld.Code)
	}
	if replay := doBotCBOR(h, http.MethodPost, enrollPath, enrollBody, "Bearer "+runtimeToken); replay.Code != http.StatusOK {
		t.Fatalf("same enrollment receipt after rotation = %d (%x), want 200", replay.Code, replay.Body.Bytes())
	}
	if err := manager.Revoke(context.Background(), runtimeID); err != nil {
		t.Fatalf("revoke runtime credential: %v", err)
	}
	if denied := doBotCBOR(h, http.MethodGet, "/v1/bot-runtime/installations", nil, "Bearer "+runtimeToken); denied.Code != http.StatusUnauthorized {
		t.Fatalf("runtime list after revocation = %d (%x), want 401", denied.Code, denied.Body.Bytes())
	}
	if denied := putCBORAuth(h, credentialPath, credentialBody, botToken); denied.Code != http.StatusUnauthorized {
		t.Fatalf("bot credential replay after runtime revocation = %d (%x), want 401", denied.Code, denied.Body.Bytes())
	}
}

func mutateBotCredential(t *testing.T, credential testHumanCredential, userID id.ID, tier, signerTier byte) []byte {
	t.Helper()
	var fields []any
	if err := cborx.Unmarshal(credential.Credential, &fields); err != nil {
		t.Fatal(err)
	}
	fields[2], fields[5], fields[6] = userID[:], uint64(tier), uint64(signerTier)
	deviceID, ok := fields[3].([]byte)
	if !ok || len(deviceID) != 16 {
		t.Fatal("test credential has malformed device id")
	}
	message := append([]byte("dilla dsk v1"), deviceID...)
	message = append(message, credential.DSKPub...)
	message = append(message, byte(fields[4].(uint64)), tier, signerTier)
	fields[9] = ed25519.Sign(ed25519.PrivateKey(credential.SSKPriv), message)
	raw, err := cborx.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func seedBotCommunity(t *testing.T, d api.Deps, owner id.ID) id.ID {
	t.Helper()
	cid := id.New()
	ctx := context.Background()
	if err := d.Repo.CreateCommunity(ctx, store.CommunityRow{ID: cid, Owner: owner, Name: "test", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: d.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if err := d.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: cid, UserID: owner, Joined: d.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	if err := d.Repo.PutRole(ctx, store.RoleRow{ID: id.New(), CommunityID: cid, Name: "@everyone", Position: 0, Created: d.Clock.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	return cid
}

func mustBotID(t *testing.T, raw any) id.ID {
	t.Helper()
	var out id.ID
	b, ok := raw.([]byte)
	if !ok || len(b) != len(out) {
		t.Fatalf("value %T (%v) is not an ID", raw, raw)
	}
	copy(out[:], b)
	return out
}

func doBotCBOR(h http.Handler, method, path string, body []byte, authorization string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/cbor")
	req.Header.Set("Authorization", authorization)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func putCBORAuth(h http.Handler, path string, body []byte, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), http.MethodPut, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/cbor")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
