import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BootPhase } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import type { UiError } from '../core/errors.ts';
import { FakeClient, refusal } from '../test/fake-client.ts';
import { account } from '../test/fixtures.ts';
import { expectNoAxeViolations } from '../test/setup.ts';
import { browser } from '../browser.ts';
import { Boot } from './Boot.tsx';

const WORKER_DOWN: UiError = { code: 'E_WORKER', detail: '', status: 0, retryAfterMs: null };

function show(phase: BootPhase | null, fatal: UiError | null = null) {
  const fake = new FakeClient();
  if (phase !== null) fake.set('account', account({ phase }));
  const view = render(<div className="d-root"><CoreProvider client={fake}><Boot fatal={fatal} /></CoreProvider></div>);
  return { fake, view };
}

describe('Boot', () => {
  it.each([
    [null, 'Starting dilla'],
    ['loading', 'Starting dilla'],
    ['needs-signup', 'Starting dilla'],
    ['ready', 'Starting dilla'],
    ['unsupported', 'This window cannot keep dilla’s data'],
    ['other-tab', 'dilla is open in another tab'],
    ['store-lost', 'This browser can no longer open its saved data'],
    ['revoked', 'This browser was signed out'],
    ['error', 'dilla could not start'],
  ] as const)('phase %s says %s', async (phase, status) => {
    const { view } = show(phase);
    expect(screen.getByRole('status')).toHaveTextContent(status);
    await expectNoAxeViolations(view.container);
  });

  it('explains the other tab', () => {
    show('other-tab');
    expect(screen.getByRole('status')).toHaveTextContent('Use that tab, or close it. This tab takes over as soon as the other one closes.');
  });

  it('tells a revoked browser how to start over and offers no reset', () => {
    show('revoked');
    expect(screen.getByRole('status')).toHaveTextContent('Your account no longer accepts this browser. Ask the host if you did not expect this. To start over here, clear this site’s data in the browser’s settings.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the error code of the account or of a fatal error', () => {
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'error', error: { code: 'E_KEK_UNWRAP', detail: '', status: 0, retryAfterMs: null } }));
    const { unmount } = render(<CoreProvider client={fake}><Boot fatal={null} /></CoreProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Error E_KEK_UNWRAP. Reload the page to try again.');
    unmount();
    show('ready', WORKER_DOWN);
    expect(screen.getByRole('status')).toHaveTextContent('Error E_WORKER. Reload the page to try again.');
  });

  it('reloads from the error splash', async () => {
    const reload = vi.spyOn(browser, 'reload').mockImplementation(() => {});
    show('error');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });

  it('resets the device only after a confirmation', async () => {
    const user = userEvent.setup();
    const { fake } = show('store-lost');
    // Pending, as the worker's resetDevice is until its bootStore settles: the splash lasts that long (WEB-APP-02).
    fake.handler = c => (c.m === 'resetDevice' ? new Promise(() => {}) : Promise.resolve(null));
    await user.click(screen.getByRole('button', { name: 'Reset this browser' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset this browser?' });
    expect(dialog).toHaveTextContent('This deletes dilla’s data for this site from this browser. It cannot be undone.');
    expect(fake.callsOf('resetDevice')).toHaveLength(0);
    // The close button's name comes from en.ts 'dialog.close' through Dialog's closeLabel.
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.callsOf('resetDevice')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reset this browser' }));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(fake.callsOf('resetDevice')).toEqual([{ m: 'resetDevice' }]);
    expect(screen.getByRole('status')).toHaveTextContent('Clearing this browser’s data');
  });

  // WEB-APP-02: the clearing splash lasts while the reset is pending; a reset that settles with the store still
  // lost offers the reset again instead of staying on the splash for ever.
  it('offers the reset again when the store is still lost after it', async () => {
    const user = userEvent.setup();
    const { fake } = show('store-lost');
    let finish: (v: null) => void = () => {};
    fake.handler = c => (c.m === 'resetDevice' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(null));
    await user.click(screen.getByRole('button', { name: 'Reset this browser' }));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('status')).toHaveTextContent('Clearing this browser’s data');
    await act(async () => { finish(null); await Promise.resolve(); });
    expect(screen.getByRole('status')).toHaveTextContent('This browser can no longer open its saved data');
    expect(screen.getByRole('button', { name: 'Reset this browser' })).toBeInTheDocument();
  });

  it('shows a failed reset as an error', async () => {
    const user = userEvent.setup();
    const { fake } = show('store-lost');
    fake.handler = c => (c.m === 'resetDevice' ? Promise.reject(refusal({ code: 'E_CORE_STORAGE', detail: 'x' })) : Promise.resolve(null));
    await user.click(screen.getByRole('button', { name: 'Reset this browser' }));
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText(/Error E_CORE_STORAGE\./)).toBeInTheDocument();
  });
});
