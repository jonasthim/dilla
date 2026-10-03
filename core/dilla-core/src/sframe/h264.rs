//! H.264 for `dilla-sframe/1` (protocol/05 "Codec prefixes", H.264 row).
//!
//! The clear prefix is every NAL before the first VCL NAL, that NAL's one-byte header, and the
//! slice-header bytes through `pic_parameter_set_id` (libdave `BytesCoveringH264PPS`), with every
//! start code rewritten to `00 00 00 01` because libwebrtc's receiver rebuilds the frame that way.
//! What follows the prefix is `WriteRbsp`-escaped with the zero counter seeded from the prefix's
//! trailing zero bytes, so no start code can form across the boundary (libwebrtc
//! `h264_common.cc` `WriteRbsp`/`ParseRbsp`; DAVE's nonce retry cannot work here because the CTR
//! itself carries `00 00 00`).

use super::SframeError;

const START_CODE: [u8; 4] = [0, 0, 0, 1];

/// One NAL as libwebrtc's `H264::FindNaluIndices` reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Nalu {
    /// First byte of the start code (a preceding `00` folded in, so 4-byte codes start here).
    start: usize,
    /// First byte after the start code: the NAL header.
    payload: usize,
    /// One past the last payload byte (the next NAL's `start`, or the end of the buffer).
    end: usize,
}

/// libwebrtc `H264::FindNaluIndices` (`common_video/h264/h264_common.cc:25-69`), byte for byte:
/// bytes before the first start code belong to no NAL, one `00` before `00 00 01` is folded into
/// the start code, and extra trailing zeros stay in the previous NAL's payload.
fn find_nalus(buf: &[u8]) -> Vec<Nalu> {
    let mut out: Vec<Nalu> = Vec::new();
    if buf.len() < 3 {
        return out;
    }
    let end = buf.len() - 3;
    let mut i = 0;
    while i < end {
        if buf[i + 2] > 1 {
            i += 3;
        } else if buf[i + 2] == 1 {
            if buf[i + 1] == 0 && buf[i] == 0 {
                let mut start = i;
                if start > 0 && buf[start - 1] == 0 {
                    start -= 1;
                }
                if let Some(prev) = out.last_mut() {
                    prev.end = start;
                }
                out.push(Nalu {
                    start,
                    payload: i + 3,
                    end: buf.len(),
                });
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

/// `frame` rebuilt as `concat(00 00 00 01 || nal)` over its `FindNaluIndices` NALs, and the clear
/// prefix length of the rebuilt frame. Leading bytes before the first start code are dropped and
/// trailing zeros are kept, exactly as libwebrtc's receiver re-emits the frame.
pub fn canonicalize_h264(frame: &[u8]) -> Result<(Vec<u8>, usize), SframeError> {
    let nalus = find_nalus(frame);
    if nalus.is_empty() {
        return Err(SframeError::MalformedPrefix);
    }
    let mut out = Vec::with_capacity(frame.len() + nalus.len());
    for n in &nalus {
        out.extend_from_slice(&START_CODE);
        out.extend_from_slice(&frame[n.payload..n.end]);
    }
    let prefix = h264_prefix_len(&out)?;
    Ok((out, prefix))
}

/// The H.264 clear-prefix length of `frame`, which MUST begin with a start code.
pub(crate) fn h264_prefix_len(frame: &[u8]) -> Result<usize, SframeError> {
    let nalus = find_nalus(frame);
    match nalus.first() {
        Some(n) if n.start == 0 => {}
        _ => return Err(SframeError::MalformedPrefix),
    }
    for n in &nalus {
        let payload = &frame[n.payload..n.end];
        let header = *payload.first().ok_or(SframeError::MalformedPrefix)?;
        match header & 0x1f {
            1 | 5 => {
                let covered = bytes_covering_h264_pps(&payload[1..])?;
                return Ok(n.payload + 1 + covered);
            }
            2..=4 | 19..=21 => return Err(SframeError::UnsupportedCodec),
            6..=18 | 22 | 23 => {}
            // 0 and 24-31: unspecified, or STAP/FU aggregation types inside a frame.
            _ => return Err(SframeError::MalformedPrefix),
        }
    }
    Err(SframeError::NoVclNal)
}

/// Reads bits MSB-first from an escaped NAL payload, skipping the `03` of `00 00 03` whenever a
/// read starts a new byte at index >= 2 (libdave's emulation rule, applied at every byte boundary).
struct EscapedBits<'a> {
    data: &'a [u8],
    bit: usize,
}

impl EscapedBits<'_> {
    fn bit(&mut self) -> Result<u64, SframeError> {
        if self.bit.is_multiple_of(8) {
            let at = self.bit / 8;
            if at >= 2
                && self.data.get(at) == Some(&3)
                && self.data[at - 1] == 0
                && self.data[at - 2] == 0
            {
                self.bit += 8;
            }
        }
        let byte = *self
            .data
            .get(self.bit / 8)
            .ok_or(SframeError::MalformedPrefix)?;
        let b = (byte >> (7 - (self.bit % 8))) & 1;
        self.bit += 1;
        Ok(u64::from(b))
    }

    fn ue(&mut self) -> Result<u64, SframeError> {
        let mut zeros = 0u32;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(SframeError::MalformedPrefix);
            }
        }
        let mut v = 0u64;
        for _ in 0..zeros {
            v = (v << 1) | self.bit()?;
        }
        Ok((1u64 << zeros) - 1 + v)
    }
}

