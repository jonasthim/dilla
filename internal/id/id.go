// Package id holds dilla's identifier type: 16 bytes from the platform CSPRNG.
//
// The wave-1 spec said ULIDs; ruling R24 replaced them with raw CSPRNG bytes,
// because a ULID leaks its creation time, needs a third-party package whose
// Make() draws from math/rand, and buys nothing the database does not already
// give. On the wire an id is a CBOR byte string of length 16; in a URL path it
// is 32 lowercase hex characters; in SQL it is BLOB(16) or BYTEA(16).
package id

import (
	"crypto/rand"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/fxamacker/cbor/v2"
)

// Size is the length of an identifier in bytes.
const Size = 16

// ID is a dilla identifier.
type ID [Size]byte

// Zero is the identifier no row may hold.
var Zero ID

var errNotSixteen = errors.New("id: not 16 bytes")

// New draws a fresh identifier. crypto/rand.Read is documented never to fail;
// if it ever does, the process cannot mint identifiers and must not continue.
func New() ID {
	var v ID
	if _, err := rand.Read(v[:]); err != nil {
		panic("id: crypto/rand failed: " + err.Error())
	}
	return v
}

// Parse decodes exactly 32 lowercase hex characters.
func Parse(s string) (ID, error) {
	var v ID
	if len(s) != 2*Size {
		return v, fmt.Errorf("id: want %d hex characters, got %d", 2*Size, len(s))
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
		if !ok {
			return v, fmt.Errorf("id: %q is not lowercase hex", s)
		}
	}
	if _, err := hex.Decode(v[:], []byte(s)); err != nil {
		return ID{}, fmt.Errorf("id: %w", err)
	}
	return v, nil
}

// String renders 32 lowercase hex characters.
func (i ID) String() string { return hex.EncodeToString(i[:]) }

// IsZero reports whether the identifier is all zero bytes.
func (i ID) IsZero() bool { return i == Zero }

// Value implements driver.Valuer: a 16-byte blob.
func (i ID) Value() (driver.Value, error) { return append([]byte(nil), i[:]...), nil }

// Scan implements sql.Scanner for BLOB(16) and BYTEA(16).
func (i *ID) Scan(src any) error {
	switch v := src.(type) {
	case []byte:
		if len(v) != Size {
			return fmt.Errorf("id: scan %d bytes: %w", len(v), errNotSixteen)
		}
		copy(i[:], v)
		return nil
	case string:
		if len(v) != Size {
			return fmt.Errorf("id: scan %d bytes: %w", len(v), errNotSixteen)
		}
		copy(i[:], v)
		return nil
	case nil:
		return errors.New("id: cannot scan NULL into a non-null id")
	default:
		return fmt.Errorf("id: cannot scan %T", src)
	}
}

// MarshalCBOR emits a byte string of length 16 (0x50 plus the bytes).
func (i ID) MarshalCBOR() ([]byte, error) {
	out := make([]byte, 0, 1+Size)
	out = append(out, 0x50)
	return append(out, i[:]...), nil
}

// UnmarshalCBOR accepts only a definite-length byte string of exactly 16 bytes.
func (i *ID) UnmarshalCBOR(b []byte) error {
	if len(b) != 1+Size || b[0] != 0x50 {
		return fmt.Errorf("id: want a 16-byte CBOR byte string, got %d bytes starting %#x: %w", len(b), firstByte(b), errNotSixteen)
	}
	copy(i[:], b[1:])
	return nil
}

func firstByte(b []byte) byte {
	if len(b) == 0 {
		return 0
	}
	return b[0]
}

// Compile-time proof that ID satisfies the four interfaces it claims.
var (
	_ driver.Valuer  = ID{}
	_ cbor.Marshaler = ID{}
)
