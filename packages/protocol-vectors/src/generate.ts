import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromHex, hex } from './bytes.ts';
import { encodeEnvelope, frankingCommitment, frankingTag, EnvelopeType, type Envelope, type Attachment, type Preview } from './envelope.ts';
import { kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE } from './sframe.ts';
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity, sskMessage, dskMessage, sessionPreimage } from './identity.ts';
import { keyFromSeed, sign } from './ed25519.ts';
import { frameVectors } from './frames.ts';

export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'protocol', 'vectors');
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const j = (o: unknown) => JSON.stringify(o, (_, v) => v instanceof Uint8Array ? hex(v) : v, 2) + '\n';

export async function envelopeVectors() {
  const cases: Array<{ name: string; envelope: Envelope }> = [
    { name: 'text message with a reply and one attachment', envelope: {
      v: 1, msgId: fill(16, 0x01), type: EnvelopeType.Message, threadId: null, replyTo: fill(16, 0x02),
      body: 'On my way. Grab the wolf capes from the chest by the portal.',
      attachments: [{ blobId: fill(32, 0x03), key: fill(32, 0x04), nonce: fill(12, 0x05), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null }],
      previews: [], kf: fill(32, 0x06) } },
    { name: 'reaction add in a thread', envelope: {
      v: 1, msgId: fill(16, 0x11), type: EnvelopeType.ReactionAdd, threadId: fill(16, 0x12), replyTo: fill(16, 0x13),
      body: '⛏', attachments: [], previews: [], kf: fill(32, 0x16) } },
    { name: 'delete tombstone', envelope: {
      v: 1, msgId: fill(16, 0x21), type: EnvelopeType.Delete, threadId: null, replyTo: fill(16, 0x01),
      body: '', attachments: [], previews: [], kf: fill(32, 0x26) } },
    { name: 'message with a sender-generated link preview', envelope: {
      v: 1, msgId: fill(16, 0x31), type: EnvelopeType.Message, threadId: null, replyTo: null,
      body: 'https://valheim.fandom.com/wiki/Silver', attachments: [],
      previews: [{ url: 'https://valheim.fandom.com/wiki/Silver', title: 'Silver', description: 'Silver is a metal found in the Mountains.', image: null }],
      kf: fill(32, 0x36) } },
  ];
  const out = [];
  for (const c of cases) {
    const bytes = encodeEnvelope(c.envelope);
    out.push({ name: c.name, envelope: c.envelope, cbor: hex(bytes), length: bytes.length, commitment: hex(await frankingCommitment(c.envelope)) });
  }
  // Inputs a conforming decoder must REFUSE, with the error code 04-envelope-and-franking.md
  // names for each. `encodeEnvelope` does not apply the limits, so it can produce the well-formed
  // deterministic CBOR of an envelope that is nonetheless invalid — which is exactly what an
  // implementation under test has to be handed.
  //
  // interfaces.md §2.8: nine cases, not one — a count case per collection (5 attachments, 3
  // previews) plus one case per tightened scalar bound, beside the pre-existing tombstone case.
  const sampleAttachment = (): Attachment => ({ blobId: fill(32, 0x03), key: fill(32, 0x04), nonce: fill(12, 0x05), size: 2100000, mime: 'image/jpeg', w: 1600, h: 900, thumb: null });
  const samplePreview = (): Preview => ({ url: 'https://example.invalid/', title: 't', description: 'd', image: null });
  const rejectBase = { v: 1 as const, msgId: fill(16, 0x21), type: EnvelopeType.Message, threadId: null, replyTo: null, kf: fill(32, 0x26) };
  const withAttachment = (patch: Partial<Attachment>): Envelope => ({
    ...rejectBase, body: '', attachments: [{ ...sampleAttachment(), ...patch }], previews: [],
  });
  const withPreview = (patch: Partial<Preview>): Envelope => ({
    ...rejectBase, body: '', attachments: [], previews: [{ ...samplePreview(), ...patch }],
  });
  const rejectCase = (name: string, envelope: Envelope) => ({ name, error: 'E_ENVELOPE_LIMIT', cbor: hex(encodeEnvelope(envelope)) });
  const rejects = [
    rejectCase('delete tombstone with a non-empty body', { ...rejectBase, type: EnvelopeType.Delete, replyTo: fill(16, 0x01), body: 'deleted because', attachments: [], previews: [] }),
    rejectCase('mime one byte over 255', withAttachment({ mime: 'a'.repeat(256) })),
    rejectCase('thumb one byte over 8192', withAttachment({ thumb: new Uint8Array(8193) })),
    rejectCase('five attachments', { ...rejectBase, body: '', attachments: Array.from({ length: 5 }, sampleAttachment), previews: [] }),
    rejectCase('three previews', { ...rejectBase, body: '', attachments: [], previews: Array.from({ length: 3 }, samplePreview) }),
    rejectCase('preview url one byte over 2048', withPreview({ url: 'u'.repeat(2049) })),
    rejectCase('preview title one byte over 256', withPreview({ title: 't'.repeat(257) })),
    rejectCase('preview description one byte over 1024', withPreview({ description: 'd'.repeat(1025) })),
    rejectCase('preview image one byte over 16384', withPreview({ image: new Uint8Array(16385) })),
  ];
  return { version: 1, description: 'dilla envelope encodings (04-envelope-and-franking.md). cbor = deterministic CBOR of the 9-element array; commitment = HMAC-SHA256(k_f, "dilla frank v1" || CBOR with k_f blanked). rejects = well-formed CBOR that a conforming decoder must still refuse with the named error code.', cases: out, rejects };
}

