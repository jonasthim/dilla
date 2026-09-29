package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
)

const (
	inviteCodeLen = 26 // crypto/rand.Text(): 26 base32 characters, 130 bits
	maxAmbiguous  = 4  // at most 2^4 = 16 candidates are ever looked up
)

var (
	ErrInviteLength    = errors.New("auth: an invite code is 26 characters")
	ErrInviteAlphabet  = errors.New("auth: an invite code is RFC 4648 base32")
	ErrInviteAmbiguous = errors.New("auth: too many ambiguous characters in the invite code")
)

// NewInviteCode mints a code and its storage hash. The code itself is never
// stored: the database holds SHA-256 of its canonical form, so a database leak
// does not hand out accounts on an invite-only instance.
func NewInviteCode() (string, []byte) {
	code := rand.Text() // 26 chars of "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
	return code, HashInviteCode(code)
}

// HashInviteCode hashes one canonical candidate.
func HashInviteCode(canonical string) []byte {
	sum := sha256.Sum256([]byte(canonical))
	return sum[:]
}

// CanonicalizeInviteCode turns what a human typed into the candidates to look
// up: hyphens and spaces stripped, upper-cased, and the base32 alphabet's four
// missing digits mapped to the letters they look like. 0 and 8 are unambiguous
// (O and B); 1 is not, so it yields both I and L, and the candidate list is the
// cross product — capped, because a code of 26 ambiguous characters would
// otherwise cost 67 million hashes.
func CanonicalizeInviteCode(s string) ([]string, error) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case '-', ' ', '\t', '\n':
			return -1
		default:
			return r
		}
	}, s)
	cleaned = strings.ToUpper(cleaned)
	if len(cleaned) != inviteCodeLen {
		return nil, fmt.Errorf("%w (got %d)", ErrInviteLength, len(cleaned))
	}
	ambiguous := strings.Count(cleaned, "1")
	if ambiguous > maxAmbiguous {
		return nil, ErrInviteAmbiguous
	}
	candidates := []string{""}
	for _, r := range cleaned {
		var options []rune
		switch {
		case r == '0':
			options = []rune{'O'}
		case r == '8':
			options = []rune{'B'}
		case r == '1':
			options = []rune{'I', 'L'}
		case r == '9':
			return nil, fmt.Errorf("%w: 9 is not in the alphabet", ErrInviteAlphabet)
		case r >= 'A' && r <= 'Z', r >= '2' && r <= '7':
			options = []rune{r}
		default:
			return nil, fmt.Errorf("%w: %q", ErrInviteAlphabet, r)
		}
		next := make([]string, 0, len(candidates)*len(options))
		for _, prefix := range candidates {
			for _, o := range options {
				next = append(next, prefix+string(o))
			}
		}
		candidates = next
	}
	return candidates, nil
}
