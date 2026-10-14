import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ColorSwatches } from './ColorSwatches.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const OPTIONS = [
  { value: 0xe74c3c, name: 'red' }, { value: 0x3498db, name: 'blue' }, { value: 0x2ecc71, name: 'green' },
] as const;

function Controlled({ initial = 0, onValue, hint }: { initial?: number; onValue?: (v: number) => void; hint?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button">before</button>
      <ColorSwatches label="colour" hint={hint} value={value} options={OPTIONS} noneLabel="no colour"
        onChange={v => { setValue(v); onValue?.(v); }} />
      <button type="button">after</button>
    </>
  );
}
const swatch = (name: string) => screen.getByRole('radio', { name });

describe('ColorSwatches', () => {
  it('is a radiogroup named by its label, with the none option first and each swatch named by its colour', () => {
    render(<Controlled />);
    expect(screen.getByRole('radiogroup', { name: 'colour' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio').map(r => r.getAttribute('aria-label'))).toEqual(['no colour', 'red', 'blue', 'green']);
  });

  it('is described by its hint', () => {
    render(<Controlled hint="Shown beside the name." />);
    expect(screen.getByRole('radiogroup', { name: 'colour' })).toHaveAccessibleDescription('Shown beside the name.');
  });

  it('draws each colour from data through --d-swatch as #rrggbb', () => {
    render(<Controlled />);
    expect(swatch('red').style.getPropertyValue('--d-swatch')).toBe('#e74c3c');
    expect(swatch('green').style.getPropertyValue('--d-swatch')).toBe('#2ecc71');
    expect(swatch('no colour').style.getPropertyValue('--d-swatch')).toBe('');
  });

  it('checks the selected swatch and shows a visible check mark on it only', () => {
    const { container } = render(<Controlled initial={0x3498db} />);
    expect(swatch('blue')).toHaveAttribute('aria-checked', 'true');
    expect(swatch('red')).toHaveAttribute('aria-checked', 'false');
    const checks = container.querySelectorAll('.d-color-swatches__check');
    expect(checks).toHaveLength(1);
    expect(swatch('blue').contains(checks[0])).toBe(true);
    expect(checks[0]).toHaveAttribute('aria-hidden', 'true');
    expect(checks[0].textContent).toBe('✓');
  });

  it('selects none for value 0 and reports 0 when none is chosen', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled initial={0xe74c3c} onValue={onValue} />);
    await user.click(swatch('no colour'));
    expect(swatch('no colour')).toHaveAttribute('aria-checked', 'true');
    expect(onValue).toHaveBeenLastCalledWith(0);
    await user.click(swatch('green'));
    expect(onValue).toHaveBeenLastCalledWith(0x2ecc71);
  });

  it('has one tab stop, on the checked swatch', () => {
    render(<Controlled initial={0x3498db} />);
    expect(screen.getAllByRole('radio').map(r => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);
  });

  it('the arrows move and select, wrapping through none', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled onValue={onValue} />);
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(swatch('no colour')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(swatch('red')).toHaveFocus();
    expect(swatch('red')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(swatch('green')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(swatch('no colour')).toHaveFocus();
    expect(onValue.mock.calls.map(c => c[0])).toEqual([0xe74c3c, 0, 0x2ecc71, 0]);
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><Controlled initial={0x2ecc71} hint="Shown beside the name." /></div>);
    await expectNoAxeViolations(container);
  });
});
