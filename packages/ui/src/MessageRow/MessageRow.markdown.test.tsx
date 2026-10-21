import { act, render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MessageRow, type BodyPart } from './MessageRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const row = (body: readonly BodyPart[], extra: { active?: boolean } = {}) =>
  render(<MessageRow author="ada" time="21:02" state="ok" body={body} {...extra} />);
const text = (t: string): BodyPart => ({ kind: 'text', text: t });

describe('MessageRow markdown parts', () => {
  it('renders strong, em, strike and code as elements, nested', () => {
    const { container } = row([
      { kind: 'strong', children: [text('a '), { kind: 'em', children: [text('b')] }] },
      text(' '), { kind: 'strike', children: [text('c')] }, text(' '), { kind: 'code', text: 'd<b>' },
    ]);
    const body = container.querySelector('.d-message-row__body') as HTMLElement;
    expect(body.querySelector('strong')?.innerHTML).toBe('a <em>b</em>');
    expect(body.querySelector('s')?.textContent).toBe('c');
    expect(body.querySelector('code')?.textContent).toBe('d<b>');
    expect(body.querySelector('b')).toBeNull();
  });

  it('renders a code block as pre > code and a quote as a blockquote, both outside any paragraph', () => {
    const { container } = row([
      { kind: 'quote', children: [text('said '), { kind: 'strong', children: [text('it')] }] },
      { kind: 'codeblock', text: 'let a = "<script>";' },
    ]);
    const body = container.querySelector('.d-message-row__body') as HTMLElement;
    expect(body.querySelector('blockquote')?.textContent).toBe('said it');
    expect(body.querySelector('pre > code')?.textContent).toBe('let a = "<script>";');
    expect(body.querySelector('script')).toBeNull();
    expect(body.closest('p')).toBeNull();
  });

  it('renders mentions inside formatting as pills', () => {
    const { container } = row([{ kind: 'strong', children: [text('hi '), { kind: 'mention', label: '@ada', me: true, broadcast: false }] }]);
    expect(container.querySelector('strong .d-mention')?.textContent).toBe('@ada');
  });

  it('renders a link as its own text with the hardened attributes', () => {
    row([{ kind: 'link', href: 'https://example.com/a', text: 'https://example.com/a' }]);
    const a = screen.getByRole('link', { name: 'https://example.com/a' });
    expect(a).toHaveAttribute('href', 'https://example.com/a');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(a).toHaveClass('d-link');
  });

  it('defends itself: a link part with any other scheme renders as plain text, never an anchor', () => {
    const { container } = row([
      { kind: 'link', href: 'javascript:alert(1)', text: 'javascript:alert(1)' },
      { kind: 'link', href: 'data:text/html,x', text: 'data' },
      { kind: 'link', href: ' https://example.com', text: 'padded' },
      { kind: 'link', href: 'HTTPS://example.com/', text: 'upper' },
    ]);
    expect(container.querySelector('a[href^="javascript"], a[href^="data"]')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(1);
    expect(container.querySelector('.d-message-row__body')?.textContent).toBe('javascript:alert(1)datapaddedupper');
  });

  it('puts a link on the roving tab stop like the pills: not a stop unless the row is active', () => {
    const { rerender } = row([{ kind: 'link', href: 'https://example.com/', text: 'https://example.com/' }]);
    expect(screen.getByRole('link').tabIndex).toBe(-1);
    rerender(<MessageRow author="ada" time="21:02" state="ok" active body={[{ kind: 'link', href: 'https://example.com/', text: 'https://example.com/' }]} />);
    // Not a stop until focus is inside the row (same rule as the author name and pills).
    expect(screen.getByRole('link').tabIndex).toBe(-1);
    act(() => { screen.getByRole('article').focus(); });
    expect(screen.getByRole('link').tabIndex).toBe(0);
  });

  it('has no serious axe violations with every kind', async () => {
    const { container } = row([
      { kind: 'strong', children: [text('s')] }, text(' '), { kind: 'em', children: [text('e')] }, text(' '), { kind: 'strike', children: [text('x')] },
      text(' '), { kind: 'code', text: 'c' }, text(' '), { kind: 'link', href: 'https://example.com/', text: 'https://example.com/' },
      { kind: 'quote', children: [text('q')] }, { kind: 'codeblock', text: 'b' },
    ]);
    await expectNoAxeViolations(container);
  });
});