/// libdave `BytesCoveringH264PPS` (`codec_utils.cpp:16-75`): the three `ue(v)` fields
/// `first_mb_in_slice`, `slice_type` and `pic_parameter_set_id` of a slice NAL's payload (after
/// the NAL header), as `bit_index / 8 + 1` escaped bytes. `MalformedPrefix` when the fields do not
/// fit, or when `pic_parameter_set_id > 255` (libwebrtc's `kMaxPpsId`; M152 lacks the bound).
pub fn bytes_covering_h264_pps(payload_after_nal_header: &[u8]) -> Result<usize, SframeError> {
    let mut r = EscapedBits {
        data: payload_after_nal_header,
        bit: 0,
    };
    let _first_mb_in_slice = r.ue()?;
    let _slice_type = r.ue()?;
    let pps_id = r.ue()?;
    if pps_id > 255 {
        return Err(SframeError::MalformedPrefix);
    }
    let covered = r.bit / 8 + 1;
    if covered > payload_after_nal_header.len() {
        return Err(SframeError::MalformedPrefix);
    }
    Ok(covered)
}

/// How many `00` bytes end `prefix`, capped at 2: the seed of the escape that follows it.
pub fn trailing_zeros(prefix: &[u8]) -> u8 {
    let mut n = 0u8;
    for b in prefix.iter().rev() {
        if *b != 0 || n == 2 {
            break;
        }
        n += 1;
    }
    n
}

/// `WriteRbsp(00^seed || data)[seed..]` (libwebrtc `h264_common.cc:98-118`): a `03` goes in front
/// of every byte `<= 03` that follows two or more zeros, and the zero count restarts after it.
pub fn rbsp_escape(seed_zeros: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + data.len() / 2 + 1);
    let mut zeros = u32::from(seed_zeros.min(2));
    for &b in data {
        if b <= 3 && zeros >= 2 {
            out.push(3);
            zeros = 0;
        }
        out.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// `ParseRbsp(00^seed || data)[seed..]` (libwebrtc `h264_common.cc:74-95`): every `00 00 03`
/// loses its `03`.
pub fn rbsp_unescape(seed_zeros: u8, data: &[u8]) -> Vec<u8> {
    let seed = usize::from(seed_zeros.min(2));
    let mut buf = vec![0u8; seed];
    buf.extend_from_slice(data);
    let mut out = Vec::with_capacity(buf.len());
    let mut i = 0;
    while i < buf.len() {
        if buf.len() - i >= 3 && buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 3 {
            out.push(0);
            out.push(0);
            i += 3;
        } else {
            out.push(buf[i]);
            i += 1;
        }
    }
    out.split_off(seed)
}

/// Plain RBSP bit reader for the SPS check (the payload is unescaped first).
struct Rbsp<'a> {
    data: &'a [u8],
    bit: usize,
}

