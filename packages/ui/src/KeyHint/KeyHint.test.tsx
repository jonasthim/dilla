import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { KeyHint } from './KeyHint.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

describe('KeyHint', () => {
  it('renders each key as kbd and the label as text', () => {
    render(<KeyHint keys={['⌘', 'K']} label="cmd" />);
    expect(screen.queryAllByRole('presentation')).toHaveLength(0);
    expect(screen.getByText('⌘').tagName).toBe('KBD');
    expect(screen.getByText('K').tagName).toBe('KBD');
    expect(screen.getByText('cmd')).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><KeyHint keys={['/']} label="search" /></div>);
    await expectNoAxeViolations(container);
  });
});
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('KeyHint chip (UI-1)', () => {
  it('is a mono 11px chip on --surface-hi with a hairline and no radius', () => {
    const rule = read('./KeyHint.css').match(/\.d-keyhint__kbd \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('font-family: var(--font-mono)');
    expect(rule).toContain('font-size: 0.6875rem');
    expect(rule).toContain('background: var(--surface-hi)');
    expect(rule).toContain('border: 1px solid var(--hairline)');
    expect(rule).toContain('border-radius: 0');
  });
});
