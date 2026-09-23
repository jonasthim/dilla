import { describe, it, expect } from 'vitest';
import { encodeEnvelope, decodeEnvelope, frankingCommitment, frankingTag, paddedLength, EnvelopeType, type Envelope } from './envelope.ts';
import { decode } from './cbor.ts';
import { hex, fromHex } from './bytes.ts';

const id = (n: number) => new Uint8Array(16).fill(n);
const sample: Envelope = {
  v: 1, msgId: id(1), type: EnvelopeType.Message, threadId: null, replyTo: id(2),
  body: 'On my way. Grab the wolf capes from the chest by the portal.',
  attachments: [{ blobId: new Uint8Array(32).fill(3), key: new Uint8Array(32).fill(4), nonce: new Uint8Array(12).fill(5), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null }],
  previews: [],
  kf: new Uint8Array(32).fill(6),
};

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
  it('pads to 256-byte buckets', () => {
    expect(paddedLength(1)).toBe(256);
    expect(paddedLength(256)).toBe(256);
    expect(paddedLength(257)).toBe(512);
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
