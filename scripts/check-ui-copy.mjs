import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN = [
  { word: 'kanal', re: /\bkanals?\b/i }, { word: 'team', re: /\bteams?\b/i }, { word: 'PMs', re: /\bPMs\b/ },
  { word: 'E2E', re: /\bE2EE?\b/ }, { word: 'end-to-end', re: /\bend-to-end\b/i }, { word: 'encrypted', re: /\bencrypted\b/i },
  { word: 'encryption', re: /\bencryption\b/i }, { word: 'SRTP', re: /\bSRTP\b/ }, { word: 'X3DH', re: /\bX3DH\b/ },
  { word: 'Signal Protocol', re: /\bSignal Protocol\b/i }, { word: 'SQLCipher', re: /\bSQLCipher\b/i },
  { word: 'AES-256', re: /\bAES-\d{3}\b/ }, { word: 'MLS', re: /\bMLS\b/ },
];

/** Pull string literals ('…', "…", `…`) and JSX text nodes out of a TSX source. Approximate by design. */
export function extractCopy(source) {
  const out = [];
  for (const m of source.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3]);
  for (const m of source.matchAll(/>([^<>]*)</g)) {
    const text = m[1];
    // Remove {...} interpolations, split by them, and extract remaining text
    const parts = text.split(/{[^}]*}/);
    for (const part of parts) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function findForbidden(copy) {
  const hits = [];
  for (const text of copy) for (const f of FORBIDDEN) if (f.re.test(text)) hits.push({ word: f.word, text });
  return hits;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, acc); }
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

export function checkUiCopy(root) {
  const problems = [];
  for (const file of walk(join(root, 'packages', 'ui', 'src'))) {
    for (const hit of findForbidden(extractCopy(readFileSync(file, 'utf8')))) problems.push(`${file}: "${hit.word}" in "${hit.text}"`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkUiCopy(process.argv[2] ?? process.cwd());
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('ui copy: ok');
}