export async function frankingVectors() {
  const env: Envelope = { v: 1, msgId: fill(16, 0x01), type: EnvelopeType.Message, threadId: null, replyTo: null, body: 'Found a silver vein under the mountain.', attachments: [], previews: [], kf: fill(32, 0x06) };
  const commitment = await frankingCommitment(env);
  const instanceKey = fill(32, 0x09);
  const cases = [];
  for (const [epoch, seq, ts] of [[41, 4127, 1758659640], [41, 4128, 1758659700], [42, 4129, 1758659760]] as const) {
    cases.push({ group_id: hex(fill(16, 0x07)), epoch, seq, uploader_device: hex(fill(16, 0x08)), commitment: hex(commitment), recv_ts: ts,
      tag: hex(await frankingTag(instanceKey, fill(16, 0x07), epoch, seq, fill(16, 0x08), commitment, ts)) });
  }
  return { version: 1, description: 'franking tags: T = HMAC-SHA256(K_frank, "dilla frank tag v1" || group_id || epoch(8) || seq(8) || uploader_device || C || recv_ts(8))', instance_franking_key: hex(instanceKey), envelope_cbor: hex(encodeEnvelope(env)), cases };
}

export async function sframeVectors() {
  const baseKey = fill(16, 0x0a);
  const cases = [];
  for (const [leaf, epoch, slot, layer, seq] of [[0, 41, 0, 0, 0], [3, 41, 0, 0, 1], [3, 297, 1, 2, 1000], [65535, 255, 3, 15, (1 << 30)]] as const) {
    const k = kid(leaf, epoch);
    const { key, salt } = await deriveFrameKeys(baseKey, k);
    const ctr = counter(slot, layer, seq);
    cases.push({ leaf_index: leaf, epoch, kid: k.toString(), key: hex(key), salt: hex(salt), slot, layer, seq, ctr: ctr.toString(), nonce: hex(nonce(salt, ctr)), header: hex(encodeSframeHeader(k, ctr)) });
  }
  return { version: 1, suite: SUITE, description: 'dilla-sframe/1 key schedule (05-media-frames.md): base_key = MLS-Exporter("SFrame 1.0 Base Key", "", 16); key/salt per RFC 9605 §4.4.2; CTR = slot(8)|layer(4)|seq(52); nonce = salt XOR CTR; header per RFC 9605 §4.3.', base_key: hex(baseKey), cases };
}

