import { buildManifest, MANIFEST_NAME } from '../../../scripts/write-manifest.mjs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EXTENSIONS = ['.html', '.js', '.css', '.wasm', '.json', '.woff2', '.woff', '.svg', '.png', '.ico', '.txt'];
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);

function walk(dir, rel = '') {
  const paths = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...walk(dir, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

/** @returns {string[]} One line per problem, or [] when the build is servable. */
export function checkDist(dir) {
  const paths = walk(dir).filter(path => path !== MANIFEST_NAME)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const problems = [];
  if (!paths.includes('index.html')) problems.push('index.html is missing');
  let wasm = 0;
  for (const path of paths) {
    const ext = extname(path).toLowerCase();
    if (ext === '.wasm') wasm++;
    if (TEXT_EXTENSIONS.has(ext)) {
      const body = readFileSync(join(dir, path), 'utf8');
      if (ext === '.html') {
        if (/<script\b(?![^>]*\bsrc=)[^>]*>/i.test(body)) problems.push(`${path}: inline <script>`);
        if (/<style\b/i.test(body)) problems.push(`${path}: inline <style>`);
        if (/\sstyle=/i.test(body)) problems.push(`${path}: style attribute`);
      }
      if (body.includes('data:font')) problems.push(`${path}: contains data:font`);
      if (body.includes('data:application/octet-stream;base64')) problems.push(`${path}: contains data:application/octet-stream;base64`);
    }
    if (!ALLOWED_EXTENSIONS.includes(ext)) problems.push(`${path}: extension ${ext || '(none)'} is not served`);
  }
  if (wasm !== 1) problems.push(`expected exactly 1 .wasm file, found ${wasm}`);
  return problems;
}

function main(argv) {
  if (!argv[2]) {
    console.error('usage: write-manifest.mjs <dist-dir>');
    return 2;
  }
  const problems = checkDist(argv[2]);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    return 1;
  }
  const manifest = buildManifest(argv[2]);
  writeFileSync(join(argv[2], MANIFEST_NAME), JSON.stringify(manifest) + '\n');
  console.log(`${MANIFEST_NAME}: ${manifest.files.length} files`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv));
