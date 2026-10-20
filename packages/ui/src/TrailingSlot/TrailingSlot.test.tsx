import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TrailingSlot } from './TrailingSlot.tsx';

const cssText = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), './TrailingSlot.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('TrailingSlot (R13)', () => {
  it('renders one .d-slot span around its children', () => {
    const { container } = render(<TrailingSlot><b>3</b></TrailingSlot>);
    const slot = container.querySelector('span.d-slot');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('b')?.textContent).toBe('3');
  });
  it('an empty slot is still rendered, so the column is reserved', () => {
    const { container } = render(<TrailingSlot />);
    expect(container.querySelector('span.d-slot')).not.toBeNull();
  });
  it('keeps its width however empty: width var(--slot-w), flex none, centred', () => {
    expect(cssText()).toMatch(/\.d-slot \{[^}]*width: var\(--slot-w\); flex: none;/);
    expect(cssText()).toMatch(/\.d-slot \{[^}]*justify-content: center/);
  });
});
