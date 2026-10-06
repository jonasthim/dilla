import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Toggle, type ToggleProps } from './Toggle.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: notify.mute names a channel's mute switch; notify.permission.label and notify.body are
// the label and hint texts of a Settings → Notifications row.
const HINT = 'Desktop notifications show while a dilla tab is open. Nothing is shown when every tab is closed.';

function Controlled(p: Omit<ToggleProps, 'checked' | 'onChange'> & { initial?: boolean; onValue?: (v: boolean) => void }) {
  const { initial = false, onValue, ...rest } = p;
  const [checked, setChecked] = useState(initial);
  return <Toggle {...rest} checked={checked} onChange={v => { setChecked(v); onValue?.(v); }} />;
}

describe('Toggle', () => {
  it('is a button with the switch role, named by its label, its state in aria-checked', () => {
    const { container } = render(<Toggle id="mute-general" label="mute" checked={false} onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'mute' });
    expect(sw.tagName).toBe('BUTTON');
    expect(sw).toHaveAttribute('type', 'button');
    expect(sw).toHaveAttribute('id', 'mute-general');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAttribute('aria-label', 'mute');
    expect(sw).not.toHaveAttribute('aria-labelledby');
    expect(container.firstElementChild).toHaveClass('d-toggle');
    expect(container.querySelector('.d-toggle__label')).toBeNull();
  });

  it('with showLabel draws the label before the switch and is named by that visible text', () => {
    const { container } = render(<Toggle id="mute-general" label="mute" checked={false} onChange={() => {}} showLabel hint={HINT} />);
    const sw = screen.getByRole('switch', { name: 'mute' });
    const text = container.querySelector('.d-toggle__label');
    expect(text).not.toBeNull();
    expect(text).toHaveTextContent('mute');
    expect(text).toHaveAttribute('id', 'mute-general-label');
    expect(text?.tagName).toBe('SPAN');
    expect(sw).toHaveAttribute('aria-labelledby', 'mute-general-label');
    expect(sw).not.toHaveAttribute('aria-label');
    expect(text!.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sw).toHaveAccessibleDescription(HINT);
  });

  it('toggles on click, Space and Enter and reports each new state', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Controlled id="mute-general" label="mute" onValue={onValue} />);
    const sw = screen.getByRole('switch', { name: 'mute' });
    await user.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveFocus();
    await user.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    await user.keyboard('{Enter}');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(onValue.mock.calls.map(c => c[0])).toEqual([true, false, true]);
  });

  it('is described by its hint', () => {
    render(<Toggle id="notify-permission" label="desktop notifications" checked onChange={() => {}} hint={HINT} />);
    const sw = screen.getByRole('switch', { name: 'desktop notifications' });
    expect(sw).toHaveAccessibleDescription(HINT);
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(HINT)).toHaveAttribute('id', 'notify-permission-hint');
  });

  it('stays focusable when disabled and ignores activation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle id="mute-general" label="mute" checked onChange={onChange} disabled />);
    const sw = screen.getByRole('switch', { name: 'mute' });
    expect(sw).toHaveAttribute('aria-disabled', 'true');
    expect(sw).not.toHaveAttribute('disabled');
    await user.tab();
    expect(sw).toHaveFocus();
    await user.keyboard(' ');
    await user.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('has no serious axe violations in either state and with its label shown', async () => {
    const { container } = render(
      <div className="d-root">
        <Toggle id="a" label="mute" checked={false} onChange={() => {}} />
        <Toggle id="b" label="desktop notifications" checked onChange={() => {}} hint={HINT} />
        <Toggle id="c" label="mute" checked onChange={() => {}} showLabel />
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
