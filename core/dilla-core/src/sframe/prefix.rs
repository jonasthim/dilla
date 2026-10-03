//! The clear codec prefix (protocol/05 "Codec prefixes"). Sender and receiver run the same
//! function over the same clear bytes, so the prefix needs no length field of its own.

use super::h264::h264_prefix_len;
use super::{Codec, SframeError};

/// VP8 key frames keep the RFC 6386 section 9.1 uncompressed chunk clear: the 3-byte frame tag,
/// the start code `9d 01 2a` and the two 16-bit size fields, which libwebrtc's depacketizer and
/// LiveKit's `ExtractVP8VideoSize` read.
pub const VP8_KEY_PREFIX: usize = 10;
/// VP8 inter frames keep byte 0 clear: the frame tag's P bit is what tells a depacketizer key from
/// delta (verified through LiveKit with Chromium 153 and Firefox 155 by SP-05, task 2).
pub const VP8_DELTA_PREFIX: usize = 1;

/// How many leading bytes of `frame` stay in the clear for `codec`.
///
/// - Opus, VP9: 0.
/// - VP8: 10 when `frame[0] & 1 == 0` (key frame; shorter is `MalformedPrefix`), else 1.
/// - H.264: the NALs before the first VCL NAL, its header and the slice header through
///   `pic_parameter_set_id` (see `h264`); the frame must begin with a start code.
pub fn prefix_len(codec: Codec, frame: &[u8]) -> Result<usize, SframeError> {
    match codec {
        Codec::Opus | Codec::Vp9 => Ok(0),
        Codec::Vp8 => {
            let tag = *frame.first().ok_or(SframeError::MalformedPrefix)?;
            if tag & 1 == 0 {
                if frame.len() < VP8_KEY_PREFIX {
                    return Err(SframeError::MalformedPrefix);
                }
                Ok(VP8_KEY_PREFIX)
            } else {
                Ok(VP8_DELTA_PREFIX)
            }
        }
        Codec::H264 => h264_prefix_len(frame),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    #[test]
    fn opus_and_vp9_keep_nothing_clear() {
        assert_eq!(prefix_len(Codec::Opus, &unhex("fc0102")), Ok(0));
        assert_eq!(prefix_len(Codec::Opus, &[]), Ok(0));
        assert_eq!(prefix_len(Codec::Vp9, &unhex("8249834200")), Ok(0));
    }

    #[test]
    fn vp8_keeps_ten_bytes_of_a_key_frame_and_one_of_a_delta_frame() {
        assert_eq!(
            prefix_len(Codec::Vp8, &unhex("5002009d012a8002e0010102030405060708")),
            Ok(10)
        );
        assert_eq!(prefix_len(Codec::Vp8, &unhex("310102030405060708")), Ok(1));
        // A one-byte delta frame is still a delta frame.
        assert_eq!(prefix_len(Codec::Vp8, &unhex("31")), Ok(1));
    }

    #[test]
    fn a_short_vp8_key_frame_and_an_empty_vp8_frame_are_malformed() {
        assert_eq!(
            prefix_len(Codec::Vp8, &unhex("5002009d012a8002e0")),
            Err(SframeError::MalformedPrefix)
        );
        assert_eq!(
            prefix_len(Codec::Vp8, &[]),
            Err(SframeError::MalformedPrefix)
        );
    }

    #[test]
    fn codec_numbers_are_the_wasm_surface_numbers() {
        assert_eq!(Codec::from_u8(0), Ok(Codec::Opus));
        assert_eq!(Codec::from_u8(1), Ok(Codec::Vp8));
        assert_eq!(Codec::from_u8(2), Ok(Codec::Vp9));
        assert_eq!(Codec::from_u8(3), Ok(Codec::H264));
        assert_eq!(Codec::from_u8(4), Err(SframeError::UnsupportedCodec));
        assert_eq!(Codec::from_u8(255), Err(SframeError::UnsupportedCodec));
    }
}