export async function identityVectors() {
  const umkA = fill(32, 0xa1), umkB = fill(32, 0xb2);
  const rk = fill(32, 0x0b);
  const keys = await deriveRecoveryKeys(rk);

  // Deterministic seeds. They are published in the vector file so any implementation can
  // reproduce both signatures; they are test material and protect nothing.
  const umkSeed = fill(32, 0x41);
  const sskSeed = fill(32, 0x42);
  const dskSeed = fill(32, 0x43);
  const umk = await keyFromSeed(umkSeed);
  const ssk = await keyFromSeed(sskSeed);
  const dsk = await keyFromSeed(dskSeed);

  const userId = fill(16, 0xd4), deviceId = fill(16, 0xe5);
  const kind = 0, tier = 1, signerTier = 0;
  const sigUmkSsk = await sign(umk.privateKey, sskMessage(ssk.publicKey));
  const sigSskDev = await sign(ssk.privateKey, dskMessage(deviceId, dsk.publicKey, kind, tier, signerTier));

  // The device-session signature preimage (02-delivery-service.md "Device sessions"). The inputs
  // are fixed, not random, so a client in any language can check its own 81 bytes against the
  // instance's without running a handshake.
  const sessionInstanceId = fromHex('00112233445566778899aabbccddeeff');
  const sessionDeviceId = fromHex('0102030405060708090a0b0c0d0e0f10');
  const sessionNonce = fill(32, 0xab);

  return {
    version: 1,
    description: 'safety number (60 digits), SAS (30 digits), recovery key encodings and derived keys, credential identity CBOR with real Ed25519 signatures, and the 81-byte device-session signature preimage (03-identity.md, 02-delivery-service.md)',
    safety_number: { umk_a: hex(umkA), umk_b: hex(umkB), digits: await safetyNumber(umkA, umkB) },
    sas: { epoch_authenticator: hex(fill(32, 0xc3)), digits: sas(fill(32, 0xc3)) },
    recovery_key: { rk: hex(rk), base32: recoveryKeyBase32(rk), k_header: hex(keys.header), k_backup: hex(keys.archive) },
    credential_identity: {
      umk_priv: hex(umkSeed),
      ssk_priv: hex(sskSeed),
      dsk_priv: hex(dskSeed),
      dsk_pub: hex(dsk.publicKey),
      fields: {
        umk_pub: hex(umk.publicKey), user_id: hex(userId), device_id: hex(deviceId),
        kind, tier, signer_tier: signerTier, ssk_pub: hex(ssk.publicKey),
        sig_umk_ssk: hex(sigUmkSsk), sig_ssk_dev: hex(sigSskDev),
      },
      cbor: hex(credentialIdentity({
        umkPub: umk.publicKey, userId, deviceId, kind, tier, signerTier,
        sskPub: ssk.publicKey, sigUmkSsk, sigSskDev,
      })),
    },
    session_preimage: {
      instance_id: hex(sessionInstanceId),
      device_id: hex(sessionDeviceId),
      nonce: hex(sessionNonce),
      purpose: 0,
      preimage: hex(sessionPreimage(sessionInstanceId, sessionDeviceId, sessionNonce, 0)),
    },
  };
}

export async function main() {
  mkdirSync(VECTORS_DIR, { recursive: true });
  writeFileSync(join(VECTORS_DIR, 'envelope.json'), j(await envelopeVectors()));
  writeFileSync(join(VECTORS_DIR, 'franking.json'), j(await frankingVectors()));
  writeFileSync(join(VECTORS_DIR, 'sframe.json'), j(await sframeVectors()));
  writeFileSync(join(VECTORS_DIR, 'identity.json'), j(await identityVectors()));
  writeFileSync(join(VECTORS_DIR, 'frames.json'), j(frameVectors()));
  console.log(`vectors written to ${VECTORS_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
