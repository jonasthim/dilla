package sframe

// nalu is one NAL as libwebrtc's H264::FindNaluIndices reports it.
type nalu struct {
	start   int // first byte of the start code (a preceding 00 folded in)
	payload int // first byte after the start code: the NAL header
	end     int // one past the last payload byte
}

// findNALUs is libwebrtc's FindNaluIndices (common_video/h264/h264_common.cc:25-69): bytes before
// the first start code belong to no NAL, one 00 before 00 00 01 is folded into the start code, and
// further zeros stay in the previous NAL's payload.
func findNALUs(buf []byte) []nalu {
	var out []nalu
	if len(buf) < 3 {
		return out
	}
	end := len(buf) - 3
	for i := 0; i < end; {
		switch {
		case buf[i+2] > 1:
			i += 3
		case buf[i+2] == 1:
			if buf[i+1] == 0 && buf[i] == 0 {
				start := i
				if start > 0 && buf[start-1] == 0 {
					start--
				}
				if len(out) > 0 {
					out[len(out)-1].end = start
				}
				out = append(out, nalu{start: start, payload: i + 3, end: len(buf)})
			}
			i += 3
		default:
			i++
		}
	}
	return out
}

// canonicalizeH264 rebuilds frame as concat(00 00 00 01 || nal) over its FindNaluIndices NALs —
// leading bytes dropped, trailing zeros kept, exactly as a libwebrtc receiver re-emits it — and
// returns the clear prefix length of the rebuilt frame. Access unit delimiters (9) and filler data
// (12) before the first VCL NAL are dropped: pion's packetiser drops both (codecs/h264_packet.go), so
// a receiver's P would lack them and every such frame would fail ErrAuth (protocol/05 H.264 rule 2).
// After the first VCL NAL everything is ciphertext and is kept. The Rust core does the same.
func canonicalizeH264(frame []byte) ([]byte, int, error) {
	nalus := findNALUs(frame)
	if len(nalus) == 0 {
		return nil, 0, ErrMalformedPrefix
	}
	out := make([]byte, 0, len(frame)+len(nalus))
	inPrefix := true
	for _, n := range nalus {
		nal := frame[n.payload:n.end]
		if len(nal) > 0 {
			switch t := nal[0] & 0x1f; {
			case inPrefix && (t == 9 || t == 12):
				continue
			case (t >= 1 && t <= 5) || (t >= 19 && t <= 21):
				inPrefix = false
			}
		}
		out = append(out, 0, 0, 0, 1)
		out = append(out, nal...)
	}
	p, err := h264PrefixLen(out)
	if err != nil {
		return nil, 0, err
	}
	return out, p, nil
}

// h264PrefixLen: frame MUST begin with a start code. NAL types 6-18, 22 and 23 before the first
// slice are clear; the first slice (1 or 5) is clear through its header byte and the slice-header
// bytes covering pic_parameter_set_id; 2-4 and 19-21 are UnsupportedCodec; 0 and 24-31 are
// MalformedPrefix; a frame with no slice is NoVCLNAL.
func h264PrefixLen(frame []byte) (int, error) {
	nalus := findNALUs(frame)
	if len(nalus) == 0 || nalus[0].start != 0 {
		return 0, ErrMalformedPrefix
	}
	for _, n := range nalus {
		payload := frame[n.payload:n.end]
		if len(payload) == 0 {
			return 0, ErrMalformedPrefix
		}
		switch t := payload[0] & 0x1f; {
		case t == 1 || t == 5:
			covered, err := bytesCoveringH264PPS(payload[1:])
			if err != nil {
				return 0, err
			}
			return n.payload + 1 + covered, nil
		case (t >= 2 && t <= 4) || (t >= 19 && t <= 21):
			return 0, ErrUnsupportedCodec
		case (t >= 6 && t <= 18) || t == 22 || t == 23:
		default:
			return 0, ErrMalformedPrefix
		}
	}
	return 0, ErrNoVCLNAL
}

// escapedBits reads bits MSB-first from an escaped NAL payload, skipping the 03 of 00 00 03 whenever
// a read starts a new byte at index >= 2 (libdave's emulation rule).
type escapedBits struct {
	data []byte
	bit  int
}