impl Rbsp<'_> {
    fn u(&mut self, n: u32) -> Result<u64, SframeError> {
        let mut v = 0u64;
        for _ in 0..n {
            let byte = *self
                .data
                .get(self.bit / 8)
                .ok_or(SframeError::NonCanonicalSps)?;
            v = (v << 1) | u64::from((byte >> (7 - (self.bit % 8))) & 1);
            self.bit += 1;
        }
        Ok(v)
    }

    fn flag(&mut self) -> Result<bool, SframeError> {
        Ok(self.u(1)? == 1)
    }

    fn ue(&mut self) -> Result<u64, SframeError> {
        let mut zeros = 0u32;
        while self.u(1)? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(SframeError::NonCanonicalSps);
            }
        }
        Ok((1u64 << zeros) - 1 + self.u(zeros)?)
    }

    fn se(&mut self) -> Result<i64, SframeError> {
        let k = self.ue()?;
        let magnitude = i64::try_from(k.div_ceil(2)).map_err(|_| SframeError::NonCanonicalSps)?;
        Ok(if k % 2 == 1 { magnitude } else { -magnitude })
    }

    fn scaling_list(&mut self, size: usize) -> Result<(), SframeError> {
        let (mut last, mut next) = (8i64, 8i64);
        for _ in 0..size {
            if next != 0 {
                next = (last + self.se()? + 256).rem_euclid(256);
            }
            if next != 0 {
                last = next;
            }
        }
        Ok(())
    }

    fn hrd(&mut self) -> Result<(), SframeError> {
        let cpb_cnt_minus1 = self.ue()?;
        if cpb_cnt_minus1 > 31 {
            return Err(SframeError::NonCanonicalSps);
        }
        self.u(4)?; // bit_rate_scale
        self.u(4)?; // cpb_size_scale
        for _ in 0..=cpb_cnt_minus1 {
            self.ue()?; // bit_rate_value_minus1
            self.ue()?; // cpb_size_value_minus1
            self.u(1)?; // cbr_flag
        }
        self.u(20)?; // four 5-bit length fields
        Ok(())
    }
}

