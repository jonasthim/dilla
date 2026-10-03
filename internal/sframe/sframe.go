package sframe

import (
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"time"
)

// Suite is RFC 9605's AES_128_GCM_SHA256_128.
const Suite uint16 = 0x0004

// Nk, Nn and Nt are the suite's key, nonce and tag sizes.
const Nk, Nn, Nt = 16, 12, 16

// MaxSeq is the largest per-(epoch, slot, layer) sequence number; the next one is refused, and the
// sender rekeys through an MLS Update instead of wrapping.
const MaxSeq = 1<<52 - 1

// OldEpochRetention is how long a receiver keeps an epoch after a newer one superseded it.
const OldEpochRetention = 10 * time.Second

// ReplayWindow is the anti-replay window per (leaf, slot, layer) and epoch.
const ReplayWindow = 128

// Codec is the media codec a frame belongs to; it picks the clear prefix rule.
type Codec uint8

const (
	Opus Codec = 0
	VP8  Codec = 1
	VP9  Codec = 2
	H264 Codec = 3
)

// Slot is the source a frame came from: the top byte of the CTR.
type Slot uint8

const (
	Mic         Slot = 0
	Camera      Slot = 1
	ScreenVideo Slot = 2
	ScreenAudio Slot = 3
)

const (
	labelKey  = "SFrame 1.0 Secret key "
	labelSalt = "SFrame 1.0 Secret salt "
)

// KID is (leaf << 8) | (epoch mod 256), context 0 (protocol/05 "Key IDs").
func KID(leaf uint16, epoch uint64) uint64 { return uint64(leaf)<<8 | epoch%256 }

// CTR packs slot(8) | layer(4) | seq(52).
func CTR(slot Slot, layer uint8, seq uint64) (uint64, error) {
	if layer > 0xf {
		return 0, ErrLayerRange
	}
	if seq > MaxSeq {
		return 0, ErrCounterExhausted
	}
	return uint64(slot)<<56 | uint64(layer)<<52 | seq, nil
}

// gosec does not flag a shifted or masked narrowing, and nolintlint (allow-unused: false) refuses a
// directive that suppresses nothing, so these carry none.
func ctrSlot(ctr uint64) uint8  { return uint8(ctr >> 56) }
func ctrLayer(ctr uint64) uint8 { return uint8(ctr >> 52 & 0xf) }
func ctrSeq(ctr uint64) uint64  { return ctr & MaxSeq }

// Keys is one KID's AES-128-GCM key and salt.
type Keys struct {
	Key  [16]byte
	Salt [12]byte
}

// DeriveKeys is RFC 9605 §4.4.2 over the MLS-exported base key:
//
//	secret = HKDF-Extract(salt = "", base_key)
//	key    = HKDF-Expand(secret, "SFrame 1.0 Secret key "  || KID(8, BE) || 0x0004, 16)
//	salt   = HKDF-Expand(secret, "SFrame 1.0 Secret salt " || KID(8, BE) || 0x0004, 12)
func DeriveKeys(baseKey [16]byte, kid uint64) Keys {
	secret, err := hkdf.Extract(sha256.New, baseKey[:], nil)
	if err != nil {
		// crypto/hkdf refuses only a secret below 112 bits in FIPS 140-only mode; 128 bits never is.
		panic("sframe: HKDF-Extract: " + err.Error())
	}
	var info [10]byte
	binary.BigEndian.PutUint64(info[:8], kid)
	binary.BigEndian.PutUint16(info[8:], Suite)
	key, err := hkdf.Expand(sha256.New, secret, labelKey+string(info[:]), Nk)
	if err != nil {
		panic("sframe: HKDF-Expand key: " + err.Error())
	}
	salt, err := hkdf.Expand(sha256.New, secret, labelSalt+string(info[:]), Nn)
	if err != nil {
		panic("sframe: HKDF-Expand salt: " + err.Error())
	}
	var k Keys
	copy(k.Key[:], key)
	copy(k.Salt[:], salt)
	return k
}

// nonce is salt XOR CTR, the CTR big-endian in the low eight bytes.
func nonce(salt [12]byte, ctr uint64) []byte {
	var c [8]byte
	binary.BigEndian.PutUint64(c[:], ctr)
	for i := range c {
		salt[4+i] ^= c[i]
	}
	return salt[:]
}
