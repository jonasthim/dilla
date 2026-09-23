import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_HEADINGS = [
  '## Purpose', '## Audience and tone', '## Vocabulary', '## Design system source', '## Tokens', '## Layout',
  '## Removed from the chrome', '## Trust facts that stay visible', '## The readable-channel glyph',
  '## Brand mark', '## Sound', '## Motion', '## Themes', '## Accessibility model', '## Flows to wireframe', '## Attribution',
];

export const EXCLUSIONS = [
  'the shield badge in channel headers',
  'the SRTP badge in voice headers',
  'the composer footer line about encryption',
  'the e2e and db chunks in the bottom bar',
  'the pills on empty channels and DMs',
  'the lock in notification teasers',
  'the drop-overlay copy about encryption',
];

export function checkBrief(root) {
  const path = join(root, 'docs', 'design', 'brief.md');
  if (!existsSync(path)) return ['docs/design/brief.md: missing'];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').map(l => l.trim());
  const problems = [];
  for (const h of REQUIRED_HEADINGS) if (!lines.includes(h)) problems.push(`brief: missing heading "${h}"`);
  for (const e of EXCLUSIONS) if (!text.includes(e)) problems.push(`brief: exclusion list must contain "${e}"`);
  if (/\b(TBD|TODO|FIXME)\b/.test(text)) problems.push('brief: placeholder found');
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkBrief(process.argv[2] ?? process.cwd());
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('design brief: ok');
}
