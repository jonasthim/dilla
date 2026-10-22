package api_test

import (
	"context"
	"crypto/ed25519"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

type keyedAdmissionVerifier map[id.ID]mlswasi.DeviceListEntry

func (v keyedAdmissionVerifier) Verify(_ context.Context, _ []byte, _ []byte, user id.ID) ([]mlswasi.DeviceListEntry, error) {
	entry, ok := v[user]
	if !ok {
		return nil, errors.New("missing test device list")
	}
	return []mlswasi.DeviceListEntry{entry}, nil
}

func TestBotInteractionPreflightLoaderFailsClosedOnStaleOrChangedContext(t *testing.T) {
	private := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	verifier := keyedAdmissionVerifier{}
	h, deps := newTestAPIFull(t, nil, func(d *api.Deps) {
		d.DeviceLists = verifier
		d.ExternalSenderPub = append(ed25519.PublicKey(nil), private.Public().(ed25519.PublicKey)...)
		d.SignBotInteractionAdmission = func(payload []byte) ([]byte, error) {
			return ed25519.Sign(private, append([]byte("dilla bot interaction admission v1\x00"), payload...)), nil
		}
	})
	ctx := context.Background()
	now := deps.Clock.Now().Unix()
	owner, _, _ := seedAPIDevice(t, deps)
	community, bot, botDevice, participant, participantDevice := id.New(), id.New(), id.New(), id.New(), id.New()
	runtimeID, installationID := id.New(), id.New()
	verified := now
	if err := deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: community, Owner: owner.ID, Name: "preflight", PolicyJSON: []byte(`{}`), PolicyVersion: 7, Created: now}); err != nil {
		t.Fatal(err)
	}
	for _, user := range []store.UserRow{
		{ID: bot, Username: "bot" + bot.String()[:8], Display: "Bot", Kind: 1, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now},
		{ID: participant, Username: "human" + participant.String()[:8], Display: "Human", Kind: 0, UMKPub: make([]byte, 32), SSKPub: make([]byte, 32), SigUMKSSK: make([]byte, 64), Created: now},
	} {
		if err := deps.Repo.CreateUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	botKey, participantKey := make([]byte, 32), make([]byte, 32)
	botKey[0], participantKey[0] = 1, 2
	for _, device := range []store.DeviceRow{
		{ID: botDevice, UserID: bot, DSKPub: botKey, CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now},
		{ID: participantDevice, UserID: participant, DSKPub: participantKey, Tier: 1, CredentialBlob: []byte{1}, VerifiedAt: &verified, Created: now},
	} {
		if err := deps.Repo.CreateDevice(ctx, device); err != nil {
			t.Fatal(err)
		}
	}
	for _, user := range []id.ID{bot, participant} {
		if err := deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: user, Joined: now}); err != nil {
			t.Fatal(err)
		}
		if err := deps.Repo.PutDeviceList(ctx, store.DeviceListRow{UserID: user, Version: 1, Blob: []byte{0x80}, SSKSignature: make([]byte, 64), PrevHash: make([]byte, 32), Created: now}); err != nil {
			t.Fatal(err)
		}
	}
	verifier[bot] = mlswasi.DeviceListEntry{DeviceID: botDevice[:], DSKPub: botKey}
	verifier[participant] = mlswasi.DeviceListEntry{DeviceID: participantDevice[:], DSKPub: participantKey, Tier: 1}
	if err := deps.Repo.CreateBotRuntime(ctx, store.BotRuntimeRow{ID: runtimeID, TokenHash: make([]byte, 32), Created: now, Rotated: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotInstallation(ctx, store.BotInstallationRow{ID: installationID, CommunityID: community, RuntimeID: &runtimeID, UserID: &bot, DeviceID: &botDevice, State: store.BotInstallationJoining, Revision: 1, ApprovedBy: owner.ID, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	token := "interaction-preflight-loader"
	if err := deps.Repo.CreateSession(ctx, store.SessionRow{TokenHash: auth.TokenHash(token), DeviceID: botDevice, UserID: bot, Scope: uint8(auth.ScopeEnrolled), Created: now, Expires: now + 3600, IdleExpires: now + 3600}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Repo.CreateBotSessionBinding(ctx, store.BotSessionBindingRow{TokenHash: auth.TokenHash(token), InstallationID: installationID, UserID: bot, DeviceID: botDevice, Created: now}); err != nil {
		t.Fatal(err)
	}
	if err := deps.Sessions.RecordCapabilities(ctx, auth.TokenHash(token), 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	group, requestID := id.New(), id.New()
	issued := postCBORAuth(h, "/v1/bot-runtime/installations/"+installationID.String()+"/interaction-admissions", mustCBOR(t, []any{requestID, group, participant, participantDevice}), token)
	if issued.Code != 200 {
		t.Fatalf("issue admission = %d %x", issued.Code, issued.Body.Bytes())
	}
	session, err := deps.Sessions.Resolve(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	load := func(request api.BotInteractionPreflightRequest) error {
		_, err := deps.LoadBotInteractionRegistrationPreflight(ctx, request)
		return err
	}
	base := api.BotInteractionPreflightRequest{Session: session, InstallationID: installationID, AdmissionRequestID: requestID, GroupID: group, ParticipantUserID: participant, ParticipantDeviceID: participantDevice}
	preflight, err := deps.LoadBotInteractionRegistrationPreflight(ctx, base)
	if err != nil || preflight.ExpectedPolicyVersion != 7 || preflight.MinimumEligibilityRevision == 0 || preflight.Now != uint64(now) {
		t.Fatalf("load current preflight = %+v, %v", preflight, err)
	}
	wrongGroup := base
	wrongGroup.GroupID = id.New()
	if err := load(wrongGroup); err == nil {
		t.Fatal("conflicting group identifier accepted")
	}
	wrongInstallation := base
	wrongInstallation.InstallationID = id.New()
	if err := load(wrongInstallation); err == nil {
		t.Fatal("wrong installation accepted")
	}
	wrongRole := base
	wrongBinding := *base.Session.Bot
	wrongBinding.State = store.BotInstallationDisabled
	wrongRole.Session.Bot = &wrongBinding
	if err := load(wrongRole); err == nil {
		t.Fatal("wrong Bot session role accepted")
	}
	disabledAt := deps.Clock.Now().Unix()
	if err := deps.Repo.Tx(ctx, func(tx store.Repository) error { return tx.SetUserDisabled(ctx, participant, &disabledAt) }); err != nil {
		t.Fatal(err)
	}
	if err := load(base); err == nil {
		t.Fatal("disabled participant accepted")
	}
	if err := deps.Repo.Tx(ctx, func(tx store.Repository) error { return tx.SetUserDisabled(ctx, participant, nil) }); err != nil {
		t.Fatal(err)
	}
	if err := load(base); err == nil {
		t.Fatal("receipt with stale eligibility revision accepted")
	}
	newGroup, newRequestID := id.New(), id.New()
	renewed := postCBORAuth(h, "/v1/bot-runtime/installations/"+installationID.String()+"/interaction-admissions", mustCBOR(t, []any{newRequestID, newGroup, participant, participantDevice}), token)
	if renewed.Code != 200 {
		t.Fatalf("issue fresh admission = %d %x", renewed.Code, renewed.Body.Bytes())
	}
	fresh := base
	fresh.GroupID, fresh.AdmissionRequestID = newGroup, newRequestID
	if _, err := deps.LoadBotInteractionRegistrationPreflight(ctx, fresh); err != nil {
		t.Fatalf("fresh revision preflight: %v", err)
	}
	if err := deps.Repo.RevokeDevice(ctx, participantDevice, deps.Clock.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if err := load(fresh); err == nil {
		t.Fatal("revoked participant device accepted")
	}
	if advance, ok := deps.Clock.(interface{ Advance(time.Duration) }); ok {
		advance.Advance(31 * time.Second)
	} else {
		t.Fatal("test clock cannot advance")
	}
	if err := load(fresh); err == nil {
		t.Fatal("expired admission receipt accepted")
	}
}