func (r *escapedBits) next() (uint64, error) {
	if r.bit%8 == 0 {
		at := r.bit / 8
		if at >= 2 && at < len(r.data) && r.data[at] == 3 && r.data[at-1] == 0 && r.data[at-2] == 0 {
			r.bit += 8
		}
	}
	if r.bit/8 >= len(r.data) {
		return 0, ErrMalformedPrefix
	}
	b := r.data[r.bit/8] >> (7 - r.bit%8) & 1
	r.bit++
	return uint64(b), nil
}

func (r *escapedBits) ue() (uint64, error) {
	zeros := 0
	for {
		b, err := r.next()
		if err != nil {
			return 0, err
		}
		if b == 1 {
			break
		}
		zeros++
		if zeros > 31 {
			return 0, ErrMalformedPrefix
		}
	}
	var v uint64
	for range zeros {
		b, err := r.next()
		if err != nil {
			return 0, err
		}
		v = v<<1 | b
	}
	return 1<<zeros - 1 + v, nil
}

// bytesCoveringH264PPS is libdave's BytesCoveringH264PPS (codec_utils.cpp:16-75): first_mb_in_slice,
// slice_type and pic_parameter_set_id as bit_index/8 + 1 escaped bytes; pic_parameter_set_id above
// 255 (libwebrtc's kMaxPpsId) is MalformedPrefix.
func bytesCoveringH264PPS(payload []byte) (int, error) {
	r := &escapedBits{data: payload}
	for range 2 { // first_mb_in_slice, slice_type
		if _, err := r.ue(); err != nil {
			return 0, err
		}
	}
	pps, err := r.ue()
	if err != nil {
		return 0, err
	}
	if pps > 255 {
		return 0, ErrMalformedPrefix
	}
	covered := r.bit/8 + 1
	if covered > len(payload) {
		return 0, ErrMalformedPrefix
	}
	return covered, nil
}

// trailingZeros is how many 00 bytes end prefix, capped at 2: the seed of the escape after it.
func trailingZeros(prefix []byte) uint8 {
	var n uint8
	for i := len(prefix) - 1; i >= 0 && prefix[i] == 0 && n < 2; i-- {
		n++
	}
	return n
}

// RBSPEscape is WriteRbsp(00^seed || data)[seed:] (libwebrtc h264_common.cc:98-118): an 03 before
// every byte <= 03 that follows two or more zeros, the zero count restarting after it.
func RBSPEscape(seed uint8, data []byte) []byte {
	out := make([]byte, 0, len(data)+len(data)/2+1)
	zeros := int(min(seed, 2))
	for _, b := range data {
		if b <= 3 && zeros >= 2 {
			out = append(out, 3)
			zeros = 0
		}
		out = append(out, b)
		if b == 0 {
			zeros++
		} else {
			zeros = 0
		}
	}
	return out
}

// RBSPUnescape is ParseRbsp(00^seed || data)[seed:] (h264_common.cc:74-95): every 00 00 03 loses
// its 03.
func RBSPUnescape(seed uint8, data []byte) []byte {
	s := int(min(seed, 2))
	buf := make([]byte, s, s+len(data))
	buf = append(buf, data...)
	out := make([]byte, 0, len(buf))
	for i := 0; i < len(buf); {
		if len(buf)-i >= 3 && buf[i] == 0 && buf[i+1] == 0 && buf[i+2] == 3 {
			out = append(out, 0, 0)
			i += 3
			continue
		}
		out = append(out, buf[i])
		i++
	}
	return out[s:]
}

// rbsp is a plain RBSP bit reader for the SPS check (the payload is unescaped first).
type rbsp struct {
	data []byte
	bit  int
}

func (r *rbsp) u(n int) (uint64, error) {
	var v uint64
	for range n {
		if r.bit/8 >= len(r.data) {
			return 0, ErrNonCanonicalSPS
		}
		v = v<<1 | uint64(r.data[r.bit/8]>>(7-r.bit%8)&1)
		r.bit++
	}
	return v, nil
}

func (r *rbsp) flag() (bool, error) {
	v, err := r.u(1)
	return v == 1, err
}

func (r *rbsp) ue() (uint64, error) {
	zeros := 0
	for {
		b, err := r.u(1)
		if err != nil {
			return 0, err
		}
		if b == 1 {
			break
		}
		zeros++
		if zeros > 31 {
			return 0, ErrNonCanonicalSPS
		}
	}
	v, err := r.u(zeros)
	if err != nil {
		return 0, err
	}
	return 1<<zeros - 1 + v, nil
}

