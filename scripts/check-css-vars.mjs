import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// R16 (web3.9): a `var(--name)` with no fallback whose name nothing declares paints nothing, silently (web3.8 shipped
// `var(--space-6)` and `var(--focus)` this way). This lists every such use as `file:line var(--name)`.
//
// Declared: a `--name:` in the generated tokens, in any .css under the roots below, or a custom property set from script,
// written as a quoted '--name' in a .ts/.tsx under them (not a *.test.* or *.stories.* file, which never ships) (the Avatar's `--avatar-hue`, the shell's `--d-sidebar-w`).
// Used: `var(--name)` or `var(--name )`. A `var(--name, fallback)` is allowed: the properties the web app sets from JS
// (`--d-sidebar-w`, `--d-vvh`) always carry one. Comments are not read.
export const TOKENS = 'packages/design-tokens/dist/tokens.css';
export const ROOTS = ['packages/ui/src', 'packages/web/src'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The text with every comment's characters blanked, newlines kept, so a line number still counts. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '));
}

export function checkCssVars(root) {
  const cssFiles = [];
  const scriptFiles = [];
  const tokens = join(root, ...TOKENS.split('/'));
  if (existsSync(tokens)) cssFiles.push(tokens);
  for (const r of ROOTS) {
    const dir = join(root, ...r.split('/'));
    if (!existsSync(dir)) continue;
    for (const f of walk(dir)) {
      if (f.endsWith('.css')) cssFiles.push(f);
      else if (/\.tsx?$/.test(f) && !/\.(test|stories)\./.test(f)) scriptFiles.push(f);
    }
  }
  const declared = new Set();
  const texts = cssFiles.map(f => ({ file: f, text: blankComments(readFileSync(f, 'utf8')) }));
  for (const { text } of texts) for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
  for (const f of scriptFiles) for (const m of readFileSync(f, 'utf8').matchAll(/['"`](--[\w-]+)['"`]/g)) declared.add(m[1]);
  const problems = [];
  for (const { file, text } of texts) {
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      if (declared.has(m[1])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${relative(root, file).split(sep).join('/')}:${line} var(${m[1]})`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkCssVars(process.argv[2] ?? process.cwd());
  if (problems.length) { console.error(`undefined custom properties (no declaration, no fallback):\n${problems.join('\n')}`); process.exit(1); }
  console.log('css vars: ok');
}
