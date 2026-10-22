package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

type admissionListVerifier struct{ entry mlswasi.DeviceListEntry }

func (v *admissionListVerifier) Verify(context.Context, []byte, []byte, id.ID) ([]mlswasi.DeviceListEntry, error) {
	return []mlswasi.DeviceListEntry{v.entry}, nil
}

// Missing signing or signed-list verification dependencies must fail closed
// before the handler creates an authorization artifact.
func TestBotInteractionAdmissionRefusesWithoutSigningDependencies(t *testing.T) {
	h, deps := newTestAPI(t)
	ctx := context.Background()
	now := deps.Clock.Now().Unix()
	owner, _, _ := seedAPIDevice(t, deps)
	community, bot, device, runtime, installation := id.New(), id.New(), id.New(), id.New(), id.New()
	verified := now
	if err := deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: community, Owner: owner.ID, Name: "admission-test", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateUser(ctx, store.UserRow{ID: bot, Username: "bot" + bot.String()[:8], Display: "Bot", Kind: 1, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateDevice(ctx, store.DeviceRow{ID: device, UserID: bot, DSKPub: make([]byte, 32), CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: bot, Joined: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotRuntime(ctx, store.BotRuntimeRow{ID: runtime, TokenHash: make([]byte, 32), Created: now, Rotated: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotInstallation(ctx, store.BotInstallationRow{ID: installation, CommunityID: community, RuntimeID: &runtime, UserID: &bot, DeviceID: &device, State: store.BotInstallationReady, Revision: 1, ApprovedBy: owner.ID, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	token := "admission-missing-signer"
	if err := deps.Repo.CreateSession(ctx, store.SessionRow{TokenHash: auth.TokenHash(token), DeviceID: device, UserID: bot, Scope: uint8(auth.ScopeEnrolled), Created: now, Expires: now + 3600, IdleExpires: now + 3600}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotSessionBinding(ctx, store.BotSessionBindingRow{TokenHash: auth.TokenHash(token), InstallationID: installation, UserID: bot, DeviceID: device, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Sessions.RecordCapabilities(ctx, auth.TokenHash(token), 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	body := mustCBOR(t, []any{id.New(), id.New(), owner.ID, id.New()})
	resp := postCBORAuth(h, "/v1/bot-runtime/installations/"+installation.String()+"/interaction-admissions", body, token)
	if resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing signer/device-list verifier response = %d, want 503: %x", resp.Code, resp.Body.Bytes())
	}
}

func TestBotInteractionAdmissionSignsBoundCurrentEligibility(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	seed[0] = 0x41
	private := ed25519.NewKeyFromSeed(seed)
	failSign := false
	verifier := &admissionListVerifier{}
	h, deps := newTestAPIFull(t, nil, func(d *api.Deps) {
		d.DeviceLists = verifier
		d.SignBotInteractionAdmission = func(payload []byte) ([]byte, error) {
			if failSign {
				return nil, errors.New("test signer failure")
			}
			return ed25519.Sign(private, append([]byte("dilla bot interaction admission v1\x00"), payload...)), nil
		}
	})
	ctx := context.Background()
	now := deps.Clock.Now().Unix()
	owner, _, _ := seedAPIDevice(t, deps)
	community, bot, botDevice, runtime, installation := id.New(), id.New(), id.New(), id.New(), id.New()
	verified := now
	if err := deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: community, Owner: owner.ID, Name: "admission-valid", PolicyJSON: []byte(`{}`), PolicyVersion: 1, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateUser(ctx, store.UserRow{ID: bot, Username: "bot" + bot.String()[:8], Display: "Bot", Kind: 1, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateDevice(ctx, store.DeviceRow{ID: botDevice, UserID: bot, DSKPub: make([]byte, 32), CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: bot, Joined: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotRuntime(ctx, store.BotRuntimeRow{ID: runtime, TokenHash: make([]byte, 32), Created: now, Rotated: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotInstallation(ctx, store.BotInstallationRow{ID: installation, CommunityID: community, RuntimeID: &runtime, UserID: &bot, DeviceID: &botDevice, State: store.BotInstallationJoining, Revision: 1, ApprovedBy: owner.ID, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	participant, participantDevice := id.New(), id.New()
	dsk := make([]byte, 32)
	dsk[0] = 0x55
	if err := deps.Repo.CreateUser(ctx, store.UserRow{ID: participant, Username: "human" + participant.String()[:8], Display: "Human", Kind: 0, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateDevice(ctx, store.DeviceRow{ID: participantDevice, UserID: participant, DSKPub: dsk, Tier: 1, CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: participant, Joined: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutDeviceList(ctx, store.DeviceListRow{UserID: participant, Version: 1, Blob: []byte{0x80}, SSKSignature: make([]byte, 64), PrevHash: make([]byte, 32), Created: now}); err != nil {
		t.Fatal(err)
	}
	verifier.entry = mlswasi.DeviceListEntry{DeviceID: participantDevice[:], DSKPub: dsk, Tier: 1}
	token := "admission-valid-bot-session"
	if err := deps.Repo.CreateSession(ctx, store.SessionRow{TokenHash: auth.TokenHash(token), DeviceID: botDevice, UserID: bot, Scope: uint8(auth.ScopeEnrolled), Created: now, Expires: now + 3600, IdleExpires: now + 3600}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotSessionBinding(ctx, store.BotSessionBindingRow{TokenHash: auth.TokenHash(token), InstallationID: installation, UserID: bot, DeviceID: botDevice, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Sessions.RecordCapabilities(ctx, auth.TokenHash(token), 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	requestID, group := id.New(), id.New()
	path := "/v1/bot-runtime/installations/" + installation.String() + "/interaction-admissions"
	requestBody := mustCBOR(t, []any{requestID, group, participant, participantDevice})
	resp := postCBORAuth(h, path, requestBody, token)
	if resp.Code != http.StatusOK {
		t.Fatalf("admission issue = %d %x, want 200", resp.Code, resp.Body.Bytes())
	}
	var result []any
	if err := cborx.Unmarshal(resp.Body.Bytes(), &result); err != nil || len(result) != 2 {
		t.Fatalf("response decode: %v; %x", err, resp.Body.Bytes())
	}
	payload, pOK := result[0].([]byte)
	signature, sOK := result[1].([]byte)
	if !pOK || !sOK || len(signature) != ed25519.SignatureSize || !ed25519.Verify(private.Public().(ed25519.PublicKey), append([]byte("dilla bot interaction admission v1\x00"), payload...), signature) {
		t.Fatalf("admission signature invalid: %#v", result)
	}
	var fields []any
	if err := cborx.Unmarshal(payload, &fields); err != nil || len(fields) != 12 {
		t.Fatalf("payload tuple decode: %v; %#v", err, fields)
	}
	retry := postCBORAuth(h, path, requestBody, token)
	if retry.Code != http.StatusOK || retry.Body.String() != resp.Body.String() {
		t.Fatalf("same-ID retry = %d %x, want byte-identical receipt", retry.Code, retry.Body.Bytes())
	}
	conflict := postCBORAuth(h, path, mustCBOR(t, []any{requestID, id.New(), participant, participantDevice}), token)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflicting request-ID reuse = %d %x, want 409", conflict.Code, conflict.Body.Bytes())
	}
	if err := deps.Repo.DeleteMember(ctx, community, participant); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: participant, Joined: now + 1}); err != nil {
		t.Fatal(err)
	}
	changedEligibility := postCBORAuth(h, path, requestBody, token)
	if changedEligibility.Code != http.StatusConflict {
		t.Fatalf("same receipt after eligibility revision change = %d %x, want 409", changedEligibility.Code, changedEligibility.Body.Bytes())
	}
	// A signer failure aborts the transaction without persisting a partial receipt.
	failedID := id.New()
	failedRequest := mustCBOR(t, []any{failedID, group, participant, participantDevice})
	failSign = true
	failed := postCBORAuth(h, path, failedRequest, token)
	if failed.Code != http.StatusServiceUnavailable {
		t.Fatalf("signer failure = %d, want 503", failed.Code)
	}
	failSign = false
	recovered := postCBORAuth(h, path, failedRequest, token)
	if recovered.Code != http.StatusOK {
		t.Fatalf("retry after signer failure for %s = %d %x, want 200", failedID, recovered.Code, recovered.Body.Bytes())
	}
	// Replays after the 30-second validity window are refused.
	if advance, ok := deps.Clock.(interface{ Advance(time.Duration) }); ok {
		advance.Advance(31 * time.Second)
	} else {
		t.Fatal("test clock cannot advance")
	}
	expired := postCBORAuth(h, path, failedRequest, token)
	if expired.Code != http.StatusOK {
		t.Fatalf("expired request retry = %d %x, want a newly issued 200", expired.Code, expired.Body.Bytes())
	}
	var renewed []any
	if err := cborx.Unmarshal(expired.Body.Bytes(), &renewed); err != nil || len(renewed) != 2 {
		t.Fatalf("expired receipt decode failed: err=%v body=%x value=%#v", err, expired.Body.Bytes(), renewed)
	}
	newPayload, ok := renewed[0].([]byte)
	if !ok || bytes.Equal(newPayload, payload) {
		t.Fatalf("expired receipt was not replaced by a fresh admission: body=%x value=%#v", expired.Body.Bytes(), renewed)
	}
	expiredConflict := postCBORAuth(h, path, mustCBOR(t, []any{failedID, id.New(), participant, participantDevice}), token)
	if expiredConflict.Code != http.StatusConflict {
		t.Fatalf("expired request ID reused for another group = %d %x, want 409", expiredConflict.Code, expiredConflict.Body.Bytes())
	}

	if err := deps.Repo.PutBan(ctx, store.BanRow{CommunityID: community, UserID: participant, ByUser: owner.ID, Created: now}); err != nil {
		t.Fatal(err)
	}
	refused := postCBORAuth(h, "/v1/bot-runtime/installations/"+installation.String()+"/interaction-admissions", mustCBOR(t, []any{id.New(), group, participant, participantDevice}), token)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("currently banned participant admission = %d %x, want 403", refused.Code, refused.Body.Bytes())
	}
}
