package api_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/api"
	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/bot/capability"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
	"github.com/jonasthim/dilla/internal/store/sqlite"
	sqlitemigrations "github.com/jonasthim/dilla/internal/store/sqlite/migrations"
	"github.com/pressly/goose/v3"
	_ "modernc.org/sqlite"
)

const kind3APIFixtureDir = "../ds/dstest/testdata/kind3-interaction"

type kind3APIAdmission struct {
	_                   struct{} `cbor:",toarray"`
	Version             uint64
	AdmissionID         id.ID
	InstanceID          id.ID
	InstallationID      id.ID
	CommunityID         id.ID
	BotUserID           id.ID
	BotDeviceID         id.ID
	ParticipantUserID   id.ID
	ParticipantDeviceID id.ID
	GroupID             id.ID
	EligibilityRevision uint64
	NotAfter            uint64
}

type kind3APICredential struct {
	_          struct{} `cbor:",toarray"`
	Version    uint64
	UMKPub     []byte
	UserID     []byte
	DeviceID   []byte
	Kind       uint64
	Tier       uint64
	SignerTier uint64
	SSKPub     []byte
	SigUMKSSK  []byte
	SigSSKDev  []byte
}

type kind3APIMetadata struct {
	InstanceID          string `json:"instance_id_hex"`
	BotUserID           string `json:"bot_user_id_hex"`
	BotDeviceID         string `json:"bot_device_id_hex"`
	BotDSK              string `json:"bot_dsk_public_hex"`
	BotSSK              string `json:"bot_ssk_public_hex"`
	InstallationID      string `json:"installation_id_hex"`
	CommunityID         string `json:"community_id_hex"`
	ParticipantUserID   string `json:"participant_user_id_hex"`
	ParticipantDeviceID string `json:"participant_device_id_hex"`
	ParticipantDSK      string `json:"participant_dsk_public_hex"`
	ParticipantSSK      string `json:"participant_ssk_public_hex"`
	BindingHex          string `json:"binding_cbor_hex"`
	PolicyVersion       uint64 `json:"policy_version"`
}

type fixedKind3InstanceRepo struct{ store.Repository }

func (r fixedKind3InstanceRepo) CreateInstance(ctx context.Context, row store.InstanceRow) error {
	for i := range row.InstanceID {
		row.InstanceID[i] = 0x11
	}
	for i := range row.ExternalSenderKeyID {
		row.ExternalSenderKeyID[i] = 0x22
	}
	for i := range row.FrankingKeyID {
		row.FrankingKeyID[i] = 0x33
	}
	return r.Repository.CreateInstance(ctx, row)
}

