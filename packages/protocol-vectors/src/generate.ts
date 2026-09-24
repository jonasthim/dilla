import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hex } from './bytes.ts';
import { encodeEnvelope, frankingCommitment, frankingTag, EnvelopeType, type Envelope } from './envelope.ts';
import { kid, deriveFrameKeys, counter, nonce, encodeSframeHeader, SUITE } from './sframe.ts';
import { safetyNumber, sas, recoveryKeyBase32, deriveRecoveryKeys, credentialIdentity, sskMessage, dskMessage } from './identity.ts';
import { keyFromSeed, sign } from './ed25519.ts';

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
  const rejects = [
    { name: 'delete tombstone with a non-empty body', error: 'E_ENVELOPE_LIMIT', cbor: hex(encodeEnvelope({
      v: 1, msgId: fill(16, 0x21), type: EnvelopeType.Delete, threadId: null, replyTo: fill(16, 0x01),
      body: 'deleted because', attachments: [], previews: [], kf: fill(32, 0x26) })) },
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

  return {
    version: 1,
    description: 'safety number (60 digits), SAS (30 digits), recovery key encodings and derived keys, credential identity CBOR with real Ed25519 signatures (03-identity.md)',
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
  };
}

export async function main() {
  mkdirSync(VECTORS_DIR, { recursive: true });
  writeFileSync(join(VECTORS_DIR, 'envelope.json'), j(await envelopeVectors()));
  writeFileSync(join(VECTORS_DIR, 'franking.json'), j(await frankingVectors()));
  writeFileSync(join(VECTORS_DIR, 'sframe.json'), j(await sframeVectors()));
  writeFileSync(join(VECTORS_DIR, 'identity.json'), j(await identityVectors()));
  console.log(`vectors written to ${VECTORS_DIR}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
