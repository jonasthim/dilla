import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectProps } from './Select.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const options = [{ value: 'a', label: 'alpha' }, { value: 'b', label: 'beta' }];
function props(over: Partial<SelectProps> = {}): SelectProps {
  return { label: 'Category', value: 'a', options, onChange: vi.fn(), ...over };
}

afterEach(() => { delete document.documentElement.dataset.theme; });

describe('Select', () => {
  it('is a labelled native select with its options and the hint as its description', () => {
    render(<Select {...props({ hint: 'Pick one.' })} />);
    const select = screen.getByRole('combobox', { name: 'Category' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('a');
    expect(select).toHaveAccessibleDescription('Pick one.');
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['alpha', 'beta']);
  });

  it('reports the chosen value', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<Select {...p} />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'beta');
    expect(p.onChange).toHaveBeenCalledExactlyOnceWith('b');
  });

  it('can be disabled', () => {
    render(<Select {...props({ disabled: true })} />);
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeDisabled();
  });

  it.each(['mesh', 'light', 'high-contrast'])('has no serious axe violations in %s', async theme => {
    document.documentElement.dataset.theme = theme;
    const { container } = render(<div className="d-root"><Select {...props({ hint: 'Pick one.' })} /></div>);
    await expectNoAxeViolations(container);
  });
});
