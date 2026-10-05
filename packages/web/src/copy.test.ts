// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = dirname(fileURLToPath(import.meta.url));
// Props of @dilla/ui components (and of DOM elements) whose value a person sees or hears.
const VISIBLE_PROPS = new Set(['label', 'title', 'placeholder', 'aria-label', 'alt', 'status', 'detail', 'body',
  'stateLabel', 'emptyLabel', 'skipLabel', 'joinLabel', 'sendLabel', 'printLabel', 'acknowledgeLabel',
  'readableLabel', 'stepLabel', 'disabledReason', 'hint', 'error', 'author', 'name', 'topic', 'time']);
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
    ...readdirSync(screens).filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx')).map(f => join(screens, f))];
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
