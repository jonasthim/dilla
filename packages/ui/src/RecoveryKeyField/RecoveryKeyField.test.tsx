import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RecoveryKeyField, type RecoveryKeyFieldProps } from './RecoveryKeyField.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: signin.key.label, signin.key.hint, signin.error.wrongKey. The key is flow 02's sample key,
// never a real one, pasted as a person might: lower case, hyphenated, 64 characters.
const GROUPED = '7k3m-qw9d-x2rt-0pna-hv5c-j8ze-m4tb-s6yf-1gkd-r3wp-zn7h-c9qx-5tva';
const WRONG = 'This is not the recovery key of this account. Check every character.';

function Controlled(p: Omit<RecoveryKeyFieldProps, 'value' | 'onChange'> & { onValue?: (v: string) => void }) {
  const { onValue, ...rest } = p;
  const [value, setValue] = useState('');
  return <RecoveryKeyField {...rest} value={value} onChange={v => { setValue(v); onValue?.(v); }} />;
}

describe('RecoveryKeyField', () => {
  it('is a text input named by its label, with no autocomplete, no spellcheck, no name and no length limit', () => {
    const { container } = render(<RecoveryKeyField id="recovery-key" label="Recovery key" value="" onChange={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Recovery key' });
    expect(container.firstElementChild).toHaveClass('d-recovery-key-field');
    expect(input).toHaveClass('d-recovery-key-field__input');
    expect(input).toHaveAttribute('id', 'recovery-key');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('autocapitalize', 'characters');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('inputmode', 'text');
    expect(input).not.toHaveAttribute('maxlength');
    expect(input).not.toHaveAttribute('name');
  });

  it('reports the raw text on every change and shows it as typed', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled id="recovery-key" label="Recovery key" onValue={onValue} />);
    await user.type(screen.getByRole('textbox', { name: 'Recovery key' }), 'ab-c');
    expect(onValue.mock.calls.map(c => c[0])).toEqual(['a', 'ab', 'ab-', 'ab-c']);
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toHaveValue('ab-c');
  });

  it('takes a pasted grouped key whole: paste is never cancelled and nothing is cut off', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled id="recovery-key" label="Recovery key" onValue={onValue} />);
    const input = screen.getByRole('textbox', { name: 'Recovery key' });
    expect(fireEvent.paste(input)).toBe(true);
    await user.click(input);
    await user.paste(GROUPED);
    expect(input).toHaveValue(GROUPED);
    expect(onValue).toHaveBeenLastCalledWith(GROUPED);
  });

  it('binds the hint and the error as the description, marks the field invalid and announces the error', () => {
    render(<RecoveryKeyField id="recovery-key" label="Recovery key" value={GROUPED} onChange={() => {}} hint="52 of 52 characters" error={WRONG} />);
    const input = screen.getByRole('textbox', { name: 'Recovery key' });
    expect(input).toHaveAccessibleDescription(`52 of 52 characters ${WRONG}`);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(WRONG);
  });

  it('is described by the hint alone without an error, and by nothing without either', () => {
    const { rerender } = render(<RecoveryKeyField id="recovery-key" label="Recovery key" value="7K3M" onChange={() => {}} hint="4 of 52 characters" />);
    const input = screen.getByRole('textbox', { name: 'Recovery key' });
    expect(input).toHaveAccessibleDescription('4 of 52 characters');
    expect(input).not.toHaveAttribute('aria-invalid');
    rerender(<RecoveryKeyField id="recovery-key" label="Recovery key" value="7K3M" onChange={() => {}} />);
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('disables the input', () => {
    render(<RecoveryKeyField id="recovery-key" label="Recovery key" value={GROUPED} onChange={() => {}} disabled />);
    expect(screen.getByRole('textbox', { name: 'Recovery key' })).toBeDisabled();
  });

  it('has no serious axe violations with a hint and an error', async () => {
    const { container } = render(
      <div className="d-root"><RecoveryKeyField id="recovery-key" label="Recovery key" value={GROUPED} onChange={() => {}} hint="52 of 52 characters" error={WRONG} /></div>,
    );
    await expectNoAxeViolations(container);
  });
});
