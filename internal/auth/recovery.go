package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

// GenerateRecoveryCodes returns n single-use codes and their SHA-256 hashes.
// Each code is 130 bits, comfortably over NIST's 112-bit threshold, so a plain
// approved hash is the right storage — no per-code salt and no password KDF.
func GenerateRecoveryCodes(n int) ([]string, [][]byte) {
	plain := make([]string, 0, n)
	hashes := make([][]byte, 0, n)
	for i := 0; i < n; i++ {
		code := rand.Text()
		plain = append(plain, format5(code))
		sum := sha256.Sum256([]byte(code))
		hashes = append(hashes, sum[:])
	}
	return plain, hashes
}

// format5 renders a code in five-character groups for transcription.
func format5(code string) string {
	var b strings.Builder
	for i, r := range code {
		if i > 0 && i%5 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// RecoveryCodeHash is the stored spelling of a code a user typed: the
// separators dropped, the case raised, then SHA-256. It is exported because the
// store consumes a recovery code BY HASH — ConsumeRecoveryCode's UPDATE is the
// single-use guard — so the API layer needs the same normalisation
// VerifyRecoveryCode applies, without holding the hash list itself.
func RecoveryCodeHash(code string) []byte {
	sum := sha256.Sum256([]byte(normaliseRecoveryCode(code)))
	return sum[:]
}

func normaliseRecoveryCode(code string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
}

// VerifyRecoveryCode returns the index of the matching hash, comparing in
// constant time so the position of a valid code is not leaked by timing.
func VerifyRecoveryCode(code string, hashes [][]byte) (int, bool) {
	sum := sha256.Sum256([]byte(normaliseRecoveryCode(code)))
	found := -1
	for i, h := range hashes {
		if subtle.ConstantTimeCompare(sum[:], h) == 1 {
			found = i
		}
	}
	return found, found >= 0
}
