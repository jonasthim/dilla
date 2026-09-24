package auth

import (
	"crypto/rand"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

type TOTPParams struct {
	Issuer     string
	Period     uint
	Skew       uint
	SecretSize uint
	Digits     int
	Algorithm  string
}

func (p TOTPParams) digits() otp.Digits {
	if p.Digits == 8 {
		return otp.DigitsEight
	}
	return otp.DigitsSix
}

func (p TOTPParams) algorithm() otp.Algorithm {
	switch p.Algorithm {
	case "SHA256":
		return otp.AlgorithmSHA256
	case "SHA512":
		return otp.AlgorithmSHA512
	default:
		return otp.AlgorithmSHA1
	}
}

// GenerateTOTP mints an enrolment secret and its otpauth:// URL.
func GenerateTOTP(issuer, account string, p TOTPParams) (string, string, error) {
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer: issuer, AccountName: account, Period: p.Period,
		SecretSize: p.SecretSize, Digits: p.digits(), Algorithm: p.algorithm(), Rand: rand.Reader,
	})
	if err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

// ValidateTOTP checks code and returns the counter it validated at, which is
// what the store's replay guard compares against last_counter. The library is
// stateless and will happily accept the same code three times inside the skew
// window, so the counter is not optional.
//
// ValidateCustom, not Validate: Validate returns a bare bool, so a malformed
// base32 secret would look like a wrong code.
func ValidateTOTP(code, secret string, p TOTPParams, now time.Time) (int64, bool) {
	opts := totp.ValidateOpts{Period: p.Period, Skew: p.Skew, Digits: p.digits(), Algorithm: p.algorithm()}
	period := int64(p.Period)
	if period == 0 {
		period = 30
	}
	for offset := -int64(p.Skew); offset <= int64(p.Skew); offset++ {
		at := now.Add(time.Duration(offset*period) * time.Second)
		exact := totp.ValidateOpts{Period: p.Period, Skew: 0, Digits: opts.Digits, Algorithm: opts.Algorithm}
		ok, err := totp.ValidateCustom(code, secret, at, exact)
		if err != nil {
			return 0, false
		}
		if ok {
			return at.Unix() / period, true
		}
	}
	return 0, false
}
