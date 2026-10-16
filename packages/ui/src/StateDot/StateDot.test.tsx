import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StateDot, type StateDotTone } from './StateDot.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const TONES: StateDotTone[] = ['ok', 'off', 'pending', 'idle', 'dnd', 'warn', 'danger'];

describe('StateDot', () => {
  it.each(TONES)('%s renders its data-tone, hidden from assistive tech, with no text', tone => {
    const { container } = render(<StateDot tone={tone} />);
    const dot = container.querySelector('.d-state-dot');
    expect(dot).toHaveAttribute('data-tone', tone);
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot).toHaveAttribute('data-size', 'sm');
    expect(dot?.textContent).toBe('');
  });
  it('takes a md size', () => {
    const { container } = render(<StateDot tone="ok" size="md" />);
    expect(container.querySelector('.d-state-dot')).toHaveAttribute('data-size', 'md');
  });
  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root">{TONES.map(t => <StateDot key={t} tone={t} />)}</div>);
    await expectNoAxeViolations(container);
  });
});