func newKind3HTTPAPI(t *testing.T) (*groupsAPI, kind3APIMetadata, map[string][]byte) {
	t.Helper()
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "kind3-api.db")
	write, err := sqlite.OpenWrite(path)
	if err != nil {
		t.Fatal(err)
	}
	p, err := goose.NewProvider(goose.DialectSQLite3, write, sqlitemigrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.Up(ctx); err != nil {
		t.Fatal(err)
	}
	read, err := sqlite.OpenRead(path)
	if err != nil {
		t.Fatal(err)
	}
	repo := fixedKind3InstanceRepo{sqlite.New(write, read)}
	t.Cleanup(func() { _ = repo.Close() })
	handler, deps := newTestAPIFullWithRepo(t, repo, nil, nil)
	mux, ok := handler.(*server.Mux)
	if !ok {
		t.Fatalf("test API mux type=%T", handler)
	}
	f := apiFixtureData(t)
	clk := clock.NewFake(time.Unix(time.Now().Unix(), 0))
	wasm, err := mlswasi.New(ctx, f.wasm, mlswasi.Options{PoolSize: 2, CacheDir: apiWasmCacheDir(t), Now: clk.Now})
	if err != nil {
		t.Fatalf("start real WASI: %v", err)
	}
	t.Cleanup(func() { _ = wasm.Close(context.Background()) })
	botCapability := capability.New(deps.Repo)
	gw := gateway.New(gateway.Options{Clock: clk, Store: apiListenStore{apiGatewayStore{deps.Repo}}, Generation: 1,
		Auth: deps.Sessions, WireVersions: []uint64{3, 2}, E2EEVersions: []uint64{1}, MediaVersions: []uint64{1},
		ScopeResolver: apiGatewayScopeResolver{repo: deps.Repo}, CommunityCompatibility: botCapability})
	t.Cleanup(func() { _ = gw.Shutdown(context.Background()) })
	keys := ds.InstanceKeys{}
	for i := range keys.InstanceID {
		keys.InstanceID[i] = 0x11
	}
	for i := range keys.ExternalSenderKeyID {
		keys.ExternalSenderKeyID[i] = 0x22
	}
	for i := range keys.FrankingKeyID {
		keys.FrankingKeyID[i] = 0x33
	}
	keys.ExternalSenderPriv = fixtureExternalSenderKey()
	for i := range keys.FrankingKey {
		keys.FrankingKey[i] = byte(0x80 + i)
	}
	delivery, err := ds.New(ds.Options{Store: deps.Repo, Wasm: wasm, Gateway: gw, Clock: clk, BotCapability: botCapability,
		Policy: ds.DefaultPolicy(), Keys: keys, Channels: openChannels{}, DeviceLists: ds.NewDeviceLists(deps.Repo, wasm)})
	if err != nil {
		t.Fatalf("ds.New: %v", err)
	}
	t.Cleanup(func() { _ = delivery.Shutdown(context.Background()) })
	groups := &api.Groups{DS: delivery, MaxBody: 1 << 21}
	groups.Register(mux, deps.Sessions)
	groups.RegisterSequencer(mux, deps.Sessions)
	groups.RegisterRecovery(mux, deps.Sessions)
	user, _, sessionToken := seedAPISession(t, deps)
	h := &groupsAPI{mux: mux, deps: deps, ds: delivery, groups: groups, groupID: f.groupID, fixture: f,
		session: sessionToken, user: user.ID, clk: clk, wasm: wasm, keys: keys, gw: gw}
	// Align the API and delivery-service clocks so a freshly signed proof is fresh to both.
	if delta := h.clk.Now().Sub(h.deps.Clock.Now()); delta > 0 {
		h.deps.Clock.(interface{ Advance(time.Duration) }).Advance(delta)
	}

	readFixture := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join(kind3APIFixtureDir, name))
		if err != nil {
			t.Fatalf("read kind-3 fixture %s: %v", name, err)
		}
		return b
	}
	var meta kind3APIMetadata
	if err := json.Unmarshal(readFixture("metadata.json"), &meta); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	decodeID := func(s string) id.ID {
		var out id.ID
		b := decode(s)
		if len(b) != len(out) {
			t.Fatalf("invalid fixture ID %q", s)
		}
		copy(out[:], b)
		return out
	}
	botUser, botDevice := decodeID(meta.BotUserID), decodeID(meta.BotDeviceID)
	participant, participantDevice := decodeID(meta.ParticipantUserID), decodeID(meta.ParticipantDeviceID)
	community, installation, groupID := decodeID(meta.CommunityID), decodeID(meta.InstallationID), mustFixtureGroupID(t, readFixture("metadata.json"))
	botCredential, participantCredential := readFixture("bot_credential.cbor"), readFixture("participant_credential.cbor")
	var botIdentity, participantIdentity kind3APICredential
	if err := cborx.Unmarshal(botCredential, &botIdentity); err != nil {
		t.Fatal(err)
	}
	if err := cborx.Unmarshal(participantCredential, &participantIdentity); err != nil {
		t.Fatal(err)
	}
	botSSK, participantSSK := decode(meta.BotSSK), decode(meta.ParticipantSSK)
	botDSK, participantDSK := decode(meta.BotDSK), decode(meta.ParticipantDSK)
	now := h.deps.Clock.Now().Unix()
	verified := now
	for _, user := range []store.UserRow{
		{ID: botUser, Username: "k3bot" + botUser.String()[:8], Display: "Kind 3 Bot", Kind: 1, UMKPub: botIdentity.UMKPub, SSKPub: botSSK, SigUMKSSK: botIdentity.SigUMKSSK, Created: now},
		{ID: participant, Username: "k3human" + participant.String()[:8], Display: "Kind 3 Human", Kind: 0, UMKPub: participantIdentity.UMKPub, SSKPub: participantSSK, SigUMKSSK: participantIdentity.SigUMKSSK, Created: now},
	} {
		if err := h.deps.Repo.CreateUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	for _, device := range []store.DeviceRow{
		{ID: botDevice, UserID: botUser, DSKPub: botDSK, CredentialBlob: botCredential, VerifiedAt: &verified, Created: now, LastSeen: now},
		{ID: participantDevice, UserID: participant, DSKPub: participantDSK, CredentialBlob: participantCredential, VerifiedAt: &verified, Created: now, LastSeen: now},
	} {
		if err := h.deps.Repo.CreateDevice(ctx, device); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.deps.Repo.CreateCommunity(ctx, store.CommunityRow{ID: community, Owner: participant, Name: "kind3-http", PolicyJSON: []byte(`{}`), PolicyVersion: meta.PolicyVersion, Created: now}); err != nil {
		t.Fatal(err)
	}
	for _, user := range []id.ID{botUser, participant} {
		if err := h.deps.Repo.PutMember(ctx, store.MemberOfCommunityRow{CommunityID: community, UserID: user, Joined: now}); err != nil {
			t.Fatal(err)
		}
	}
	for _, list := range []struct {
		user id.ID
		name string
	}{{botUser, "bot_device_list.cbor"}, {participant, "participant_device_list.cbor"}} {
		blob := readFixture(list.name)
		if len(blob) < ed25519.SignatureSize {
			t.Fatal("short signed device list fixture")
		}
		if err := h.deps.Repo.PutDeviceList(ctx, store.DeviceListRow{UserID: list.user, Version: 1, Blob: blob, SSKSignature: blob[len(blob)-ed25519.SignatureSize:], PrevHash: make([]byte, 32), Created: now}); err != nil {
			t.Fatal(err)
		}
	}
	runtime := store.BotRuntimeRow{ID: id.New(), TokenHash: bytes.Repeat([]byte{0x41}, 32), Created: now, Rotated: now}
	if err := h.deps.Repo.CreateBotRuntime(ctx, runtime); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.Repo.CreateBotInstallation(ctx, store.BotInstallationRow{ID: installation, CommunityID: community, RuntimeID: &runtime.ID, UserID: &botUser, DeviceID: &botDevice, State: store.BotInstallationJoining, Revision: 1, ApprovedBy: participant, ApprovedAt: now, CredentialVerifiedAt: &verified, Created: now, Updated: now}); err != nil {
		t.Fatal(err)
	}
	token := "kind3-http-acceptance"
	tokenHash := auth.TokenHash(token)
	if err := h.deps.Repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.CreateSession(ctx, store.SessionRow{TokenHash: tokenHash, DeviceID: botDevice, UserID: botUser, Scope: uint8(auth.ScopeEnrolled), Created: now, Expires: now + 3600, IdleExpires: now + 3600}); err != nil {
			return err
		}
		return tx.CreateBotSessionBinding(ctx, store.BotSessionBindingRow{TokenHash: tokenHash, InstallationID: installation, UserID: botUser, DeviceID: botDevice, Created: now})
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.Sessions.RecordCapabilities(ctx, tokenHash, 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	instance, err := h.deps.Repo.GetInstance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	h.deps.Instance = instance
	externalSenderSeed := fixtureExternalSenderKey()
	externalSenderKey := ed25519.NewKeyFromSeed(externalSenderSeed[:])
	h.deps.ExternalSenderPub = externalSenderKey.Public().(ed25519.PublicKey)
	h.deps.DeviceLists = ds.NewDeviceLists(h.deps.Repo, h.wasm)
	h.groups.LoadBotInteractionPreflight = h.deps.LoadBotInteractionRegistrationPreflight

	if _, ok := h.deps.Repo.(store.BotInteractionEligibility); !ok {
		t.Fatal("repository lacks interaction eligibility")
	}
	var revision uint64
	if err := h.deps.Repo.Tx(ctx, func(tx store.Repository) error {
		var e error
		revision, e = tx.(store.BotInteractionEligibility).GetBotInteractionEligibilityRevision(ctx, community, participant)
		return e
	}); err != nil || revision == 0 {
		t.Fatalf("eligibility revision=%d err=%v", revision, err)
	}
	requestID, admissionID := id.New(), id.New()
	notAfter := uint64(h.deps.Clock.Now().Unix() + 60)
	payload, err := cborx.Marshal(kind3APIAdmission{Version: 1, AdmissionID: admissionID, InstanceID: instance.InstanceID, InstallationID: installation, CommunityID: community, BotUserID: botUser, BotDeviceID: botDevice, ParticipantUserID: participant, ParticipantDeviceID: participantDevice, GroupID: groupID, EligibilityRevision: revision, NotAfter: notAfter})
	if err != nil {
		t.Fatal(err)
	}
	signer := externalSenderKey
	sig := ed25519.Sign(signer, append([]byte("dilla bot interaction admission v1\x00"), payload...))
	requestBytes, err := cborx.Marshal([]any{groupID, participant, participantDevice})
	if err != nil {
		t.Fatal(err)
	}
	requestHash := sha256.Sum256(requestBytes)
	if err := h.deps.Repo.Tx(ctx, func(tx store.Repository) error {
		return tx.(store.BotInteractionAdmissionReceipts).CreateBotInteractionAdmissionReceipt(ctx, store.BotInteractionAdmissionReceipt{InstallationID: installation, RequestID: requestID, RequestHash: requestHash[:], Payload: payload, Signature: sig, NotAfter: int64(notAfter)})
	}); err != nil {
		t.Fatal(err)
	}
	return h, meta, map[string][]byte{"token": []byte(token), "request": requestID[:], "admission": admissionID[:], "registration": mustCBOR(t, []any{groupID, decode(meta.BindingHex), readFixture("group_info.mls"), readFixture("ratchet_tree.mls")})}
}

func mustFixtureGroupID(t *testing.T, metadata []byte) id.ID {
	t.Helper()
	var m struct {
		Group string `json:"group_id_hex"`
	}
	if err := json.Unmarshal(metadata, &m); err != nil {
		t.Fatal(err)
	}
	b, err := hex.DecodeString(m.Group)
	if err != nil || len(b) != 16 {
		t.Fatal("invalid group id in fixture")
	}
	var out id.ID
	copy(out[:], b)
	return out
}

func TestBotInteractionHTTPGroupRegistrationAcceptanceReplayAndRefusals(t *testing.T) {
	h, meta, fixture := newKind3HTTPAPI(t)
	ctx := context.Background()
	token := string(fixture["token"])
	requestID, admissionID := id.ID{}, id.ID{}
	copy(requestID[:], fixture["request"])
	copy(admissionID[:], fixture["admission"])
	groupID := mustFixtureGroupID(t, mustReadKind3Metadata(t))
	instance, err := h.deps.Repo.GetInstance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	operation := id.New()
	path := "/v1/bot-runtime/installations/" + meta.InstallationID + "/groups"
	body := mustCBOR(t, []any{operation, instance.Generation, fixture["registration"], requestID})
	var hookCalls atomic.Int32
	h.groups.AfterRegister = func(context.Context, id.ID) { hookCalls.Add(1) }
	created := h.do(t, http.MethodPost, path, token, body)
	if created.Code != http.StatusCreated {
		_, groupErr := h.deps.Repo.GetGroup(ctx, groupID)
		t.Fatalf("kind-3 HTTP registration: %d %x, want 201; group lookup after failure: %v", created.Code, created.Body.Bytes(), groupErr)
	}
	if _, err := h.deps.Repo.GetGroup(ctx, groupID); err != nil {
		t.Fatalf("accepted group missing: %v", err)
	}
	members, err := h.deps.Repo.ListMembers(ctx, groupID)
	if err != nil || len(members) != 2 {
		t.Fatalf("authenticated roster=%d err=%v, want two members", len(members), err)
	}
	if err := h.groups.Drain(ctx); err != nil {
		t.Fatalf("drain after acceptance: %v", err)
	}
	if hookCalls.Load() != 0 {
		t.Fatalf("AfterRegister ran for kind-3 interaction: %d calls", hookCalls.Load())
	}

	// Expire and compact the server proof. A new valid Bot session then exercises only the durable
	// operation+admission-consumption replay path through HTTP.
	h.deps.Clock.(interface{ Advance(time.Duration) }).Advance(31 * 24 * time.Hour)
	h.clk.Advance(31 * 24 * time.Hour)
	compactAt := h.deps.Clock.Now().Unix()
	if err := h.deps.Repo.Tx(ctx, func(tx store.Repository) error {
		return tx.(store.BotInteractionAdmissionReceipts).CompactExpiredBotInteractionAdmissionReceipts(ctx, idFromHex(t, meta.InstallationID), compactAt)
	}); err != nil {
		t.Fatal(err)
	}
	newToken := "kind3-http-replay-after-compaction"
	newHash := auth.TokenHash(newToken)
	now := h.deps.Clock.Now().Unix()
	if err := h.deps.Repo.Tx(ctx, func(tx store.Repository) error {
		if err := tx.CreateSession(ctx, store.SessionRow{TokenHash: newHash, DeviceID: idFromHex(t, meta.BotDeviceID), UserID: idFromHex(t, meta.BotUserID), Scope: uint8(auth.ScopeEnrolled), Created: now, Expires: now + 3600, IdleExpires: now + 3600}); err != nil {
			return err
		}
		return tx.CreateBotSessionBinding(ctx, store.BotSessionBindingRow{TokenHash: newHash, InstallationID: idFromHex(t, meta.InstallationID), UserID: idFromHex(t, meta.BotUserID), DeviceID: idFromHex(t, meta.BotDeviceID), Created: now})
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.deps.Sessions.RecordCapabilities(ctx, newHash, 3, 1, 1); err != nil {
		t.Fatal(err)
	}
	replay := h.do(t, http.MethodPost, path, newToken, body)
	if replay.Code != http.StatusOK || !bytes.Equal(replay.Body.Bytes(), created.Body.Bytes()) {
		t.Fatalf("exact replay after proof compaction: %d %x, want %x", replay.Code, replay.Body.Bytes(), created.Body.Bytes())
	}
	if err := h.groups.Drain(ctx); err != nil {
		t.Fatalf("drain after replay: %v", err)
	}
	if hookCalls.Load() != 0 {
		t.Fatalf("AfterRegister ran on kind-3 replay: %d calls", hookCalls.Load())
	}

	var registrationTuple []any
	if err := cborx.Unmarshal(fixture["registration"], &registrationTuple); err != nil || len(registrationTuple) != 4 {
		t.Fatalf("decode fixture registration: %v", err)
	}
	tree, ok := registrationTuple[3].([]byte)
	if !ok {
		t.Fatal("fixture registration tree is not bytes")
	}
	conflictingTree := append(append([]byte(nil), tree...), 0)
	conflictingRegistration := mustCBOR(t, []any{registrationTuple[0], registrationTuple[1], registrationTuple[2], conflictingTree})
	conflictingBody := h.do(t, http.MethodPost, path, newToken, mustCBOR(t, []any{operation, instance.Generation, conflictingRegistration, requestID}))
	if conflictingBody.Code < 400 {
		t.Fatalf("changed registration body accepted: %d", conflictingBody.Code)
	}
	conflictingOperation := h.do(t, http.MethodPost, path, newToken, mustCBOR(t, []any{id.New(), instance.Generation, fixture["registration"], requestID}))
	if conflictingOperation.Code < 400 {
		t.Fatalf("consumed admission under a different operation accepted: %d", conflictingOperation.Code)
	}
	wrongAdmission := id.New()
	conflictingAdmission := h.do(t, http.MethodPost, path, newToken, mustCBOR(t, []any{operation, instance.Generation, fixture["registration"], wrongAdmission}))
	if conflictingAdmission.Code < 400 {
		t.Fatalf("different admission request accepted: %d", conflictingAdmission.Code)
	}
	unauthorized := h.do(t, http.MethodPost, path, h.session, body)
	if unauthorized.Code < 400 {
		t.Fatalf("non-Bot session accepted kind-3 registration: %d", unauthorized.Code)
	}
	crossInstallation := h.do(t, http.MethodPost, "/v1/bot-runtime/installations/"+id.New().String()+"/groups", newToken, body)
	if crossInstallation.Code < 400 {
		t.Fatalf("cross-installation registration accepted: %d", crossInstallation.Code)
	}
	if err := h.groups.Drain(ctx); err != nil {
		t.Fatalf("drain after refusals: %v", err)
	}
	if hookCalls.Load() != 0 {
		t.Fatalf("AfterRegister ran after refusals: %d calls", hookCalls.Load())
	}
}

func idFromHex(t *testing.T, s string) id.ID {
	t.Helper()
	x, err := id.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return x
}
func mustReadKind3Metadata(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(kind3APIFixtureDir, "metadata.json"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
