import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreProvider } from './core/context.tsx';
import { FakeClient, refusal } from './test/fake-client.ts';
import { account } from './test/fixtures.ts';
import { browser } from './browser.ts';
import { readJoinError } from './router.ts';
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

describe('App onboarding', () => {
  // Signs up through the whole ceremony with a FakeClient whose signupSubmit resolves `result`,
  // turns the account ready, presses Open dilla and returns the location the App navigated to.
  // No communities slice is set, so the shell of task 24 (rendered from then on) never redirects.
  async function signUpWith(result: { communityId: string | null; joinError: unknown }): Promise<string> {
    const user = userEvent.setup();
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'needs-signup', user: null }));
    fake.handler = c => {
      if (c.m === 'signupBegin') fake.set('account', account({ phase: 'signup-keys', user: null,
        recoveryKey: ['7K2M', 'QX9D', 'H4TB', 'R8NW', 'C3VF', 'J6PZ', 'A1GE', 'Y5KS', 'M0QT', 'B7XH', 'W2DN', 'F9RC', 'P4ZA'] }));
      return Promise.resolve(c.m === 'signupSubmit' ? result : null);
    };
    window.history.replaceState(null, '', '/welcome?invite=ABCD-EFGH');
    const view = render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Join dilla.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByRole('textbox', { name: 'Username' }), 'ada');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox', { name: 'I have written down or printed my recovery key' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    act(() => fake.set('account', account({ phase: 'ready' })));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You’re in');
    const depth = window.history.length;
    await user.click(screen.getByRole('button', { name: 'Open dilla' }));
    expect(screen.queryByRole('heading', { name: 'You’re in' })).toBeNull();
    expect(window.history.length).toBe(depth);
    const at = window.location.pathname + window.location.search;
    view.unmount();
    return at;
  }
  it('lands at / when the invite named no server', async () => {
    expect(await signUpWith({ communityId: null, joinError: null })).toBe('/');
  });
  it('lands in the server the invite named', async () => {
    const C = 'c4'.repeat(16);
    expect(await signUpWith({ communityId: C, joinError: null })).toBe(`/c/${C}`);
  });
  it('brings a refused join back to the invite, for the join dialog', async () => {
    const joinError = { code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null };
    expect(await signUpWith({ communityId: null, joinError })).toBe('/welcome?invite=ABCD-EFGH');
  });
  // Pre-flight ruling (e): the refused join travels in the history entry's state, so the join dialog
  // of task 24 opens with it shown (initialError). The server's detail text is not carried.
  it('carries the refused join in the history state, without its detail', async () => {
    const joinError = { code: 'E_INVITE_INVALID', detail: 'spent', status: 410, retryAfterMs: null };
    expect(await signUpWith({ communityId: null, joinError })).toBe('/welcome?invite=ABCD-EFGH');
    expect(window.history.state).toEqual({ joinError: { code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null } });
    expect(readJoinError(window.history.state)).toEqual({ code: 'E_INVITE_INVALID', detail: '', status: 410, retryAfterMs: null });
  });
  it('leaves no join error in the history state after a join or without one', async () => {
    expect(await signUpWith({ communityId: 'c4'.repeat(16), joinError: null })).toBe(`/c/${'c4'.repeat(16)}`);
    expect(readJoinError(window.history.state)).toBeNull();
    expect(readJoinError(undefined)).toBeNull();
    expect(readJoinError({ joinError: 'E_X' })).toBeNull();
  });
  it('never shows onboarding to an account that is already ready', () => {
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'ready' }));
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(screen.queryByRole('heading', { name: /Join/ })).toBeNull();
  });
});

describe('App shell', () => {
  it('shows the shell to a ready account', () => {
    const fake = new FakeClient();
    fake.set('account', account({ phase: 'ready' }));
    fake.set('communities', []);
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    expect(screen.getByRole('navigation', { name: 'servers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'You are not in a server yet' })).toBeInTheDocument();
  });
});
