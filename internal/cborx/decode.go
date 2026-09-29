package cborx

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sync"
	"unicode/utf8"

	"github.com/fxamacker/cbor/v2"
)

// The rejection vocabulary, one sentinel per variant of dilla-core's
// cbor::CborError.
var (
	ErrNonMinimalInt        = errors.New("cborx: non-minimal integer argument")
	ErrIndefiniteOrReserved = errors.New("cborx: indefinite length or reserved additional info")
	ErrMapForbidden         = errors.New("cborx: map not allowed")
	ErrTagForbidden         = errors.New("cborx: tag not allowed")
	ErrFloatForbidden       = errors.New("cborx: float not allowed")
	ErrNegativeForbidden    = errors.New("cborx: negative integer not allowed")
	ErrSimpleForbidden      = errors.New("cborx: simple value not allowed")
	ErrTrailingBytes        = errors.New("cborx: trailing bytes after the top-level item")
	ErrTruncated            = errors.New("cborx: truncated input")
	ErrInvalidUTF8          = errors.New("cborx: invalid utf-8 in text string")
	ErrTooDeep              = fmt.Errorf("cborx: nesting deeper than %d", MaxNesting)
	ErrWrongMajor           = errors.New("cborx: unexpected CBOR major type")
)

var (
	decOnce sync.Once
	decMode cbor.DecMode
	decErr  error
)

// DecMode returns the shared decoding mode. It forbids indefinite lengths and
// tags outright and caps nesting at MaxNesting. It does not enforce minimal
// integer heads, because no Go CBOR library does (gap-16 3.3), so every decode
// goes through CheckDeterministic first; see Unmarshal.
func DecMode() (cbor.DecMode, error) {
	decOnce.Do(func() {
		decMode, decErr = cbor.DecOptions{
			IndefLength:     cbor.IndefLengthForbidden,
			TagsMd:          cbor.TagsForbidden,
			MaxNestedLevels: MaxNesting,
		}.DecMode()
	})
	return decMode, decErr
}

// Unmarshal checks that data is deterministic CBOR in dilla's subset and then
// decodes it into v.
func Unmarshal(data []byte, v any) error {
	if err := CheckDeterministic(data); err != nil {
		return err
	}
	dm, err := DecMode()
	if err != nil {
		return fmt.Errorf("cborx: decode mode: %w", err)
	}
	return dm.Unmarshal(data, v)
}

// ExpectMajor returns an error unless the first item of data has the given
// major type. It exists because fxamacker/cbor decodes a CBOR array straight
// into a Go []byte: without this guard, 820102 would be accepted wherever a
// byte string is required.
func ExpectMajor(data []byte, major byte) error {
	if len(data) == 0 {
		return ErrTruncated
	}
	if got := data[0] >> 5; got != major {
		return fmt.Errorf("%w: got major %d, want %d", ErrWrongMajor, got, major)
	}
	return nil
}

// CheckDeterministic reports whether data is exactly one item of dilla's
// deterministic-CBOR subset, with no trailing bytes.
func CheckDeterministic(data []byte) error {
	n, err := scanItem(data, 0)
	if err != nil {
		return err
	}
	if n != len(data) {
		return ErrTrailingBytes
	}
	return nil
}

// scanItem validates the one item starting at data[0] and returns its length in
// bytes.
func scanItem(data []byte, depth int) (int, error) {
	if depth > MaxNesting {
		return 0, ErrTooDeep
	}
	if len(data) == 0 {
		return 0, ErrTruncated
	}
	major := data[0] >> 5
	ai := data[0] & 0x1f

	// Major 7 has its own additional-info vocabulary and is decided first, exactly
	// as dilla-core's cbor::Decoder::head does.
	if major == 7 {
		switch ai {
		case 22: // null
			return 1, nil
		case 25, 26, 27: // float16, float32, float64
			return 0, ErrFloatForbidden
		case 28, 29, 30, 31:
			return 0, ErrIndefiniteOrReserved
		default: // false, true, undefined, and the one-byte simple form
			return 0, ErrSimpleForbidden
		}
	}

	// The additional info is checked BEFORE the major type, so an indefinite-length
	// map (bf...) reports ErrIndefiniteOrReserved rather than ErrMapForbidden. The
	// order is load-bearing: dilla-core's Decoder::head rejects ai >= 28 ahead of
	// its `match major` arm, and the two languages must name the same reason for
	// the same byte string. Definite-length maps (a0, a1..) still fall through to
	// ErrMapForbidden below, because their ai is < 28.
	if ai >= 28 {
		return 0, ErrIndefiniteOrReserved
	}

	switch major {
	case 1:
		return 0, ErrNegativeForbidden
	case 5:
		return 0, ErrMapForbidden
	case 6:
		return 0, ErrTagForbidden
	}

	arg, headLen, err := readArg(data)
	if err != nil {
		return 0, err
	}
	switch major {
	case MajorUint:
		return headLen, nil
	case MajorBytes, MajorText:
		if arg > uint64(len(data)-headLen) { //nolint:gosec // G115: readArg guarantees headLen <= len(data), so the difference is not negative
			return 0, ErrTruncated
		}
		end := headLen + int(arg) //nolint:gosec // G115: arg <= len(data)-headLen was checked on the line above
		if major == MajorText && !utf8.Valid(data[headLen:end]) {
			return 0, ErrInvalidUTF8
		}
		return end, nil
	case MajorArray:
		pos := headLen
		for range arg {
			n, err := scanItem(data[pos:], depth+1)
			if err != nil {
				return 0, err
			}
			pos += n
		}
		return pos, nil
	}
	return 0, ErrWrongMajor
}

// readArg decodes the head of an item, rejecting every argument encoding longer
// than CBOR's preferred serialization requires.
func readArg(data []byte) (arg uint64, headLen int, err error) {
	switch ai := data[0] & 0x1f; {
	case ai < 24:
		return uint64(ai), 1, nil
	case ai == 24:
		if len(data) < 2 {
			return 0, 0, ErrTruncated
		}
		v := uint64(data[1])
		if v < 24 {
			return 0, 0, ErrNonMinimalInt
		}
		return v, 2, nil
	case ai == 25:
		if len(data) < 3 {
			return 0, 0, ErrTruncated
		}
		v := uint64(binary.BigEndian.Uint16(data[1:3]))
		if v <= 0xff {
			return 0, 0, ErrNonMinimalInt
		}
		return v, 3, nil
	case ai == 26:
		if len(data) < 5 {
			return 0, 0, ErrTruncated
		}
		v := uint64(binary.BigEndian.Uint32(data[1:5]))
		if v <= 0xffff {
			return 0, 0, ErrNonMinimalInt
		}
		return v, 5, nil
	case ai == 27:
		if len(data) < 9 {
			return 0, 0, ErrTruncated
		}
		v := binary.BigEndian.Uint64(data[1:9])
		if v <= 0xffffffff {
			return 0, 0, ErrNonMinimalInt
		}
		return v, 9, nil
	default: // 28, 29, 30 reserved; 31 indefinite
		// scanItem already rejected ai >= 28 before calling readArg. Kept so
		// readArg is total on its own, for any future caller.
		return 0, 0, ErrIndefiniteOrReserved
	}
}
