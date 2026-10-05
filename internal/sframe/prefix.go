package sframe

// The VP8 prefix lengths are task 4's constants, which SP-05 (task 2) fixed: a key frame keeps the
// RFC 6386 §9.1 uncompressed chunk clear (frame tag, start code 9d 01 2a, both size fields), an
// inter frame keeps byte 0 clear (the P bit a depacketiser reads). If task 2 recorded a different
// pair, task 4 wrote that pair and these two lines carry the same numbers.
const (
	vp8KeyPrefix   = 10
	vp8DeltaPrefix = 1
)

// PrefixLen is how many leading bytes of frame stay clear for c (protocol/05 "Codec prefixes").
// Sender and receiver run it over the same clear bytes, so the prefix carries no length field.
func PrefixLen(c Codec, frame []byte) (int, error) {
	switch c {
	case Opus, VP9:
		return 0, nil
	case VP8:
		if len(frame) == 0 {
			return 0, ErrMalformedPrefix
		}
		if frame[0]&1 == 0 {
			if len(frame) < vp8KeyPrefix {
				return 0, ErrMalformedPrefix
			}
			return vp8KeyPrefix, nil
		}
		return vp8DeltaPrefix, nil
	case H264:
		return h264PrefixLen(frame)
	}
	return 0, ErrUnsupportedCodec
}
