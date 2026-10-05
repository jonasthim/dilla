// The one writer of dilla-manifest.json (L-HTTP-11, ruling 37): the list of every file of a built web
// tree with its SHA-256 and size, which internal/web checks before it serves the tree. The harness build
// (packages/client-core) runs it as a command; packages/web/scripts/write-manifest.mjs imports
// buildManifest and MANIFEST_NAME from here, so both builds write the same manifest.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_NAME = 'dilla-manifest.json';

function walk(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path, rel, out);
    else if (entry.isFile()) {
      if (prefix === '' && entry.name === MANIFEST_NAME) continue;
      out.push({ path: rel, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'), size: statSync(path).size });
    }
    // Anything else (a symbolic link, a socket) is neither listed nor followed.
  }
  return out;
}

/** { v: 1, files: { path, sha256, size }[] }: every regular file under dir except a top-level dilla-manifest.json,
 *  forward-slash relative paths, lower-case SHA-256 hex, byte size, sorted by Buffer.compare of the UTF-8 paths. */
export function buildManifest(dir) {
  const files = walk(dir, '', []);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { v: 1, files };
}

/** 0 written, 1 refused (dir missing or index.html missing), 2 usage. */
export function main(argv) {
  const dir = argv[0];
  if (dir === undefined) {
    console.error('usage: write-manifest.mjs <dist-dir>');
    return 2;
  }
  if (!existsSync(dir)) {
    console.error(`${dir}: no such directory`);
    return 1;
  }
  if (!existsSync(join(dir, 'index.html'))) {
    console.error(`${dir}: index.html is missing`);
    return 1;
  }
  writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(buildManifest(dir)) + '\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