func (r *rbsp) se() (int64, error) {
	k, err := r.ue()
	if err != nil {
		return 0, err
	}
	mag := int64((k + 1) / 2) //nolint:gosec // G115: k < 2^32 (ue stops at 31 zeros)
	if k%2 == 1 {
		return mag, nil
	}
	return -mag, nil
}

func (r *rbsp) scalingList(size int) error {
	last, next := int64(8), int64(8)
	for range size {
		if next != 0 {
			d, err := r.se()
			if err != nil {
				return err
			}
			next = ((last+d)%256 + 256) % 256
		}
		if next != 0 {
			last = next
		}
	}
	return nil
}

func (r *rbsp) hrd() error {
	cpb, err := r.ue()
	if err != nil {
		return err
	}
	if cpb > 31 {
		return ErrNonCanonicalSPS
	}
	if _, err := r.u(8); err != nil { // bit_rate_scale, cpb_size_scale
		return err
	}
	for range cpb + 1 {
		if _, err := r.ue(); err != nil { // bit_rate_value_minus1
			return err
		}
		if _, err := r.ue(); err != nil { // cpb_size_value_minus1
			return err
		}
		if _, err := r.u(1); err != nil { // cbr_flag
			return err
		}
	}
	_, err = r.u(20) // four 5-bit length fields
	return err
}

// highProfile is the profile_idc set whose SPS carries chroma format, bit depths and scaling lists.
func highProfile(p uint64) bool {
	switch p {
	case 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135:
		return true
	}
	return false
}

// CheckSPSVUI is libwebrtc's incoming VUI rule (SpsVuiRewriter::ParseAndRewriteSps, kIncoming): a
// receiver rewrites an SPS — and so changes the AAD — unless vui_parameters_present_flag = 1,
// bitstream_restriction_flag = 1, max_num_reorder_frames = 0 and max_dec_frame_buffering <=
// max_num_ref_frames. spsNAL is one NAL with its header byte (type 7) and no start code.
func CheckSPSVUI(spsNAL []byte) error {
	if len(spsNAL) == 0 || spsNAL[0]&0x1f != 7 {
		return ErrNonCanonicalSPS
	}
	r := &rbsp{data: RBSPUnescape(0, spsNAL[1:])}
	profile, err := r.u(8)
	if err != nil {
		return err
	}
	if _, err := r.u(16); err != nil { // constraint flags, reserved bits, level_idc
		return err
	}
	if _, err := r.ue(); err != nil { // seq_parameter_set_id
		return err
	}
	if highProfile(profile) {
		chroma, err := r.ue()
		if err != nil {
			return err
		}
		if chroma == 3 {
			if _, err := r.u(1); err != nil { // separate_colour_plane_flag
				return err
			}
		}
		if _, err := r.ue(); err != nil { // bit_depth_luma_minus8
			return err
		}
		if _, err := r.ue(); err != nil { // bit_depth_chroma_minus8
			return err
		}
		if _, err := r.u(1); err != nil { // qpprime_y_zero_transform_bypass_flag
			return err
		}
		present, err := r.flag()
		if err != nil {
			return err
		}
		if present {
			lists := 8
			if chroma == 3 {
				lists = 12
			}
			for i := range lists {
				on, err := r.flag()
				if err != nil {
					return err
				}
				if on {
					size := 64
					if i < 6 {
						size = 16
					}
					if err := r.scalingList(size); err != nil {
						return err
					}
				}
			}
		}
	}
	if _, err := r.ue(); err != nil { // log2_max_frame_num_minus4
		return err
	}
	poc, err := r.ue()
	if err != nil {
		return err
	}
	switch poc {
	case 0:
		if _, err := r.ue(); err != nil { // log2_max_pic_order_cnt_lsb_minus4
			return err
		}
	case 1:
		if _, err := r.u(1); err != nil { // delta_pic_order_always_zero_flag
			return err
		}
		if _, err := r.se(); err != nil { // offset_for_non_ref_pic
			return err
		}
		if _, err := r.se(); err != nil { // offset_for_top_to_bottom_field
			return err
		}
		cycle, err := r.ue()
		if err != nil {
			return err
		}
		if cycle > 255 {
			return ErrNonCanonicalSPS
		}
		for range cycle {
			if _, err := r.se(); err != nil {
				return err
			}
		}
	}
	maxRef, err := r.ue()
	if err != nil {
		return err
	}
	if _, err := r.u(1); err != nil { // gaps_in_frame_num_value_allowed_flag
		return err
	}
	if _, err := r.ue(); err != nil { // pic_width_in_mbs_minus1
		return err
	}
	if _, err := r.ue(); err != nil { // pic_height_in_map_units_minus1
		return err
	}
	frameMbsOnly, err := r.flag()
	if err != nil {
		return err
	}
	if !frameMbsOnly {
		if _, err := r.u(1); err != nil { // mb_adaptive_frame_field_flag
			return err
		}
	}
	if _, err := r.u(1); err != nil { // direct_8x8_inference_flag
		return err
	}
	crop, err := r.flag()
	if err != nil {
		return err
	}
	if crop {
		for range 4 {
			if _, err := r.ue(); err != nil {
				return err
			}
		}
	}
	vui, err := r.flag()
	if err != nil {
		return err
	}
	if !vui {
		return ErrNonCanonicalSPS // no VUI: the receiver would add one
	}
	return checkVUI(r, maxRef)
}

