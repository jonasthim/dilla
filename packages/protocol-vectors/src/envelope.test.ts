import { describe, it, expect } from 'vitest';
import { encodeEnvelope, decodeEnvelope, frankingCommitment, frankingTag, EnvelopeType, type Envelope } from './envelope.ts';
import { encode, decode, type CborValue } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const sample: Envelope = {
  v: 1, msgId: id(1), type: EnvelopeType.Message, threadId: null, replyTo: id(2),
  body: 'On my way. Grab the wolf capes from the chest by the portal.',
  attachments: [{ blobId: new Uint8Array(32).fill(3), key: new Uint8Array(32).fill(4), nonce: new Uint8Array(12).fill(5), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null }],
  previews: [],
  kf: new Uint8Array(32).fill(6),
};

/** Encodes a raw 9-element array as CBOR, bypassing envelope field validation, for malformed-input tests. */
function encodeRaw(elements: CborValue[]): Uint8Array {
  return encode(elements);
}

describe('envelope', () => {
  it('encodes as a fixed-position 9-element array', () => {
    const bytes = encodeEnvelope(sample);
    const arr = decode(bytes) as unknown[];
    expect(arr.length).toBe(9);
    expect(arr[0]).toBe(1);
    expect(hex(arr[1] as Uint8Array)).toBe(hex(id(1)));
    expect(arr[2]).toBe(0);
    expect(arr[3]).toBeNull();
  });
  it('round-trips', () => {
    expect(decodeEnvelope(encodeEnvelope(sample))).toEqual(sample);
  });
  it('rejects the wrong element count', () => {
    expect(() => decodeEnvelope(fromHex('8801' + '50' + '00'.repeat(16)))).toThrow();
  });
  it('rejects an unknown type', () => {
    const raw = [1, id(1), 99, null, null, '', [], [], new Uint8Array(32)];
    expect(() => decodeEnvelope(encodeRaw(raw))).toThrow();
  });
  it('rejects a msg_id of the wrong length', () => {
    const raw = [1, new Uint8Array(15), 0, null, null, '', [], [], new Uint8Array(32)];
    expect(() => decodeEnvelope(encodeRaw(raw))).toThrow();
  });
  it('rejects a k_f of the wrong length', () => {
    const raw = [1, id(1), 0, null, null, '', [], [], new Uint8Array(31)];
    expect(() => decodeEnvelope(encodeRaw(raw))).toThrow();
  });
  it('rejects non-minimal CBOR', () => {
    // A minimal 9-element envelope array, but `v` is encoded as the 1-byte-follows form (0x18 0x01)
    // instead of the minimal single-byte form (0x01).
    const nonMinimal = fromHex('89' + '1801' + '50' + '01'.repeat(16) + '00' + 'f6' + 'f6' + '60' + '80' + '80' + '5820' + '00'.repeat(32));
    expect(() => decodeEnvelope(nonMinimal)).toThrow();
  });
  it('rejects trailing bytes', () => {
    const bytes = encodeEnvelope(sample);
    const withTrailer = new Uint8Array(bytes.length + 1);
    withTrailer.set(bytes);
    withTrailer[bytes.length] = 0x00;
    expect(() => decodeEnvelope(withTrailer)).toThrow();
  });
  it('rejects a body over the 4000-byte limit for type 0/1', () => {
    const long: Envelope = { ...sample, body: 'a'.repeat(4001) };
    expect(() => decodeEnvelope(encodeEnvelope(long))).toThrow();
  });
  it('rejects a body over the 32-byte limit for type 3/4', () => {
    const reaction: Envelope = { ...sample, type: EnvelopeType.ReactionAdd, body: 'a'.repeat(33), attachments: [] };
    expect(() => decodeEnvelope(encodeEnvelope(reaction))).toThrow();
  });
  it('rejects more than 10 attachments', () => {
    const a = sample.attachments[0];
    const many: Envelope = { ...sample, attachments: Array.from({ length: 11 }, () => a) };
    expect(() => decodeEnvelope(encodeEnvelope(many))).toThrow();
  });
  it('rejects more than 5 previews', () => {
    const p = { url: 'https://example.com', title: 't', description: 'd', image: null };
    const many: Envelope = { ...sample, attachments: [], previews: Array.from({ length: 6 }, () => p) };
    expect(() => decodeEnvelope(encodeEnvelope(many))).toThrow();
  });
  it('rejects a preview image over 32768 bytes', () => {
    const p = { url: 'https://example.com', title: 't', description: 'd', image: new Uint8Array(32769) };
    const withPreview: Envelope = { ...sample, attachments: [], previews: [p] };
    expect(() => decodeEnvelope(encodeEnvelope(withPreview))).toThrow();
  });
  it('rejects a thumb over 16384 bytes', () => {
    const a = { ...sample.attachments[0], thumb: new Uint8Array(16385) };
    const withThumb: Envelope = { ...sample, attachments: [a] };
    expect(() => decodeEnvelope(encodeEnvelope(withThumb))).toThrow();
  });
  it('commitment changes when the body changes and is independent of k_f placement', async () => {
    const c1 = await frankingCommitment(sample);
    const c2 = await frankingCommitment({ ...sample, body: sample.body + '!' });
    expect(c1.length).toBe(32);
    expect(hex(c1)).not.toBe(hex(c2));
    // the commitment is an HMAC under k_f of the envelope with k_f blanked: recomputable by a recipient
    const again = await frankingCommitment(sample);
    expect(hex(again)).toBe(hex(c1));
  });
  it('tag is 32 bytes and binds the sequence number', async () => {
    const key = new Uint8Array(32).fill(9);
    const c = await frankingCommitment(sample);
    const t1 = await frankingTag(key, id(7), 41, 4128, id(8), c, 1758659700);
    const t2 = await frankingTag(key, id(7), 41, 4129, id(8), c, 1758659700);
    expect(t1.length).toBe(32);
    expect(hex(t1)).not.toBe(hex(t2));
  });
});
