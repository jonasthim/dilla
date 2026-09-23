import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED = {
  'README.md': ['## Documents', '## Conformance'],
  '00-overview.md': ['## Terminology', '## Precedence', '## Conformance language'],
  '01-groups.md': ['## Group kinds', '## dilla_binding', '## External senders', '## Joining', '## Cadence'],
  '02-delivery-service.md': ['## Roles', '## API', '## Invariants', '## Errors', '## Retention'],
  '03-identity.md': ['## Keys', '## Credential', '## Device list', '## Custody by tier', '## Pairing', '## Recovery', '## Safety number'],
  '04-envelope-and-franking.md': ['## Envelope', '## Deterministic CBOR', '## Franking', '## Vectors'],
  '05-media-frames.md': ['## Frame format', '## Codec prefixes', '## Key schedule', '## Counter partition', '## Rotation'],
  '06-backup-archive.md': ['## Keys', '## Header', '## Archive', '## Restore'],
  '07-versioning.md': ['## Versions', '## Negotiation', '## Change process'],
  '08-threat-model.md': ['## Adversaries', '## Guarantees', '## Residual trust', '## Out of scope'],
};

const PLACEHOLDER = /\b(TBD|TODO|FIXME|XXX)\b|lorem ipsum|fill in later/i;

export function checkDocs(root) {
  const problems = [];
  for (const [name, headings] of Object.entries(REQUIRED)) {
    const path = join(root, 'protocol', name);
    if (!existsSync(path)) { problems.push(`${name}: missing`); continue; }
    const text = readFileSync(path, 'utf8');
    for (const h of headings) {
      if (!text.split('\n').some(line => line.trim() === h)) problems.push(`${name}: missing heading "${h}"`);
    }
    const bad = text.split('\n').findIndex(line => PLACEHOLDER.test(line));
    if (bad >= 0) problems.push(`${name}: placeholder on line ${bad + 1}`);
  }

  // Recursively walk protocol/ and check all files for placeholders
  const protocolDir = join(root, 'protocol');
  if (existsSync(protocolDir)) {
    const walkDir = (currentDir, prefix) => {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = prefix ? join(prefix, entry.name) : entry.name;
        if (entry.isFile()) {
          try {
            const text = readFileSync(fullPath, 'utf8');
            const bad = text.split('\n').findIndex(line => PLACEHOLDER.test(line));
            if (bad >= 0) problems.push(`${relPath}: placeholder on line ${bad + 1}`);
          } catch (e) {
            // Skip files that can't be read
          }
        } else if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        }
      }
    };
    walkDir(protocolDir, '');
  }

  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ?? process.cwd();
  const problems = checkDocs(root);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('protocol docs: ok');
}
