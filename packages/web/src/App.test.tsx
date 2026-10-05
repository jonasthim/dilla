import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CoreProvider } from './core/context.tsx';
import { FakeClient, refusal } from './test/fake-client.ts';
import { account } from './test/fixtures.ts';
import { browser } from './browser.ts';
import { App, screenFor } from './App.tsx';

describe('screenFor', () => {
  it('routes every phase', () => {
    expect(screenFor(undefined)).toBe('boot');
    for (const p of ['loading', 'unsupported', 'other-tab', 'store-lost', 'revoked', 'error'] as const) expect(screenFor(p)).toBe('boot');
    for (const p of ['needs-signup', 'signup-keys', 'registering'] as const) expect(screenFor(p)).toBe('onboarding');
    expect(screenFor('ready')).toBe('shell');
  });
});

describe('App', () => {
  it('starts the core once and shows the loading splash', () => {
    const fake = new FakeClient();
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(fake.callsOf('start')).toEqual([{ m: 'start' }]);
    expect(screen.getByRole('status')).toHaveTextContent('Starting dilla');
  });
  it('follows the account phase', () => {
    const fake = new FakeClient();
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    act(() => fake.set('account', account({ phase: 'other-tab' })));
    expect(screen.getByRole('status')).toHaveTextContent('dilla is open in another tab');
  });
  it('shows a failed start', async () => {
    const fake = new FakeClient();
    fake.handler = () => Promise.reject(refusal({ code: 'E_NETWORK' }));
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(await screen.findByText(/Error E_NETWORK\./)).toBeInTheDocument();
  });
  it('shows a fatal error whatever the phase', () => {
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'ready' }));
    render(<CoreProvider client={fake}><App fatal={{ code: 'E_WORKER', detail: '', status: 0, retryAfterMs: null }} /></CoreProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Error E_WORKER. Reload the page to try again.');
  });
});

describe('App durable storage', () => {
  it('asks the browser to keep its storage once, when the account first becomes ready', () => {
    const persist = vi.spyOn(browser, 'persistStorage').mockResolvedValue(true);
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'loading', user: null }));
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(persist).not.toHaveBeenCalled();
    act(() => fake.set('account', account({ phase: 'signup-keys', user: null })));
    expect(persist).not.toHaveBeenCalled();
    act(() => fake.set('account', account({ phase: 'ready' })));
    expect(persist).toHaveBeenCalledTimes(1);
    act(() => fake.set('account', account({ phase: 'ready', deviceId: 'dd'.repeat(16) })));
    expect(persist).toHaveBeenCalledTimes(1);
    persist.mockRestore();
  });
  it('changes nothing on screen when the browser refuses or the call rejects', async () => {
    const persist = vi.spyOn(browser, 'persistStorage').mockRejectedValue(new Error('not allowed'));
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'ready' }));
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/^Error /)).toBeNull();
    persist.mockRestore();
  });
});
