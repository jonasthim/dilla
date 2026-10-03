package sframe

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
)

func gcm(key [16]byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// peekKIDCTR parses a dilla header. DecodeHeader remains the general RFC codec so its C.1
// vectors with 64-bit KIDs can decode, but a dilla receiver accepts only canonical 24-bit KIDs.
func peekKIDCTR(prefixLen int, frame []byte) (kid, ctr uint64, n int, err error) {
	if prefixLen < 0 || prefixLen > len(frame) {
		return 0, 0, 0, ErrMalformedPrefix
	}
	kid, ctr, n, err = DecodeHeader(frame[prefixLen:])
	if err != nil {
		return 0, 0, 0, err
	}
	if kid >= 1<<24 {
		return 0, 0, 0, ErrNonCanonicalKID
	}
	return kid, ctr, n, nil
}

// EncryptFrame is P || H || C || T over the unescaped layout: frame[:prefixLen] stays clear and the
// rest is sealed under k with nonce salt XOR CTR and AAD H || P.
func EncryptFrame(k Keys, kid, ctr uint64, prefixLen int, frame []byte) ([]byte, error) {
	if prefixLen < 0 || prefixLen > len(frame) {
		return nil, ErrMalformedPrefix
	}
	header := EncodeHeader(kid, ctr)
	aad := make([]byte, 0, len(header)+prefixLen)
	aad = append(append(aad, header...), frame[:prefixLen]...)
	aead, err := gcm(k.Key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(frame)+len(header)+Nt)
	out = append(append(out, frame[:prefixLen]...), header...)
	return aead.Seal(out, nonce(k.Salt, ctr), frame[prefixLen:], aad), nil
}

// OpenFrame opens an unescaped frame under k and returns its KID, its counter and P || plaintext.
// Fewer than Nt bytes after the header is ErrTruncatedFrame; any tag mismatch is ErrAuth.
func OpenFrame(k Keys, prefixLen int, frame []byte) (kid, ctr uint64, out []byte, err error) {
	if prefixLen < 0 || prefixLen > len(frame) {
		return 0, 0, nil, ErrMalformedPrefix
	}
	kid, ctr, n, err := peekKIDCTR(prefixLen, frame)
	if err != nil {
		return 0, 0, nil, err
	}
	sealed := frame[prefixLen+n:]
	if len(sealed) < Nt {
		return 0, 0, nil, ErrTruncatedFrame
	}
	aad := make([]byte, 0, n+prefixLen)
	aad = append(append(aad, frame[prefixLen:prefixLen+n]...), frame[:prefixLen]...)
	aead, err := gcm(k.Key)
	if err != nil {
		return 0, 0, nil, err
	}
	out = append(make([]byte, 0, prefixLen+len(sealed)-Nt), frame[:prefixLen]...)
	if out, err = aead.Open(out, nonce(k.Salt, ctr), sealed, aad); err != nil {
		return 0, 0, nil, ErrAuth
	}
	return kid, ctr, out, nil
}

// Protect is the sender's codec path: the prefix (H.264 canonicalised first), the seal, and for H.264
// the seeded escape of everything after the prefix.
func Protect(k Keys, kid, ctr uint64, c Codec, frame []byte) ([]byte, error) {
	if c != H264 {
		p, err := PrefixLen(c, frame)
		if err != nil {
			return nil, err
		}
		return EncryptFrame(k, kid, ctr, p, frame)
	}
	canonical, p, err := canonicalizeH264(frame)
	if err != nil {
		return nil, err
	}
	sealed, err := EncryptFrame(k, kid, ctr, p, canonical)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, len(sealed)+len(sealed)/32+4)
	out = append(out, sealed[:p]...)
	return append(out, RBSPEscape(trailingZeros(sealed[:p]), sealed[p:])...), nil
}

// UnescapeProtected is the receiver's inverse of Protect's codec layer: P || unescaped H||C||T and
// the prefix length, ready for DecodeHeader and OpenFrame.
func UnescapeProtected(c Codec, frame []byte) (x []byte, prefixLen int, err error) {
	p, err := PrefixLen(c, frame)
	if err != nil {
		return nil, 0, err
	}
	if c != H264 {
		return bytes.Clone(frame), p, nil
	}
	out := make([]byte, 0, len(frame))
	out = append(out, frame[:p]...)
	return append(out, RBSPUnescape(trailingZeros(frame[:p]), frame[p:])...), p, nil
}
