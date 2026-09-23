import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VECTORS_DIR, envelopeVectors, frankingVectors, sframeVectors, identityVectors } from './generate.ts';
import { hex } from './bytes.ts';

const j = (o: unknown) => JSON.stringify(o, (_, v) => v instanceof Uint8Array ? hex(v) : v, 2) + '\n';

for (const [file, gen] of [['envelope.json', envelopeVectors], ['franking.json', frankingVectors], ['sframe.json', sframeVectors], ['identity.json', identityVectors]] as const) {
  it(`committed ${file} equals the generator output`, async () => {
    expect(readFileSync(join(VECTORS_DIR, file), 'utf8')).toBe(j(await gen()));
  });
}
