import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ChoiceCards, type ChoiceCardsProps } from './ChoiceCards.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const OPTIONS: ChoiceCardsProps['options'] = [
  { id: 'app', title: 'Authenticator app', hint: 'Codes from an app on your phone' },
  { id: 'passkey', title: 'Passkey', hint: 'Use this device or a security key', disabled: true, reason: 'This browser has no passkey support' },
  { id: 'both', title: 'Both', hint: 'An app and a passkey' },
];
const LABEL = 'Second factor';

function renderCards(over: Partial<ChoiceCardsProps> = {}) {
  const props: ChoiceCardsProps = { name: 'factor', label: LABEL, options: OPTIONS, value: 'app', onChange: vi.fn(), ...over };
  return { props, ...render(<ChoiceCards {...props} />) };
}

describe('ChoiceCards', () => {
  it('is a radio group named by the label, with a native radio per card', () => {
    renderCards();
    expect(screen.getByRole('radiogroup', { name: LABEL })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.every(r => r.tagName === 'INPUT' && r.getAttribute('name') === 'factor')).toBe(true);
    expect(screen.getByRole('radio', { name: /Authenticator app/ })).toBeChecked();
  });

  it('has one tab stop: the chosen card, or the first enabled one when none is chosen', () => {
    const { rerender, props } = renderCards();
    const tabbable = () => screen.getAllByRole('radio').filter(r => (r as HTMLInputElement).tabIndex === 0).map(r => (r as HTMLInputElement).value);
    expect(tabbable()).toEqual(['app']);
    rerender(<ChoiceCards {...props} value="both" />);
    expect(tabbable()).toEqual(['both']);
    rerender(<ChoiceCards {...props} value="" />);
    expect(tabbable()).toEqual(['app']);
  });

  it('moves and selects with the arrows, skipping the disabled card and wrapping', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Controlled() {
      const [value, setValue] = useState('app');
      return <ChoiceCards name="factor" label={LABEL} options={OPTIONS} value={value} onChange={id => { onChange(id); setValue(id); }} />;
    }
    render(<Controlled />);
    screen.getByRole('radio', { name: /Authenticator app/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('both');
    expect(screen.getByRole('radio', { name: /Both/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('app');
    expect(screen.getByRole('radio', { name: /Authenticator app/ })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('both');
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('app');
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('both');
    expect(onChange).not.toHaveBeenCalledWith('passkey');
  });

  it('selects a card by click, and never a disabled one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderCards({ onChange });
    await user.click(screen.getByRole('radio', { name: /Both/ }));
    expect(onChange).toHaveBeenCalledWith('both');
    onChange.mockClear();
    await user.click(screen.getByRole('radio', { name: /Passkey/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lets Tab leave the group in one press', async () => {
    const user = userEvent.setup();
    render(<><button>before</button><ChoiceCards name="factor" label={LABEL} options={OPTIONS} value="app" onChange={() => {}} /><button>after</button></>);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('radio', { name: /Authenticator app/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('keeps the disabled card visible and describes it by its reason', () => {
    renderCards();
    const passkey = screen.getByRole('radio', { name: /Passkey/ });
    expect(passkey).toBeDisabled();
    expect(passkey).toHaveAccessibleDescription(/This browser has no passkey support/);
    expect(screen.getByText('This browser has no passkey support')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Both/ })).not.toHaveAccessibleDescription(/passkey support/);
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><ChoiceCards name="factor" label={LABEL} options={OPTIONS} value="app" onChange={() => {}} /></div>);
    await expectNoAxeViolations(container);
  });
});
