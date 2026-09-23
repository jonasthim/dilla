import { render, screen } from '@testing-library/react';
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
