package mlswasi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

type nativeBotKeyPackagesFixture struct {
	GeneratedAt   uint64 `json:"generated_at"`
	UserIDHex     string `json:"user_id_hex"`
	DeviceIDHex   string `json:"device_id_hex"`
	UMKPublicHex  string `json:"umk_public_hex"`
	SSKPublicHex  string `json:"ssk_public_hex"`
	SigUMKSSKHex  string `json:"sig_umk_ssk_hex"`
	DSKPublicHex  string `json:"dsk_public_hex"`
	CredentialHex string `json:"credential_hex"`
	Batches       []struct {
		Ordinary []struct {
			KeyPackageBase64 string `json:"key_package_base64"`
			KeyPackageRefHex string `json:"key_package_ref_hex"`
			LastResort       bool   `json:"last_resort"`
		} `json:"ordinary"`
		Fallback struct {
			KeyPackageBase64 string `json:"key_package_base64"`
			KeyPackageRefHex string `json:"key_package_ref_hex"`
			LastResort       bool   `json:"last_resort"`
		} `json:"fallback"`
	} `json:"batches"`
}

func TestNativeBotFixtureCredentialMatchesValidatedPackageAndVerifies(t *testing.T) {
	raw, err := os.ReadFile("testdata/native_bot_keypackages.json")
	if err != nil {
		t.Fatalf("read native Bot fixture: %v", err)
	}
	var fixture nativeBotKeyPackagesFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode native Bot fixture: %v", err)
	}
	if fixture.GeneratedAt == 0 || len(fixture.Batches) != 2 {
		t.Fatalf("fixture shape: generated_at=%d batches=%d, want nonzero timestamp and two batches", fixture.GeneratedAt, len(fixture.Batches))
	}
	for i, batch := range fixture.Batches {
		if len(batch.Ordinary) != 32 || batch.Fallback.KeyPackageBase64 == "" {
			t.Fatalf("batch %d shape: ordinary=%d fallback-present=%t, want 32 ordinary and one fallback", i, len(batch.Ordinary), batch.Fallback.KeyPackageBase64 != "")
		}
		if batch.Fallback.LastResort != true {
			t.Fatalf("batch %d fallback last_resort = %t, want true", i, batch.Fallback.LastResort)
		}
		for j, packageRecord := range batch.Ordinary {
			if packageRecord.LastResort {
				t.Fatalf("batch %d ordinary package %d is marked last_resort", i, j)
			}
		}
	}
	decode := func(label, value string) []byte {
		t.Helper()
		out, err := hex.DecodeString(value)
		if err != nil {
			t.Fatalf("decode %s: %v", label, err)
		}
		return out
	}
	wantCredential := decode("credential", fixture.CredentialHex)
	wantUser := decode("user id", fixture.UserIDHex)
	wantDevice := decode("device id", fixture.DeviceIDHex)
	wantUMK := decode("UMK public key", fixture.UMKPublicHex)
	wantSSK := decode("SSK public key", fixture.SSKPublicHex)
	wantSigUMKSSK := decode("UMK signature", fixture.SigUMKSSKHex)
	dsk := decode("DSK public key", fixture.DSKPublicHex)
	ctx := context.Background()
	runtime, err := New(ctx, loadWasm(t), Options{
		PoolSize: 1,
		CacheDir: sharedCacheDir(t),
		Now:      func() time.Time { return time.Unix(int64(fixture.GeneratedAt)+30, 0) },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close(context.Background()) })
	instance, err := runtime.Acquire(ctx)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer instance.Release()

	verifyPackage := func(label string, packageRecord struct {
		KeyPackageBase64 string `json:"key_package_base64"`
		KeyPackageRefHex string `json:"key_package_ref_hex"`
		LastResort       bool   `json:"last_resort"`
	}, wantLastResort bool) {
		t.Helper()
		if packageRecord.LastResort != wantLastResort {
			t.Fatalf("%s fixture last_resort = %t, want %t", label, packageRecord.LastResort, wantLastResort)
		}
		keyPackage, err := base64.StdEncoding.DecodeString(packageRecord.KeyPackageBase64)
		if err != nil {
			t.Fatalf("decode %s KeyPackage: %v", label, err)
		}
		info, err := instance.ValidateKeyPackage(ctx, keyPackage)
		if err != nil {
			t.Fatalf("validate %s Bot KeyPackage: %v", label, err)
		}
		if info.LastResort != wantLastResort {
			t.Fatalf("%s validated last_resort = %t, want %t", label, info.LastResort, wantLastResort)
		}
		if !equalBytes(info.Credential, wantCredential) {
			t.Fatalf("%s ABI8 credential differs from the fixture's final signed Bot identity", label)
		}
		if !equalBytes(info.UserID, wantUser) || !equalBytes(info.DeviceID, wantDevice) {
			t.Fatalf("%s validated user/device = %x/%x, fixture = %x/%x", label, info.UserID, info.DeviceID, wantUser, wantDevice)
		}
		if !equalBytes(info.SignatureKey, dsk) {
			t.Fatalf("%s validated leaf DSK = %x, fixture = %x", label, info.SignatureKey, dsk)
		}
		wantRef := decode(label+" KeyPackageRef", packageRecord.KeyPackageRefHex)
		if !equalBytes(info.KPRef, wantRef) {
			t.Fatalf("%s validated KeyPackageRef = %x, fixture = %x", label, info.KPRef, wantRef)
		}
		verified, err := instance.VerifyCredential(ctx, info.Credential, dsk)
		if err != nil {
			t.Fatalf("WASI VerifyCredential on exact %s leaf credential: %v", label, err)
		}
		if !equalBytes(verified.UserID[:], wantUser) || !equalBytes(verified.DeviceID[:], wantDevice) {
			t.Fatalf("%s VerifyCredential user/device = %x/%x, fixture = %x/%x", label, verified.UserID, verified.DeviceID, wantUser, wantDevice)
		}
		if verified.Kind != 1 || verified.Tier != 0 || verified.SignerTier != 0 {
			t.Fatalf("%s verified Bot kind/tier/signer-tier = %d/%d/%d, want 1/0/0", label, verified.Kind, verified.Tier, verified.SignerTier)
		}
		if !equalBytes(verified.UMKPub[:], wantUMK) || !equalBytes(verified.SSKPub[:], wantSSK) || !equalBytes(verified.SigUMKSSK[:], wantSigUMKSSK) {
			t.Fatalf("%s VerifyCredential public identity/signature fields differ from the fixture", label)
		}
	}

	for i, batch := range fixture.Batches {
		for j, packageRecord := range batch.Ordinary {
			verifyPackage("batch "+itoa(i)+" ordinary "+itoa(j), packageRecord, false)
		}
		verifyPackage("batch "+itoa(i)+" fallback", batch.Fallback, true)
	}
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
