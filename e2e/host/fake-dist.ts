import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A minimal built web client a dilla-testhost accepts as `-web-root`: index.html, one entry script, its manifest. */
export function writeFakeDist(dir: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const entry = Buffer.from('console.log("dilla fake build");\n');
  const index = Buffer.from('<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AbC123.js"></script></head><body></body></html>\n');
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), entry);
  writeFileSync(join(dir, 'index.html'), index);
  const files = [
    { path: 'assets/index-AbC123.js', sha256: sha(entry), size: entry.length },
    { path: 'index.html', sha256: sha(index), size: index.length },
  ];
  writeFileSync(join(dir, 'dilla-manifest.json'), JSON.stringify({ v: 1, files }));
}