/// libwebrtc's incoming VUI rule (`SpsVuiRewriter::ParseAndRewriteSps(…, Direction::kIncoming)`,
/// `sps_vui_rewriter.cc` `CopyAndRewriteVui`): a receiver rewrites an SPS — and so changes the
/// AAD — unless `vui_parameters_present_flag = 1`, `bitstream_restriction_flag = 1`,
/// `max_num_reorder_frames = 0` and `max_dec_frame_buffering <= max_num_ref_frames`.
/// `sps_nal` is one NAL including its header byte (type 7), without a start code.
pub fn check_sps_vui(sps_nal: &[u8]) -> Result<(), SframeError> {
    match sps_nal.first() {
        Some(h) if h & 0x1f == 7 => {}
        _ => return Err(SframeError::NonCanonicalSps),
    }
    let rbsp = rbsp_unescape(0, &sps_nal[1..]);
    let mut r = Rbsp {
        data: &rbsp,
        bit: 0,
    };
    let profile_idc = r.u(8)?;
    r.u(8)?; // constraint_set flags and reserved_zero_2bits
    r.u(8)?; // level_idc
    r.ue()?; // seq_parameter_set_id
    if matches!(
        profile_idc,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma_format_idc = r.ue()?;
        if chroma_format_idc == 3 {
            r.u(1)?; // separate_colour_plane_flag
        }
        r.ue()?; // bit_depth_luma_minus8
        r.ue()?; // bit_depth_chroma_minus8
        r.u(1)?; // qpprime_y_zero_transform_bypass_flag
        if r.flag()? {
            let lists = if chroma_format_idc == 3 { 12 } else { 8 };
            for i in 0..lists {
                if r.flag()? {
                    r.scaling_list(if i < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    r.ue()?; // log2_max_frame_num_minus4
    match r.ue()? {
        0 => {
            r.ue()?; // log2_max_pic_order_cnt_lsb_minus4
        }
        1 => {
            r.u(1)?; // delta_pic_order_always_zero_flag
            r.se()?; // offset_for_non_ref_pic
            r.se()?; // offset_for_top_to_bottom_field
            let cycle = r.ue()?;
            if cycle > 255 {
                return Err(SframeError::NonCanonicalSps);
            }
            for _ in 0..cycle {
                r.se()?;
            }
        }
        _ => {}
    }
    let max_num_ref_frames = r.ue()?;
    r.u(1)?; // gaps_in_frame_num_value_allowed_flag
    r.ue()?; // pic_width_in_mbs_minus1
    r.ue()?; // pic_height_in_map_units_minus1
    if !r.flag()? {
        r.u(1)?; // mb_adaptive_frame_field_flag
    }
    r.u(1)?; // direct_8x8_inference_flag
    if r.flag()? {
        for _ in 0..4 {
            r.ue()?; // frame_crop_*_offset
        }
    }
    if !r.flag()? {
        return Err(SframeError::NonCanonicalSps); // no VUI: the receiver would add one
    }
    if r.flag()? {
        // aspect_ratio_info_present_flag
        if r.u(8)? == 255 {
            r.u(32)?; // sar_width, sar_height
        }
    }
    if r.flag()? {
        r.u(1)?; // overscan_appropriate_flag
    }
    if r.flag()? {
        r.u(4)?; // video_format, video_full_range_flag
        if r.flag()? {
            r.u(24)?; // colour_primaries, transfer_characteristics, matrix_coefficients
        }
    }
    if r.flag()? {
        r.ue()?; // chroma_sample_loc_type_top_field
        r.ue()?; // chroma_sample_loc_type_bottom_field
    }
    if r.flag()? {
        r.u(65)?; // num_units_in_tick, time_scale, fixed_frame_rate_flag
    }
    let nal_hrd = r.flag()?;
    if nal_hrd {
        r.hrd()?;
    }
    let vcl_hrd = r.flag()?;
    if vcl_hrd {
        r.hrd()?;
    }
    if nal_hrd || vcl_hrd {
        r.u(1)?; // low_delay_hrd_flag
    }
    r.u(1)?; // pic_struct_present_flag
    if !r.flag()? {
        return Err(SframeError::NonCanonicalSps); // bitstream_restriction_flag = 0
    }
    r.u(1)?; // motion_vectors_over_pic_boundaries_flag
    r.ue()?; // max_bytes_per_pic_denom
    r.ue()?; // max_bits_per_mb_denom
    r.ue()?; // log2_max_mv_length_horizontal
    r.ue()?; // log2_max_mv_length_vertical
    let max_num_reorder_frames = r.ue()?;
    let max_dec_frame_buffering = r.ue()?;
    if max_num_reorder_frames != 0 || max_dec_frame_buffering > max_num_ref_frames {
        return Err(SframeError::NonCanonicalSps);
    }
    Ok(())
}

/// Every SPS (type 7) in a canonical prefix passes [`check_sps_vui`]. The sender runs this before
/// it encrypts an H.264 frame (task 5's `SframeSender`), so a frame whose SPS a libwebrtc
/// receiver would rewrite is refused at the source instead of failing AEAD everywhere.
pub fn check_prefix_sps(prefix: &[u8]) -> Result<(), SframeError> {
    for n in find_nalus(prefix) {
        let nal = &prefix[n.payload..n.end];
        if nal.first().is_some_and(|h| h & 0x1f == 7) {
            check_sps_vui(nal)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        let s: String = s.chars().filter(|c| !c.is_whitespace()).collect();
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex digit"))
            .collect()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// `sframe.json`'s H.264 input: SPS, PPS, IDR with 4-byte start codes.
    const VECTOR_INPUT: &str =
        "000000016742c01e95a0501ec80000000168ce3c800000000165888421ff00000312345a5a5a5a";

    /// The server-sdk-go E2EE example key frame (`examples/videotracke2ee/main.go:181-186`).
    const SDK_KEY_FRAME: &str = "00000001 6742c01f0fd91f888884000003000400000300c83c60c920 \
                                 00000001 6887cb83cb20 \
                                 00000001 6588840af2628000a7be";

    /// A Constrained Baseline SPS (640x480, one reference frame) with a VUI whose bitstream
    /// restriction says `max_num_reorder_frames = 0`, `max_dec_frame_buffering = 1`: the shape
    /// libwebrtc's outgoing rewrite produces, so the incoming check leaves it alone.
    pub(crate) const STABLE_SPS: &str = "6742c01fda0280f68078442350";

    #[test]
    fn the_vector_frame_has_a_28_byte_prefix_ending_at_pps_id() {
        let f = unhex(VECTOR_INPUT);
        assert_eq!(h264_prefix_len(&f), Ok(28));
        assert!(hex(&f[..28]).ends_with("00000001658884"));
        let (canon, pl) = canonicalize_h264(&f).expect("canonical");
        assert_eq!((canon, pl), (f, 28), "already canonical");
    }

    #[test]
    fn the_sdk_example_idr_keeps_pps_id_clear() {
        let f = unhex(SDK_KEY_FRAME);
        let pl = h264_prefix_len(&f).expect("prefix");
        // libdave covers `65 88 84`; livekit's `+2` rule would stop at `65 88` and leave the
        // pps_id bit (the MSB of 0x84) encrypted.
        assert!(
            hex(&f[..pl]).ends_with("00000001658884"),
            "{}",
            hex(&f[..pl])
        );
        assert_eq!(hex(&f[pl..]), "0af2628000a7be");
        assert_eq!(trailing_zeros(&f[..pl]), 0);
    }

    #[test]
    fn three_byte_start_codes_and_leading_garbage_are_canonicalised() {
        // Garbage 'ff ee', a 3-byte SPS start code, a 4-byte PPS one followed by four zero bytes
        // and a 3-byte IDR start code. FindNaluIndices folds one zero into '00 00 01', so the PPS
        // keeps one trailing zero and the IDR gets a 4-byte code.
        let f = unhex("ffee 0000016742c01e95a0501ec8 0000000168ce3c800000 000001658884aabb");
        let (canon, pl) = canonicalize_h264(&f).expect("canonical");
        assert_eq!(
            hex(&canon),
            "000000016742c01e95a0501ec8".to_owned() + "0000000168ce3c8000" + "00000001658884aabb"
        );
        assert_eq!(pl, canon.len() - 2, "the prefix ends after '65 88 84'");
        assert_eq!(
            h264_prefix_len(&f),
            Err(SframeError::MalformedPrefix),
            "garbage first"
        );
    }

    #[test]
    fn a_prefix_can_end_in_a_zero_byte_and_the_escape_is_seeded_from_it() {
        // first_mb_in_slice 0 ('1'), slice_type 0 ('1'), pic_parameter_set_id 15 ('0001 0000'):
        // ten bits, so two bytes are covered, 'c4 00', and the prefix ends in one zero byte.
        let f = unhex("0000000165c400aa");
        assert_eq!(h264_prefix_len(&f), Ok(7));
        assert_eq!(trailing_zeros(&f[..7]), 1);
        // A seeded escape keeps a start code from forming across the boundary: '00 | 00 01'
        // escapes to '00 | 00 03 01'.
        assert_eq!(hex(&rbsp_escape(1, &unhex("0001"))), "000301");
    }

    #[test]
    fn pps_id_above_255_is_malformed() {
        // '1' '1' then ue(256) = eight zeros, '1', 0b00000001: 19 bits = 'c0 20 20'.
        assert_eq!(
            h264_prefix_len(&unhex("0000000165c02020aa")),
            Err(SframeError::MalformedPrefix)
        );
        // ue(255) = eight zeros, '1', 0b00000000: 'c0 20 00', three bytes covered.
        assert_eq!(h264_prefix_len(&unhex("0000000165c02000aa")), Ok(8));
        // Three ue(v) that run off the end of the NAL.
        assert_eq!(
            h264_prefix_len(&unhex("0000000165c0")),
            Err(SframeError::MalformedPrefix)
        );
    }

    #[test]
    fn data_partitions_and_extension_slices_are_unsupported() {
        for t in ["62", "63", "64", "73", "74", "75"] {
            let f = unhex(&format!("000000016742c01e95a0501ec8 00000001{t}888421"));
            assert_eq!(
                h264_prefix_len(&f),
                Err(SframeError::UnsupportedCodec),
                "type {t}"
            );
        }
    }

    #[test]
    fn sps_and_pps_alone_have_no_vcl_nal() {
        let f = unhex("000000016742c01e95a0501ec80000000168ce3c80");
        assert_eq!(h264_prefix_len(&f), Err(SframeError::NoVclNal));
        assert_eq!(canonicalize_h264(&f), Err(SframeError::NoVclNal));
    }

    #[test]
    fn unspecified_and_aggregation_types_are_malformed() {
        for t in ["60", "78", "7c", "7f"] {
            let f = unhex(&format!("00000001{t}aabb 0000000165888421"));
            assert_eq!(
                h264_prefix_len(&f),
                Err(SframeError::MalformedPrefix),
                "type {t}"
            );
        }
        assert_eq!(
            h264_prefix_len(&unhex("6588")),
            Err(SframeError::MalformedPrefix)
        );
        assert_eq!(h264_prefix_len(&[]), Err(SframeError::MalformedPrefix));
    }

    #[test]
    fn the_eight_escape_cases_match_seeded_write_rbsp() {
        for (seed, input, output) in [
            (0u8, "00000001000003", "000003000100000303"),
            (0, "000000", "00000300"),
            (0, "0000", "0000"),
            (1, "0001", "000301"),
            (1, "0100", "0100"),
            (2, "03ff", "0303ff"),
            (2, "04", "04"),
            (0, "9f03290100000000000001", "9f03290100000300000300000301"),
        ] {
            assert_eq!(
                hex(&rbsp_escape(seed, &unhex(input))),
                output,
                "seed {seed} {input}"
            );
            assert_eq!(
                hex(&rbsp_unescape(seed, &unhex(output))),
                input,
                "seed {seed} {output}"
            );
        }
    }

    #[test]
    fn trailing_zeros_caps_at_two() {
        assert_eq!(trailing_zeros(&unhex("aa")), 0);
        assert_eq!(trailing_zeros(&unhex("aa00")), 1);
        assert_eq!(trailing_zeros(&unhex("aa0000")), 2);
        assert_eq!(trailing_zeros(&unhex("aa000000")), 2);
        assert_eq!(trailing_zeros(&[]), 0);
    }

    #[test]
    fn the_vui_check_accepts_a_libwebrtc_stable_sps_and_refuses_the_rest() {
        assert_eq!(check_sps_vui(&unhex(STABLE_SPS)), Ok(()));
        // The vector's synthetic SPS ends inside its VUI: no bitstream restriction.
        assert_eq!(
            check_sps_vui(&unhex("6742c01e95a0501ec8")),
            Err(SframeError::NonCanonicalSps)
        );
        // Not an SPS at all.
        assert_eq!(
            check_sps_vui(&unhex("68ce3c80")),
            Err(SframeError::NonCanonicalSps)
        );
        // Chromium 153's OpenH264 SPS for the 640x360 camera and the 1920x1080 fake screen, as
        // the SP-04 sender logged them: libwebrtc's outgoing rewrite already made them stable.
        assert_eq!(check_sps_vui(&unhex("6742c0158c68141f201e1108d4")), Ok(()));
        assert_eq!(
            check_sps_vui(&unhex("6742c0288c680780227e59a83030303c2211a8")),
            Ok(())
        );
        // A prefix carrying the stable SPS passes; one carrying the synthetic SPS does not.
        let good = format!("00000001{STABLE_SPS}0000000168ce3c800000000165888421");
        assert_eq!(check_prefix_sps(&unhex(&good)), Ok(()));
        assert_eq!(
            check_prefix_sps(&unhex(VECTOR_INPUT)),
            Err(SframeError::NonCanonicalSps)
        );
    }
}
