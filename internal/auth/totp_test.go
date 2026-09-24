package auth_test

import (
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/config"
	"github.com/pquerna/otp/totp"
)

func totpParams() auth.TOTPParams {
	c := config.Default().Auth.TOTP
	c.Issuer = "chat.example"
	return auth.TOTPParams{Issuer: c.Issuer, Period: c.Period, Skew: c.Skew,
		SecretSize: c.SecretSize, Digits: c.Digits, Algorithm: c.Algorithm}
}

func TestTOTPValidatesAtSkewOneAndRefusesBeyondIt(t *testing.T) {
	secret, url, err := auth.GenerateTOTP("chat.example", "jonas", totpParams())
	if err != nil {
		t.Fatalf("GenerateTOTP: %v", err)
	}
	if len(secret) != 32 {
		t.Fatalf("secret is %d base32 characters, want 32 (20 bytes)", len(secret))
	}
	if url == "" {
		t.Fatal("no otpauth URL")
	}
	now := time.Unix(1_700_000_000, 0)
	code, err := totp.GenerateCode(secret, now)
	if err != nil {
		t.Fatalf("GenerateCode: %v", err)
	}
	for _, offset := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		if _, ok := auth.ValidateTOTP(code, secret, totpParams(), now.Add(offset)); !ok {
			t.Fatalf("code refused at offset %s; skew 1 accepts one period either side", offset)
		}
	}
	if _, ok := auth.ValidateTOTP(code, secret, totpParams(), now.Add(90*time.Second)); ok {
		t.Fatal("a code three periods away was accepted")
	}
}

func TestTOTPCounterIsReturnedForTheReplayGuard(t *testing.T) {
	secret, _, err := auth.GenerateTOTP("chat.example", "jonas", totpParams())
	if err != nil {
		t.Fatalf("GenerateTOTP: %v", err)
	}
	now := time.Unix(1_700_000_000, 0)
	code, _ := totp.GenerateCode(secret, now)
	counter, ok := auth.ValidateTOTP(code, secret, totpParams(), now)
	if !ok {
		t.Fatal("the code did not validate")
	}
	if counter != now.Unix()/30 {
		t.Fatalf("counter = %d, want %d: the store's ConsumeTOTPCounter needs the accepted counter, not the current one",
			counter, now.Unix()/30)
	}
}

func TestAMalformedSecretIsAnErrorNotASilentFalse(t *testing.T) {
	if _, ok := auth.ValidateTOTP("123456", "not base32!", totpParams(), time.Now()); ok {
		t.Fatal("a malformed secret validated a code")
	}
}
