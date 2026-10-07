import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SettingsRow } from './SettingsRow.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: notify.permission.label, notify.body, notify.permission.ask, notify.default.*.
const BODY = 'Desktop notifications show while a dilla tab is open. Nothing is shown when every tab is closed.';
const DEFAULTS = [
  { value: 'dms-mentions', label: 'direct messages and mentions' }, { value: 'everything', label: 'every message' }, { value: 'nothing', label: 'nothing' },
] as const;

describe('SettingsRow', () => {
  it('is a group named by its visible label, described by its hint, holding its control', () => {
    const { container } = render(
      <SettingsRow id="notify-permission" label="desktop notifications" hint={BODY}><button type="button">turn on</button></SettingsRow>,
    );
    const group = screen.getByRole('group', { name: 'desktop notifications' });
    expect(container.firstElementChild).toBe(group);
    expect(group).toHaveClass('d-settings-row');
    expect(group).toHaveAccessibleDescription(BODY);
    expect(screen.getByText('desktop notifications')).toHaveAttribute('id', 'notify-permission-label');
    expect(within(group).getByRole('button', { name: 'turn on' })).toBeInTheDocument();
  });

  it('has no description without a hint', () => {
    render(<SettingsRow id="notify-default" label="notify me about"><span>x</span></SettingsRow>);
    expect(screen.getByRole('group', { name: 'notify me about' })).not.toHaveAttribute('aria-describedby');
  });

  it('has no serious axe violations around a segmented control', async () => {
    const { container } = render(
      <div className="d-root">
        <SettingsRow id="notify-default" label="notify me about">
          <Segmented id="notify-default-control" label="notify me about" options={DEFAULTS} value="dms-mentions" onChange={() => {}} />
        </SettingsRow>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
