import { afterEach, expect, it, vi } from 'vitest';
import { watchUpdates } from './update.ts';

afterEach(() => { vi.useRealTimers(); });

it('announces a changed entry and checks again when the page becomes visible', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<() => Promise<Response>>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/old.js' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/new.js' })));
  const changed = vi.fn();
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed, intervalMs: 30_000 });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).not.toHaveBeenCalled();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('/assets/new.js'));
  expect(fetch).toHaveBeenCalledWith('/app-version.json', { cache: 'no-store', credentials: 'same-origin' });
  stop();
});

it('ignores an invalid response and retries without allowing parallel checks', async () => {
  vi.useFakeTimers();
  let resolve!: (value: Response) => void;
  const fetch = vi.fn<() => Promise<Response>>()
    .mockImplementationOnce(() => new Promise(r => { resolve = r; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/new.js' })));
  const changed = vi.fn();
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed, intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(new Response('{broken json'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  stop();
});

it('checks in the background while a call is active', async () => {
  vi.useFakeTimers();
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  try {
    const fetch = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/old.js' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/new.js' })));
    const changed = vi.fn();
    const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed, intervalMs: 30_000,
      voiceIntervalMs: 3_000, shouldCheck: () => true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(changed).toHaveBeenCalledWith('/assets/new.js');
    stop();
  } finally {
    if (original) Object.defineProperty(document, 'visibilityState', original);
  }
});


it('uses build notices with no periodic HTTP for fifteen minutes on a healthy wire 5 socket', async () => {
  vi.useFakeTimers();
  let state = { ready: true, entry: '/assets/old.js' };
  let notify = () => {};
  const unsubscribe = vi.fn();
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entry: '/assets/old.js' }))));
  const changed = vi.fn();
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed, intervalMs: 300_000,
    voiceIntervalMs: 30_000, shouldCheck: () => true,
    realtime: { state: () => state, subscribe: listener => { notify = listener; return unsubscribe; } } });
  await vi.advanceTimersByTimeAsync(900_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  notify(); notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  // A notice is a hint: verify against the manifest before announcing it.
  fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ entry: '/assets/new.js' }))));
  state = { ready: true, entry: '/assets/new.js' }; notify(); notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledExactlyOnceWith('/assets/new.js');
  stop(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it('reconciles reconnects and falls back during outages without parallel verification', async () => {
  vi.useFakeTimers();
  let state = { ready: true, entry: null as string | null };
  let notify = () => {};
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entry: '/assets/old.js' }))));
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed: vi.fn(), intervalMs: 300_000,
    voiceIntervalMs: 30_000, shouldCheck: () => true,
    realtime: { state: () => state, subscribe: listener => { notify = listener; return () => {}; } } });
  await vi.advanceTimersByTimeAsync(0);
  state = { ready: false, entry: null }; notify();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  state = { ready: true, entry: '/assets/old.js' }; notify(); notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(900_000);
  expect(fetch).toHaveBeenCalledTimes(3);
  state = { ready: true, entry: '/assets/../bad.js' }; notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  stop();
});

it.each(['network', 'status', 'malformed', 'stale'])('retries an unresolved build hint after %s verification without another event', async failure => {
  vi.useFakeTimers();
  let state = { ready: true, entry: '/assets/old.js' };
  let notify = () => {};
  const fetch = vi.fn<() => Promise<Response>>()
    .mockResolvedValueOnce(new Response(JSON.stringify({ entry: '/assets/old.js' })))
    .mockImplementationOnce(() => failure === 'network' ? Promise.reject(new Error('offline'))
      : Promise.resolve(new Response(failure === 'malformed' ? '{bad' : JSON.stringify({ entry: '/assets/old.js' }), { status: failure === 'status' ? 503 : 200 })))
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ entry: '/assets/new.js' }))));
  const changed = vi.fn();
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed, intervalMs: 300_000, voiceIntervalMs: 30_000,
    shouldCheck: () => true, realtime: { state: () => state, subscribe: listener => { notify = listener; return () => {}; } } });
  await vi.advanceTimersByTimeAsync(0);
  state = { ready: true, entry: '/assets/new.js' }; notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(changed).toHaveBeenCalledExactlyOnceWith('/assets/new.js');
  const verified = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(900_000);
  expect(fetch).toHaveBeenCalledTimes(verified);
  stop();
});

it('retries a new hint already present at startup and cancels unresolved retry on cleanup', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn<() => Promise<Response>>().mockRejectedValue(new Error('offline'));
  const stop = watchUpdates({ currentEntry: '/assets/old.js', fetch, changed: vi.fn(), intervalMs: 300_000,
    realtime: { state: () => ({ ready: true, entry: '/assets/new.js' }), subscribe: () => () => {} } });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
  stop(); const count = fetch.mock.calls.length;
  await vi.advanceTimersByTimeAsync(900_000);
  expect(fetch).toHaveBeenCalledTimes(count);
});
