import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from '../test/fake-client.ts';
import { account } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { Settings } from './Settings.tsx';

// SafetyCompare imports QrCode by its file, so the file is what gets replaced.
vi.mock('../../../ui/src/QrCode/QrCode.tsx', () => ({
  QrCode: ({ value, label }: { value: string; label: string }) => <svg role="img" aria-label={label} data-qr-value={value} />,
}));

describe('Settings safety-number QR', () => {
  it('shows the compared number as a QR on request, encoding the contact and the 12 blocks', async () => {
    const userId = 'aa'.repeat(16);
    window.history.replaceState(null, '', '/settings/privacy');
    const fake = new FakeClient();
    fake.set('account', account());
    fake.set('devices', []);
    fake.set('settings', {});
    fake.set('communities', []);
    fake.set('dms', []);
    fake.set('trust', [{ userId, name: 'Ada', shared: true, umk: 'bb'.repeat(32), firstSeen: 1, verified: false, changedUmk: null }]);
    const blocks = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(5, '0'));
    fake.handler = command => command.m === 'safetyNumber' ? Promise.resolve(blocks.join(' ')) : Promise.resolve(null);
    const user = userEvent.setup();
    const view = render(<div className="d-root"><CoreProvider client={fake}><Settings /></CoreProvider></div>);
    await user.click(screen.getByRole('button', { name: 'Compare with Ada' }));
    const dialog = screen.getByRole('dialog', { name: 'Compare safety numbers' });
    await within(dialog).findByText(blocks[11]);
    expect(within(dialog).queryByRole('img')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'show qr' }));
    expect(within(dialog).getByRole('img', { name: 'safety number as a qr code' })).toHaveAttribute('data-qr-value', `dilla-sn:1:${userId}:${blocks.join('-')}`);
    await user.click(within(dialog).getByRole('button', { name: 'hide qr' }));
    expect(within(dialog).queryByRole('img')).toBeNull();
    await expectNoAxeViolations(view.container);
  });
});
