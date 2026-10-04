import type { DillaMediaStats, DropReason, MediaCodec } from '../protocol';

export const DROP_REASONS: readonly DropReason[] = [
  'parse', 'unknownKid', 'bufferTimeout', 'aeadFail', 'foreignLeaf', 'senderMismatch', 'ownKid',
  'slotMismatch', 'replay', 'expiredKid', 'sif', 'noneFlagged', 'noVclNal', 'unsupportedCodec',
];

export function newStats(): DillaMediaStats {
  return {
    encrypted: {},
    decrypted: {},
    dropped: Object.fromEntries(DROP_REASONS.map((r) => [r, 0])) as Record<DropReason, number>,
    passedThrough: 0,
    currentEpoch: '',
    knownKids: [],
    sifTrailerLen: 0,
  };
}

/** KID = (leaf_index << 8) | (epoch mod 256), as lowercase hex without padding (protocol/05 Key schedule). */
export function kidHex(leaf: number, epoch: bigint): string {
  return ((BigInt(leaf) << 8n) | (epoch & 0xffn)).toString(16);
}

/** The KID of the RFC 9605 §4.3 header at `off`: config byte (X << 7) | (K << 4) | (Y << 3) | C. */
export function sframeKid(b: Uint8Array, off: number): bigint | null {
  if (off >= b.length) return null;
  const cfg = b[off];
  if ((cfg & 0x80) === 0) return BigInt((cfg >> 4) & 0x07);
  const len = ((cfg >> 4) & 0x07) + 1;
  if (off + 1 + len > b.length) return null;
  let v = 0n;
  for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(b[off + 1 + i]);
  return v;
}

function startCodeEnd(b: Uint8Array, from: number): number {
  for (let i = from; i + 2 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i + 3;
  return -1;
}

/** Escaped bytes covering first_mb_in_slice, slice_type and pic_parameter_set_id after a VCL NAL header. */
function bytesCoveringPps(b: Uint8Array, start: number): number | null {
  let pos = start;
  let bit = 0;
  let zeros = 0;
  const nextBit = (): number | null => {
    if (bit === 0) {
      if (pos >= b.length) return null;
      if (zeros >= 2 && b[pos] === 0x03) {
        pos++;
        zeros = 0;
        if (pos >= b.length) return null;
      }
    }
    const v = (b[pos] >> (7 - bit)) & 1;
    bit++;
    if (bit === 8) {
      zeros = b[pos] === 0 ? zeros + 1 : 0;
      bit = 0;
      pos++;
    }
    return v;
  };
  const ue = (): boolean => {
    let lz = 0;
    for (;;) {
      const v = nextBit();
      if (v === null) return false;
      if (v === 1) break;
      if (++lz > 31) return false;
    }
    for (let i = 0; i < lz; i++) if (nextBit() === null) return false;
    return true;
  };
  for (let i = 0; i < 3; i++) if (!ue()) return null;
  return pos - start + (bit > 0 ? 1 : 0);
}

/** The clear H.264 prefix of a received frame: up to the bytes covering the first VCL NAL's pps id (task 4's rule). */
export function h264PrefixLen(b: Uint8Array): number | null {
  let at = startCodeEnd(b, 0);
  while (at !== -1 && at < b.length) {
    const type = b[at] & 0x1f;
    if (type === 1 || type === 5) {
      const n = bytesCoveringPps(b, at + 1);
      return n === null ? null : at + 1 + n;
    }
    at = startCodeEnd(b, at + 1);
  }
  return null;
}

/**
 * The KID of a protected frame, for the per-KID `decrypted` counter only. The wasm receiver has already
 * authenticated the frame when this runs; a parse failure here costs a statistic, never a security decision.
 */
export function peekKidHex(codec: MediaCodec, frame: Uint8Array): string | null {
  let off: number | null;
  switch (codec) {
    case 'opus':
    case 'vp9':
      off = 0;
      break;
    case 'vp8':
      off = frame.length === 0 ? null : (frame[0] & 0x01) === 0 ? 10 : 1;
      break;
    case 'h264':
      off = h264PrefixLen(frame);
      // A KID-0 short header can follow a prefix ending in 00 00 and pick up the seeded escape byte.
      if (off !== null && off >= 2 && frame[off - 1] === 0 && frame[off - 2] === 0 && frame[off] === 0x03) off += 1;
      break;
  }
  if (off === null) return null;
  const kid = sframeKid(frame, off);
  return kid === null ? null : kid.toString(16);
}
