// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { en } from './strings/en.ts';

const SRC = dirname(fileURLToPath(import.meta.url));
// Props of @dilla/ui components (and of DOM elements) whose value a person sees or hears.
const VISIBLE_PROPS = new Set(['label', 'title', 'placeholder', 'aria-label', 'alt', 'status', 'detail', 'body',
  'stateLabel', 'emptyLabel', 'skipLabel', 'joinLabel', 'sendLabel', 'printLabel', 'acknowledgeLabel',
  'readableLabel', 'stepLabel', 'disabledReason', 'hint', 'error', 'author', 'name', 'topic', 'time',
  'closeLabel', 'ownLabel', 'tierLabel', 'lastSeen', 'settingsLabel']);
const LETTER = /[A-Za-z]/;

function stringOf(e: ts.Expression | undefined): string | null {
  if (!e) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return LETTER.test(e.text) ? e.text : null;
  return null;
}

/**
 * User-visible literals in a TSX source: JSX text, string children, string values of visible props, and
 * visible props of an object (or array of objects) written directly as a JSX attribute value, such as
 * `action={{ label: 'Go' }}`. Objects anywhere else (route objects, lookup tables of string keys) are code.
 */
export function literalCopy(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const objectProps = (o: ts.ObjectLiteralExpression): void => {
    for (const p of o.properties) {
      if (ts.isPropertyAssignment(p) && VISIBLE_PROPS.has(p.name.getText(sf))) {
        const s = stringOf(p.initializer);
        if (s !== null) out.push(s);
      }
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n) && n.text.trim() !== '') out.push(n.text.trim());
    if (ts.isJsxExpression(n) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      const s = stringOf(n.expression);
      if (s !== null) out.push(s);
    }
    if (ts.isJsxAttribute(n) && n.initializer) {
      const init = n.initializer;
      if (VISIBLE_PROPS.has(n.name.getText(sf))) {
        const s = ts.isStringLiteral(init) ? stringOf(init) : ts.isJsxExpression(init) ? stringOf(init.expression) : null;
        if (s !== null) out.push(s);
      }
      if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isObjectLiteralExpression(e)) objectProps(e);
        if (ts.isArrayLiteralExpression(e)) for (const el of e.elements) if (ts.isObjectLiteralExpression(el)) objectProps(el);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function sources(): string[] {
  const screens = join(SRC, 'screens');
  return [join(SRC, 'App.tsx'), join(SRC, 'main.tsx'),
    ...readdirSync(screens, { withFileTypes: true, recursive: true })
      .filter(e => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
      .map(e => join(e.parentPath, e.name))];
}

describe('copy lives in strings/en.ts', () => {
  it('finds literals of every kind it looks for', () => {
    const planted = '<><p>Hello</p><b>{"Hi there"}</b><Splash status="Starting" action={{ label: \'Go\', onAction }} /></>';
    expect(literalCopy('x.tsx', `const a = ${planted};`)).toEqual(['Hello', 'Hi there', 'Starting', 'Go']);
  });
  it('ignores class names, keys and t() calls', () => {
    const fine = '<div className="d-x" data-k="v"><p>{t(\'boot.loading.status\')}</p><Splash status={t(\'a.b\')} /></div>';
    expect(literalCopy('x.tsx', `const a = ${fine};`)).toEqual([]);
  });
  it('holds for the app and every screen', () => {
    for (const file of sources()) expect(literalCopy(file, readFileSync(file, 'utf8')), file).toEqual([]);
  });
});

// Card 53: every way a line can compare, search, switch on, test or case-fold a detail value, including a
// destructured alias compared with a non-empty literal; `typeof detail === 'string'` and `detail === ''` (the error
// constructors) are not switches.
const DETAIL_SWITCH: readonly RegExp[] = [
  /\.detail\s*(===|!==|==|!=)/,
  /\bdetail\??\.(startsWith|endsWith|includes|match|matchAll|indexOf|lastIndexOf|search|localeCompare|split)\(/,
  /\bdetail\??\.(toLowerCase|toUpperCase|toLocaleLowerCase|toLocaleUpperCase|trim|normalize)\(\)\s*(===|!==|==|!=)/,
  /switch\s*\(\s*[\w.?]*\bdetail\s*\)/,
  /\.test\(\s*[\w.?]*\bdetail\b/,
  /(?<!typeof\s+)\bdetail\s*(===|!==|==|!=)\s*(['"`])(?!\2)/,
];

/** Lines of a source that compare or search an error's detail text (protocol/02: a client MUST NOT parse it). */
export function detailSwitches(fileName: string, source: string): string[] {
  return source.split('\n').flatMap((line, i) => (DETAIL_SWITCH.some(p => p.test(line)) ? [`${fileName}:${i + 1}: ${line.trim()}`] : []));
}

function codeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map(e => join(e.parentPath, e.name));
}

describe('no code switches on a server detail', () => {
  it('finds every form it looks for, and leaves the error constructors alone', () => {
    const planted = [
      'if (e.detail === "username taken") x();',
      'e.detail.startsWith("username:")',
      'e.detail.includes("x")',
      'err.detail != ""',
      'e.detail.match(/x/)',
      'e.detail.endsWith("y")',
      'switch (e.detail) { default: }',
      'if (/taken/.test(err.detail)) y();',
      'const at = e.detail.indexOf("x");',
      'if (e.detail.search(/x/) >= 0) y();',
      'if (e.detail.toLowerCase() === "x") y();',
      'const { detail } = e; if (detail === "taken") y();',
      'const ok = e.code === "E_X" && e.status === 409;',
      'if (typeof detail === "string") z();',
      'super(detail === "" ? code : `${code}: ${detail}`);',
    ].join('\n');
    const found = detailSwitches('x.ts', planted);
    expect(found).toHaveLength(12);
    expect(found.at(-1)).toBe('x.ts:12: const { detail } = e; if (detail === "taken") y();');
  });
  it('holds for packages/web/src and packages/client-core/src', () => {
    const roots = [SRC, join(SRC, '..', '..', 'client-core', 'src')];
    const found = roots.flatMap(codeFiles).flatMap(file => detailSwitches(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });
});

const FLOWS = join(SRC, '..', '..', '..', 'docs', 'design', 'flows');
const FLOW_FILES = ['01-onboarding.md', '02-recovery-key.md', '03-sign-in.md', '04-conversation.md'] as const;
const COPY_HEADER = /^\|\s*key\s*\|\s*text\s*\|/;
const COPY_ROW = /^\|\s*`([^`]+)`\s*\|\s*`([^`]*)`\s*\|/;

/** The [key, text] rows of every table in a flow document whose header starts `| key | text |`. */
export function copyRows(source: string): { rows: [string, string][]; unparsed: string[] } {
  const rows: [string, string][] = [];
  const unparsed: string[] = [];
  let inTable = false;
  for (const line of source.split('\n')) {
    if (COPY_HEADER.test(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!line.startsWith('|')) { inTable = false; continue; }
    if (/^\|\s*-/.test(line)) continue;
    const m = COPY_ROW.exec(line);
    if (m === null) unparsed.push(line); else rows.push([m[1], m[2]]);
  }
  return { rows, unparsed };
}

describe('the flows quote en.ts', () => {
  it('reads every row of a copy table and nothing else', () => {
    const doc = [
      '| key | text | where |', '|---|---|---|', '| `a.b` | `One` | x |', '| `c.d` | `Two’s` |', '',
      '| check | where |', '|---|---|', '| `e.f` | `no` |', '',
      '| key | text |', '|---|---|', '| g.h | `x` |',
    ].join('\n');
    expect(copyRows(doc)).toEqual({ rows: [['a.b', 'One'], ['c.d', 'Two’s']], unparsed: ['| g.h | `x` |'] });
  });
  it.each(FLOW_FILES)('every Copy row of %s equals en.ts', file => {
    const table = en as Readonly<Record<string, string>>;
    const { rows, unparsed } = copyRows(readFileSync(join(FLOWS, file), 'utf8'));
    expect(unparsed, file).toEqual([]);
    expect(rows.length, file).toBeGreaterThan(0);
    const wrong = rows
      .filter(([key, text]) => table[key] !== text)
      .map(([key]) => `${file}: ${key}`);
    expect(wrong).toEqual([]);
  });
});
