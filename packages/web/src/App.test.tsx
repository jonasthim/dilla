import { afterEach, describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DmSummary, Notice } from '@dilla/client-core';
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
    for (const p of ['signin-login', 'signin-totp', 'signin-key', 'enrolling'] as const) expect(screenFor(p)).toBe('signin');
    expect(screenFor('cleared')).toBe('boot');
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

describe('App sign-in', () => {
  function signInWorker(fake: FakeClient) {
    const move = (over: Partial<ReturnType<typeof account>>) => fake.set('account', { ...fake.get('account')!, ...over });
    fake.handler = c => {
      if (c.m === 'signInBegin') move({ phase: 'signin-login', signIn: { username: null, needsTotp: false } });
      if (c.m === 'signInLogin') move({ phase: 'signin-key', signIn: { username: 'ada', needsTotp: false } });
      if (c.m === 'signInKey') move({ phase: 'ready', user: { id: 'bb'.repeat(16), username: 'ada' }, signIn: null });
      if (c.m === 'signInCancel') move({ phase: 'needs-signup', signIn: null });
      return Promise.resolve(c.m === 'signInLogin' ? { needsTotp: false } : null);
    };
  }
  const startAt = (fake: FakeClient) => {
    fake.set('account', account({ phase: 'needs-signup', user: null, instance: { ...account().instance!, passwordSignup: true } }));
    signInWorker(fake);
    window.history.replaceState(null, '', '/');
    return render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
  };
  it('enters the ceremony from onboarding and lands at / after done', async () => {
    const user = userEvent.setup();
    const fake = new FakeClient();
    startAt(fake);
    await user.click(screen.getByRole('button', { name: 'Use an existing account' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in to dilla.test');
    await user.type(screen.getByRole('textbox', { name: 'Username' }), 'ada');
    await user.type(screen.getByLabelText('Password'), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('textbox', { name: 'Recovery key' }));
    await user.paste('7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA');
    await user.click(screen.getByRole('button', { name: 'Add this browser' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You’re in');
    window.history.replaceState(null, '', '/welcome');
    const depth = window.history.length;
    await user.click(screen.getByRole('button', { name: 'Open dilla' }));
    expect(screen.queryByRole('heading', { name: 'You’re in' })).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(window.history.length).toBe(depth);
    expect(screen.getByRole('navigation', { name: 'servers' })).toBeInTheDocument();
  });
  it('returns to onboarding on cancel, and a later signup is not followed by the sign-in done step', async () => {
    const user = userEvent.setup();
    const fake = new FakeClient();
    startAt(fake);
    await user.click(screen.getByRole('button', { name: 'Use an existing account' }));
    await user.click(screen.getByRole('button', { name: 'Create a new account instead' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Join dilla.test');
    act(() => fake.set('account', account({ phase: 'ready' })));
    expect(screen.getByText('Step 5 of 5')).toBeInTheDocument();
    expect(screen.queryByText(/This browser is now a device of/)).toBeNull();
    expect(screen.queryByText('Step 4 of 4')).toBeNull();
  });
});

describe('App cleared', () => {
  const RACE = { code: 'E_LIST_RACE', detail: '', status: 0, retryAfterMs: null };
  it('reloads to the race message after a list race, once', () => {
    const fake = new FakeClient();
    const reload = vi.fn();
    fake.set('account', account({ phase: 'cleared', user: null, deviceId: null, signIn: null, error: RACE }));
    const view = render(<CoreProvider client={fake}><App fatal={null} reload={reload} /></CoreProvider>);
    expect(screen.getByRole('status')).toHaveTextContent('Starting dilla');
    act(() => fake.set('account', { ...fake.get('account')! }));
    view.rerender(<CoreProvider client={fake}><App fatal={null} reload={reload} /></CoreProvider>);
    expect(reload.mock.calls).toEqual([['/welcome?signin=race']]);
  });
  // main.tsx renders under StrictMode, whose double effect on mount is what the once-per-mount guard is for.
  it('reloads once under StrictMode', () => {
    const fake = new FakeClient();
    const reload = vi.fn();
    fake.set('account', account({ phase: 'cleared', user: null, deviceId: null, signIn: null, error: RACE }));
    render(<StrictMode><CoreProvider client={fake}><App fatal={null} reload={reload} /></CoreProvider></StrictMode>);
    expect(reload.mock.calls).toEqual([['/welcome?signin=race']]);
  });
  it('reloads to / after a sign-out or a forget', () => {
    const fake = new FakeClient();
    const reload = vi.fn();
    fake.set('account', account({ phase: 'ready' }));
    render(<CoreProvider client={fake}><App fatal={null} reload={reload} /></CoreProvider>);
    expect(reload).not.toHaveBeenCalled();
    act(() => fake.set('account', account({ phase: 'cleared', user: null, deviceId: null, signIn: null, error: null })));
    expect(screen.queryByRole('navigation', { name: 'servers' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Starting dilla');
    expect(reload.mock.calls).toEqual([['/']]);
  });
  it('a list race during the recovery key replaces the ceremony with the splash and reloads', async () => {
    const user = userEvent.setup();
    const fake = new FakeClient();
    const reload = vi.fn();
    fake.set('account', account({ phase: 'signin-key', user: null, deviceId: null, signIn: { username: 'ada', needsTotp: false } }));
    fake.handler = c => {
      if (c.m !== 'signInKey') return Promise.resolve(null);
      fake.set('account', account({ phase: 'cleared', user: null, deviceId: null, signIn: null, error: RACE }));
      return Promise.reject(refusal({ code: 'E_LIST_RACE' }));
    };
    window.history.replaceState(null, '', '/');
    render(<CoreProvider client={fake}><App fatal={null} reload={reload} /></CoreProvider>);
    await user.click(screen.getByRole('textbox', { name: 'Recovery key' }));
    await user.paste('7K2M-QX9D-H4TB-R8NW-C3VF-J6PZ-A1GE-Y5KS-M0QT-B7XH-W2DN-F9RC-P4ZA');
    await user.click(screen.getByRole('button', { name: 'Add this browser' }));
    expect(screen.queryByRole('heading', { name: 'Your recovery key' })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Starting dilla');
    expect(reload.mock.calls).toEqual([['/welcome?signin=race']]);
  });
});

describe('App settings and notifications', () => {
  const C = 'c4'.repeat(16);
  const DM = '9a'.repeat(16);
  afterEach(() => { vi.unstubAllGlobals(); });
  function ready(fake: FakeClient) {
    fake.set('account', account({ phase: 'ready' }));
    fake.set('communities', [{ id: C, name: 'Midgard' }]);
    fake.set(`channels:${C}`, []);
    fake.set('dms', [{ id: DM, kind: 3, members: [], name: 'bob', group: 'active' }] satisfies DmSummary[]);
    fake.set('settings', {});
  }
  it('opens settings over the shell and returns focus to the rail’s settings button on Escape', async () => {
    const user = userEvent.setup();
    const fake = new FakeClient();
    ready(fake);
    window.history.replaceState(null, '', `/c/${C}`);
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    const rail = screen.getByRole('navigation', { name: 'servers' });
    await user.click(within(rail).getByRole('button', { name: 'settings' }));
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'servers' })).toBe(rail);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(window.location.pathname).toBe(`/c/${C}`);
    expect(within(rail).getByRole('button', { name: 'settings' })).toHaveFocus();
  });
  it('shows a desktop notification for a new notice and opens its DM on click', () => {
    class Note {
      static permission: NotificationPermission = 'granted';
      static made: Note[] = [];
      onclick: ((ev: Event) => unknown) | null = null;
      closed = false;
      constructor(readonly title: string, readonly options: NotificationOptions) { Note.made.push(this); }
      close(): void { this.closed = true; }
    }
    vi.stubGlobal('Notification', Note);
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const fake = new FakeClient();
    ready(fake);
    fake.set('notices', { nextId: 0, items: [] });
    window.history.replaceState(null, '', `/c/${C}`);
    render(<CoreProvider client={fake}><App fatal={null} /></CoreProvider>);
    const n: Notice = { id: 0, channelId: DM, communityId: null, kind: 'dm', senderUser: '28'.repeat(16), senderName: 'bob', body: 'yo', ts: 1_790_000_000 };
    act(() => fake.set('notices', { nextId: 1, items: [n] }));
    expect(Note.made.map(x => [x.title, x.options.body, x.options.tag])).toEqual([['bob', 'yo', `dilla:${DM}`]]);
    act(() => { Note.made[0].onclick?.(new Event('click')); });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe(`/dm/${DM}`);
    expect(Note.made[0].closed).toBe(true);
    focus.mockRestore();
  });
});
