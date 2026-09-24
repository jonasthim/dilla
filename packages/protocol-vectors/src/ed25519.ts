/**
 * Ed25519 through WebCrypto, seeded deterministically so the committed vectors are reproducible.
 *
 * WebCrypto has no "import a raw private key" path for Ed25519: a private key arrives as PKCS#8.
 * The PKCS#8 wrapper for an Ed25519 seed is a fixed 16-byte prefix followed by the 32-byte seed,
 * so a deterministic seed becomes a deterministic CryptoKey with no extra dependency.
 */

/** SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { OCTET STRING (32) } } */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export type Ed25519Key = { privateKey: CryptoKey; publicKey: Uint8Array };

function base64urlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(padded, 'base64'));
}

export async function keyFromSeed(seed: Uint8Array): Promise<Ed25519Key> {
  if (seed.length !== 32) throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (typeof jwk.x !== 'string') throw new Error('Ed25519 JWK has no public component');
  return { privateKey, publicKey: base64urlToBytes(jwk.x) };
}

export async function sign(key: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
}

export async function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, true, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
}
