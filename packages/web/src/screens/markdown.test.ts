import { describe, expect, it } from 'vitest';
import type { BodyPart } from '@dilla/ui';
import { parseMarkdown, safeLink } from './markdown.ts';

const ID = 'a'.repeat(32);
const resolve = (target: string): BodyPart => ({ kind: 'mention', label: `@${target.slice(0, 3)}`, me: false, broadcast: false });
const parse = (s: string): BodyPart[] => parseMarkdown(s, resolve);
const text = (t: string): BodyPart => ({ kind: 'text', text: t });

/** Everything a reader sees, flat: text, code, link text and pill labels. */
function visible(parts: readonly BodyPart[]): string {
  return parts.map(p => {
    switch (p.kind) {
      case 'text': case 'code': case 'codeblock': case 'link': return p.text;
      case 'mention': return p.label;
      default: return visible(p.children);
    }
  }).join('');
}

describe('parseMarkdown', () => {
  it.each<[string, string, BodyPart[]]>([
    ['plain text is one text part', 'hello there', [text('hello there')]],
    ['strong', '**bold**', [{ kind: 'strong', children: [text('bold')] }]],
    ['em with stars', '*it*', [{ kind: 'em', children: [text('it')] }]],
    ['em with underscores', '_it_', [{ kind: 'em', children: [text('it')] }]],
    ['strike', '~~gone~~', [{ kind: 'strike', children: [text('gone')] }]],
    ['code span', 'a `b *c*` d', [text('a '), { kind: 'code', text: 'b *c*' }, text(' d')]],
    ['double-tick code span holds a tick', '``a`b``', [{ kind: 'code', text: 'a`b' }]],
    ['nesting', '**a *b* c**', [{ kind: 'strong', children: [text('a '), { kind: 'em', children: [text('b')] }, text(' c')] }]],
    ['strong and em together', '***x***', [{ kind: 'strong', children: [{ kind: 'em', children: [text('x')] }] }]],
    ['strike inside strong', '**~~x~~**', [{ kind: 'strong', children: [{ kind: 'strike', children: [text('x')] }] }]],
    ['unclosed strong stays literal', '**open', [text('**open')]],
    ['unclosed em stays literal', 'a *b', [text('a *b')]],
    ['unclosed code stays literal', 'a `b', [text('a `b')]],
    ['a lone star between spaces is text', '2 * 3 * 4', [text('2 * 3 * 4')]],
    ['snake_case is not emphasis', 'snake_case_name', [text('snake_case_name')]],
    ['empty emphasis is text', '****', [text('****')]],
    ['a backslash escapes a marker', '\\*not\\*', [text('*not*')]],
    ['a backslash escapes a backslash', '\\\\*x*', [text('\\'), { kind: 'em', children: [text('x')] }]],
    ['a backslash before a letter stays', 'C:\\dir', [text('C:\\dir')]],
    ['a trailing backslash stays', 'end\\', [text('end\\')]],
    ['fenced block', '```\nline *1*\nline 2\n```', [{ kind: 'codeblock', text: 'line *1*\nline 2' }]],
    ['fenced block with a language tag', '```ts\nlet a;\n```', [{ kind: 'codeblock', text: 'let a;' }]],
    ['an unclosed fence is text', '```\nopen', [text('```\nopen')]],
    ['text around a fence', 'before\n```\nx\n```\nafter', [text('before'), { kind: 'codeblock', text: 'x' }, text('after')]],
    ['quote', '> hi *you*', [{ kind: 'quote', children: [text('hi '), { kind: 'em', children: [text('you')] }] }]],
    ['quote of two lines', '> a\n> b', [{ kind: 'quote', children: [text('a\nb')] }]],
    ['quote then text', '> a\nb', [{ kind: 'quote', children: [text('a')] }, text('b')]],
    ['a > mid-line is text', 'a > b', [text('a > b')]],
    ['markdown link syntax is not a link, the url inside is', '[click](https://evil.example)', [text('[click]('), { kind: 'link', href: 'https://evil.example/', text: 'https://evil.example' }, text(')')]],
    ['raw html stays text', '<b>x</b><img src=x onerror=alert(1)>', [text('<b>x</b><img src=x onerror=alert(1)>')]],
  ])('%s', (_name, input, expected) => {
    expect(parse(input)).toEqual(expected);
  });

  describe('links', () => {
    it('links a bare https url as its own text', () => {
      expect(parse('see https://example.com/a?b=1#c now')).toEqual([
        text('see '), { kind: 'link', href: 'https://example.com/a?b=1#c', text: 'https://example.com/a?b=1#c' }, text(' now'),
      ]);
    });
    it('links http and mailto', () => {
      expect(parse('http://example.com')).toEqual([{ kind: 'link', href: 'http://example.com/', text: 'http://example.com' }]);
      expect(parse('mailto:a@example.com')).toEqual([{ kind: 'link', href: 'mailto:a@example.com', text: 'mailto:a@example.com' }]);
    });
    it('leaves trailing punctuation out of the link', () => {
      expect(parse('(https://example.com/x).')).toEqual([text('('), { kind: 'link', href: 'https://example.com/x', text: 'https://example.com/x' }, text(').')]);
      expect(parse('https://example.com/a_(b)')).toEqual([{ kind: 'link', href: 'https://example.com/a_(b)', text: 'https://example.com/a_(b)' }]);
    });
    it('links inside formatting', () => {
      expect(parse('**https://example.com**')).toEqual([{ kind: 'strong', children: [{ kind: 'link', href: 'https://example.com/', text: 'https://example.com' }] }]);
    });
    it.each([
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd',
      'blob:https://example.com/x', 'ftp://example.com', 'tel:+4631', '//example.com', 'https://user:pw@example.com', 'https://user@example.com',
      'https://', 'https:///x', 'http://exa\u202Emple.com', 'https://example.com/\u200bx', 'mailto:',
    ])('refuses %s', input => {
      expect(safeLink(input)).toBeNull();
      expect(parse(input).some(p => p.kind === 'link')).toBe(false);
      expect(visible(parse(input))).toBe(input);
    });
    it('does not link a url glued to a word', () => {
      expect(parse('xhttps://example.com').some(p => p.kind === 'link')).toBe(false);
    });
    it('does not link or format inside code', () => {
      expect(parse('`https://example.com`')).toEqual([{ kind: 'code', text: 'https://example.com' }]);
      expect(parse('```\nhttps://example.com\n```')).toEqual([{ kind: 'codeblock', text: 'https://example.com' }]);
    });
    it('only ever hands out http, https or mailto hrefs', () => {
      for (const p of parse('javascript:alert(1) https://a.example mailto:x@y.example data:x')) {
        if (p.kind === 'link') expect(/^(https?:|mailto:)/.test(p.href)).toBe(true);
      }
    });
  });

  describe('mentions', () => {
    it('keeps a mention a pill', () => {
      expect(parse(`hi <@${ID}>`)).toEqual([text('hi '), resolve(ID)]);
    });
    it('keeps a mention inside formatting', () => {
      expect(parse(`**hi <@${ID}>**`)).toEqual([{ kind: 'strong', children: [text('hi '), resolve(ID)] }]);
      expect(parse(`> <@everyone> *x*`)).toEqual([{ kind: 'quote', children: [resolve('everyone'), text(' '), { kind: 'em', children: [text('x')] }] }]);
    });
    it('formatting can span a mention', () => {
      expect(parse(`*a <@${ID}> b*`)).toEqual([{ kind: 'em', children: [text('a '), resolve(ID), text(' b')] }]);
    });
    it('does not parse a mention in a code span or block', () => {
      expect(parse(`\`<@${ID}>\``)).toEqual([{ kind: 'code', text: `<@${ID}>` }]);
      expect(parse(`\`\`\`\n<@${ID}>\n\`\`\``)).toEqual([{ kind: 'codeblock', text: `<@${ID}>` }]);
    });
    it('a mention is not a word, so it cannot glue a url', () => {
      expect(parse(`<@${ID}>https://example.com`).filter(p => p.kind === 'link')).toHaveLength(1);
    });
  });

  it('survives deep nesting and long runs of markers', () => {
    expect(() => parse('*'.repeat(5000))).not.toThrow();
    expect(() => parse('*a '.repeat(2000))).not.toThrow();
    expect(() => parse('**a '.repeat(1000) + '**'.repeat(1000))).not.toThrow();
    expect(() => parse('`'.repeat(3000) + '~'.repeat(3000) + '>'.repeat(3000))).not.toThrow();
  });

  // The parser only removes markers: what a reader sees is the input with some of `\ * _ ~ ` > `, line breaks, and a
  // fence's lines taken out, in the same order, whatever the input is.
  it('fuzz: the visible text is always the input minus markers', () => {
    const alphabet = ['a', 'b', ' ', '*', '_', '~', '`', '\\', '>', '\n', ':', '/', '.', 'h', 't', 'p', 's', '@', `<@${ID}>`, '<', 'mailto:x@y.z', 'https://a.b', '[', ']', '(', ')'];
    let seed = 7;
    const rand = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const MARKERS = new Set([...'\\*_~`>\n ']);
    for (let run = 0; run < 3000; run++) {
      const input = Array.from({ length: rand(40) }, () => alphabet[rand(alphabet.length)]).join('');
      const parts = parseMarkdown(input, t => ({ kind: 'mention', label: `<@${t}>`, me: false, broadcast: false }));
      const seen = visible(parts);
      // Subsequence of the input, and every dropped character is a marker.
      let at = 0;
      for (const ch of seen) {
        const found = input.indexOf(ch, at);
        expect(found, `${JSON.stringify(input)} -> ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0);
        for (const dropped of input.slice(at, found)) expect(MARKERS.has(dropped) || dropped === '`', JSON.stringify(input)).toBe(true);
        at = found + ch.length;
      }
      for (const dropped of input.slice(at)) expect(MARKERS.has(dropped) || dropped === '`', JSON.stringify(input)).toBe(true);
      // Never a link that is not http, https or mailto.
      const walk = (ps: readonly BodyPart[]): void => ps.forEach(p => {
        if (p.kind === 'link') expect(safeLink(p.href)).toBe(p.href);
        if ('children' in p) walk(p.children);
      });
      walk(parts);
    }
  });

  it('fuzz: text without any marker comes back as exactly itself', () => {
    for (const input of ['', 'plain', 'a b  c', 'emoji 🎉 ok', 'tabs\tand\nlines', 'a.b/c:d@e <not a mention>']) {
      expect(visible(parse(input))).toBe(input);
    }
  });
});
