package sframe

import "encoding/binary"

// minLen is how many big-endian bytes v needs, at least 1.
func minLen(v uint64) int {
	n := 8
	for n > 1 && v>>((n-1)*8) == 0 {
		n--
	}
	return n
}

// EncodeHeader is RFC 9605 §4.3: config byte X|K(3)|Y|C(3), then the KID and the CTR, each in the
// field itself when it is 0..7 and otherwise in the minimum number of extension bytes.
func EncodeHeader(kid, ctr uint64) []byte {
	out := make([]byte, 1, 17)
	var b [8]byte
	if kid > 7 {
		n := minLen(kid)
		out[0] |= 0x80 | byte(n-1)<<4 //nolint:gosec // G115: n is 1..8
		binary.BigEndian.PutUint64(b[:], kid)
		out = append(out, b[8-n:]...)
	} else {
		out[0] |= byte(kid) << 4
	}
	if ctr > 7 {
		n := minLen(ctr)
		out[0] |= 0x08 | byte(n-1) //nolint:gosec // G115: n is 1..8
		binary.BigEndian.PutUint64(b[:], ctr)
		out = append(out, b[8-n:]...)
	} else {
		out[0] |= byte(ctr)
	}
	return out
}

// DecodeHeader is the strict reader, in reading order: the config byte, then the KID field
// (truncation, then minimality), then the CTR field. It returns how many bytes the header took.
func DecodeHeader(b []byte) (kid, ctr uint64, n int, err error) {
	if len(b) == 0 {
		return 0, 0, 0, ErrTruncatedHeader
	}
	config := b[0]
	at := 1
	kid = uint64(config >> 4 & 7)
	if config&0x80 != 0 {
		l := int(config>>4&7) + 1
		if kid, err = readExtended(b, at, l); err != nil {
			return 0, 0, 0, err
		}
		at += l
	}
	ctr = uint64(config & 7)
	if config&0x08 != 0 {
		l := int(config&7) + 1
		if ctr, err = readExtended(b, at, l); err != nil {
			return 0, 0, 0, err
		}
		at += l
	}
	return kid, ctr, at, nil
}

// readExtended reads one l-byte big-endian field at at. A value 0..7 belongs in the config byte and
// a leading zero byte makes a field longer than minimal (RFC 9605 §4.3): both are non-minimal.
func readExtended(b []byte, at, l int) (uint64, error) {
	if len(b) < at+l {
		return 0, ErrTruncatedHeader
	}
	var v uint64
	for _, x := range b[at : at+l] {
		v = v<<8 | uint64(x)
	}
	if v <= 7 || (l > 1 && b[at] == 0) {
		return 0, ErrNonMinimalHeader
	}
	return v, nil
}
