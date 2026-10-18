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
