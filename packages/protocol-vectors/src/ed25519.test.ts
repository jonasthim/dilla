import { describe, it, expect } from 'vitest';
import { keyFromSeed, sign, verify } from './ed25519.ts';
import { sskMessage, dskMessage } from './identity.ts';
import { fromHex, hex } from './bytes.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR } from './generate.ts';

describe('Ed25519 through WebCrypto', () => {
  it('derives the same key pair from the same seed every time', async () => {
    const a = await keyFromSeed(new Uint8Array(32).fill(0x41));
    const b = await keyFromSeed(new Uint8Array(32).fill(0x41));
    expect(hex(a.publicKey)).toBe(hex(b.publicKey));
    expect(a.publicKey).toHaveLength(32);

    const c = await keyFromSeed(new Uint8Array(32).fill(0x42));
    expect(hex(c.publicKey)).not.toBe(hex(a.publicKey));
  });

  it('produces 64-byte signatures that verify and that reject a flipped bit', async () => {
    const key = await keyFromSeed(new Uint8Array(32).fill(0x41));
    const message = new TextEncoder().encode('dilla');
    const sig = await sign(key.privateKey, message);
    expect(sig).toHaveLength(64);
    expect(await verify(key.publicKey, message, sig)).toBe(true);

    const bad = Uint8Array.from(sig);
    bad[0] ^= 0x01;
    expect(await verify(key.publicKey, message, bad)).toBe(false);
    expect(await verify(key.publicKey, new TextEncoder().encode('dillb'), sig)).toBe(false);
  });

  it('rejects a seed that is not 32 bytes', async () => {
    await expect(keyFromSeed(new Uint8Array(31))).rejects.toThrow();
  });
});

describe('committed identity vectors', () => {
  const doc = JSON.parse(readFileSync(join(VECTORS_DIR, 'identity.json'), 'utf8'));

  it('carries real signatures, not filler bytes', () => {
    const f = doc.credential_identity.fields;
    expect(f.sig_umk_ssk).not.toBe('17'.repeat(64));
    expect(f.sig_ssk_dev).not.toBe('28'.repeat(64));
    expect(f.sig_umk_ssk).toHaveLength(128);
    expect(f.sig_ssk_dev).toHaveLength(128);
  });

  it('carries the private material a verifier needs to reproduce both signatures', () => {
    expect(doc.credential_identity.umk_priv).toHaveLength(64);
    expect(doc.credential_identity.ssk_priv).toHaveLength(64);
    expect(doc.credential_identity.dsk_pub).toHaveLength(64);
  });

  it('verifies sig_umk_ssk against umk_pub over "dilla ssk v1" || ssk_pub', async () => {
    const f = doc.credential_identity.fields;
    expect(
      await verify(
        fromHex(f.umk_pub),
        sskMessage(fromHex(f.ssk_pub)),
        fromHex(f.sig_umk_ssk),
      ),
    ).toBe(true);
  });

  it('verifies sig_ssk_dev against ssk_pub over the dsk message', async () => {
    const f = doc.credential_identity.fields;
    expect(
      await verify(
        fromHex(f.ssk_pub),
        dskMessage(
          fromHex(f.device_id),
          fromHex(doc.credential_identity.dsk_pub),
          f.kind,
          f.tier,
          f.signer_tier,
        ),
        fromHex(f.sig_ssk_dev),
      ),
    ).toBe(true);
  });

  it('reproduces both signatures from the recorded private keys', async () => {
    const f = doc.credential_identity.fields;
    const umk = await keyFromSeed(fromHex(doc.credential_identity.umk_priv));
    const ssk = await keyFromSeed(fromHex(doc.credential_identity.ssk_priv));
    expect(hex(umk.publicKey)).toBe(f.umk_pub);
    expect(hex(ssk.publicKey)).toBe(f.ssk_pub);
    expect(hex(await sign(umk.privateKey, sskMessage(fromHex(f.ssk_pub))))).toBe(f.sig_umk_ssk);
    expect(
      hex(
        await sign(
          ssk.privateKey,
          dskMessage(
            fromHex(f.device_id),
            fromHex(doc.credential_identity.dsk_pub),
            f.kind,
            f.tier,
            f.signer_tier,
          ),
        ),
      ),
    ).toBe(f.sig_ssk_dev);
  });
});
