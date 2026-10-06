import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { DeviceRow, type DeviceRowProps } from './DeviceRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// L-COPY-02: devices.tier.web, devices.tier.native, devices.thisBrowser, devices.unlisted, devices.revoked,
// devices.lastSeen, devices.revoke. Row names are the first eight hex characters of a device id (flow 03).
function list(p: DeviceRowProps) {
  return <ul role="list"><DeviceRow {...p} /></ul>;
}

describe('DeviceRow', () => {
  it('is one list item holding the name, the tier tag, the state and the last-seen time as separate text', () => {
    render(list({ name: '0a1b2c3d', tier: 'web', tierLabel: 'browser', state: 'not yet in the device list', lastSeen: 'last seen 20:40' }));
    const item = screen.getByRole('listitem');
    expect(item).toHaveClass('d-device-row');
    expect(item).toHaveAttribute('data-tier', 'web');
    for (const text of ['0a1b2c3d', 'browser', 'not yet in the device list', 'last seen 20:40']) {
      expect(within(item).getByText(text).tagName).toBe('SPAN');
    }
    expect(item).not.toHaveAttribute('data-own');
    expect(within(item).queryByRole('button')).toBeNull();
  });

  it('marks this browser with its tag and offers no action without one', () => {
    render(list({ name: '3f9a2c1d', tier: 'web', tierLabel: 'browser', own: true, ownLabel: 'this browser', lastSeen: 'last seen 21:04' }));
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('data-own', 'true');
    expect(within(item).getByText('this browser').tagName).toBe('SPAN');
    expect(within(item).queryByRole('button')).toBeNull();
  });

  it('names its action by the label, describes it by the device name and calls it', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(list({ name: 'b2d4e6f8', tier: 'native', tierLabel: 'app', lastSeen: 'last seen 21:02', action: { label: 'remove', onAction } }));
    const button = screen.getByRole('button', { name: 'remove' });
    expect(button).toHaveAccessibleDescription('b2d4e6f8');
    expect(button).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('listitem')).toHaveAttribute('data-tier', 'native');
    await user.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('draws a danger action in the danger variant', () => {
    render(list({ name: '7c01e5aa', tier: 'web', tierLabel: 'browser', action: { label: 'remove', onAction: () => {}, danger: true } }));
    expect(screen.getByRole('button', { name: 'remove' })).toHaveAttribute('data-variant', 'danger');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(
      <div className="d-root">
        <ul role="list">
          <DeviceRow name="3f9a2c1d" tier="web" tierLabel="browser" own ownLabel="this browser" lastSeen="last seen 21:04" />
          <DeviceRow name="99ee0f11" tier="web" tierLabel="browser" state="removed" lastSeen="last seen 1 Oct 2026" />
          <DeviceRow name="b2d4e6f8" tier="native" tierLabel="app" lastSeen="last seen 21:02" action={{ label: 'remove', onAction: () => {} }} />
        </ul>
      </div>,
    );
    await expectNoAxeViolations(container);
  });
});
