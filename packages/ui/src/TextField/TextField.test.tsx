import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TextField, type TextFieldProps } from './TextField.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-01: onboarding.identity.usernameHint and onboarding.error.usernameTaken.
const HINT = '3 to 32 characters: a–z, 0–9, dot, underscore or hyphen.';
const TAKEN = 'That username is taken. Try another.';

function Controlled(props: Omit<TextFieldProps, 'value' | 'onChange'> & { onValue?: (v: string) => void }) {
  const { onValue, ...rest } = props;
  const [value, setValue] = useState('');
  return <TextField {...rest} value={value} onChange={v => { setValue(v); onValue?.(v); }} />;
}

describe('TextField', () => {
  it('labels the input with its visible label and carries the d-text-field root class', () => {
    const { container } = render(<TextField id="username" label="Username" value="" onChange={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Username' });
    expect(input).toHaveAttribute('id', 'username');
    expect(screen.getByText('Username', { selector: 'label' })).toHaveAttribute('for', 'username');
    expect(container.firstElementChild).toHaveClass('d-text-field');
  });

  it('reports every keystroke through onChange', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled id="username" label="Username" onValue={onValue} />);
    await user.type(screen.getByRole('textbox', { name: 'Username' }), 'ada');
    expect(onValue.mock.calls.map(c => c[0])).toEqual(['a', 'ad', 'ada']);
    expect(screen.getByRole('textbox', { name: 'Username' })).toHaveValue('ada');
  });

  it('binds the hint and the error as the description, marks the field invalid and announces the error', () => {
    render(<TextField id="username" label="Username" value="ada" onChange={() => {}} hint={HINT} error={TAKEN} />);
    const input = screen.getByRole('textbox', { name: 'Username' });
    expect(input).toHaveAccessibleDescription(`${HINT} ${TAKEN}`);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(TAKEN);
  });

  it('describes the field with the hint alone when there is no error', () => {
    render(<TextField id="username" label="Username" value="" onChange={() => {}} hint={HINT} />);
    const input = screen.getByRole('textbox', { name: 'Username' });
    expect(input).toHaveAccessibleDescription(HINT);
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('has no description and is not invalid without a hint or an error', () => {
    render(<TextField id="username" label="Username" value="" onChange={() => {}} />);
    const input = screen.getByRole('textbox', { name: 'Username' });
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('passes the input attributes through', () => {
    render(<TextField id="password" label="Password" value="" onChange={() => {}} type="password"
      autoComplete="new-password" required maxLength={64} spellCheck={false} inputMode="text" />);
    const input = screen.getByLabelText('Password');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('maxlength', '64');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('inputmode', 'text');
  });

  it('lets paste through: nothing cancels it', () => {
    render(<TextField id="invite" label="Invite" value="" onChange={() => {}} />);
    expect(fireEvent.paste(screen.getByRole('textbox', { name: 'Invite' }))).toBe(true);
  });

  it('disables the input', () => {
    render(<TextField id="invite" label="Invite" value="k7qm" onChange={() => {}} disabled />);
    expect(screen.getByRole('textbox', { name: 'Invite' })).toBeDisabled();
  });

  it('has no serious axe violations with a hint and an error', async () => {
    const { container } = render(<div className="d-root"><TextField id="username" label="Username" value="ada" onChange={() => {}} hint={HINT} error={TAKEN} /></div>);
    await expectNoAxeViolations(container);
  });
});