// checkVUI reads the VUI through the bitstream restriction and applies the incoming rule.
func checkVUI(r *rbsp, maxRef uint64) error {
	if on, err := r.flag(); err != nil { // aspect_ratio_info_present_flag
		return err
	} else if on {
		idc, err := r.u(8)
		if err != nil {
			return err
		}
		if idc == 255 {
			if _, err := r.u(32); err != nil { // sar_width, sar_height
				return err
			}
		}
	}
	if on, err := r.flag(); err != nil { // overscan_info_present_flag
		return err
	} else if on {
		if _, err := r.u(1); err != nil {
			return err
		}
	}
	if on, err := r.flag(); err != nil { // video_signal_type_present_flag
		return err
	} else if on {
		if _, err := r.u(4); err != nil { // video_format, video_full_range_flag
			return err
		}
		if colour, err := r.flag(); err != nil {
			return err
		} else if colour {
			if _, err := r.u(24); err != nil {
				return err
			}
		}
	}
	if on, err := r.flag(); err != nil { // chroma_loc_info_present_flag
		return err
	} else if on {
		if _, err := r.ue(); err != nil {
			return err
		}
		if _, err := r.ue(); err != nil {
			return err
		}
	}
	if on, err := r.flag(); err != nil { // timing_info_present_flag
		return err
	} else if on {
		if _, err := r.u(65); err != nil { // num_units_in_tick, time_scale, fixed_frame_rate_flag
			return err
		}
	}
	nalHRD, err := r.flag()
	if err != nil {
		return err
	}
	if nalHRD {
		if err := r.hrd(); err != nil {
			return err
		}
	}
	vclHRD, err := r.flag()
	if err != nil {
		return err
	}
	if vclHRD {
		if err := r.hrd(); err != nil {
			return err
		}
	}
	if nalHRD || vclHRD {
		if _, err := r.u(1); err != nil { // low_delay_hrd_flag
			return err
		}
	}
	if _, err := r.u(1); err != nil { // pic_struct_present_flag
		return err
	}
	restriction, err := r.flag()
	if err != nil {
		return err
	}
	if !restriction {
		return ErrNonCanonicalSPS
	}
	if _, err := r.u(1); err != nil { // motion_vectors_over_pic_boundaries_flag
		return err
	}
	for range 4 { // max_bytes_per_pic_denom, max_bits_per_mb_denom, two log2_max_mv_length fields
		if _, err := r.ue(); err != nil {
			return err
		}
	}
	reorder, err := r.ue()
	if err != nil {
		return err
	}
	decBuffering, err := r.ue()
	if err != nil {
		return err
	}
	if reorder != 0 || decBuffering > maxRef {
		return ErrNonCanonicalSPS
	}
	return nil
}

// checkPrefixSPS runs CheckSPSVUI over every SPS in a canonical prefix. The sender refuses a frame
// whose SPS a libwebrtc receiver would rewrite, so it fails at the source, not as AEAD everywhere.
func checkPrefixSPS(prefix []byte) error {
	for _, n := range findNALUs(prefix) {
		nal := prefix[n.payload:n.end]
		if len(nal) > 0 && nal[0]&0x1f == 7 {
			if err := CheckSPSVUI(nal); err != nil {
				return err
			}
		}
	}
	return nil
}
