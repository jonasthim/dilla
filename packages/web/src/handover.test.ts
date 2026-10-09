import { it, expect, vi } from 'vitest';
import { requestHandover } from './handover.ts';

it('posts only takeover fields and starts after an exact release', async () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: unknown[] = [];
  const close = vi.fn();
  const startFollower = vi.fn(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the factory name is asserted below
  const channelFactory = vi.fn((_name: string) => ({
    postMessage: (value: unknown) => { posted.push(value); },
    addEventListener: (_type: string, cb: EventListener) => { listeners.add(cb as (event: MessageEvent) => void); },
    removeEventListener: (_type: string, cb: EventListener) => { listeners.delete(cb as (event: MessageEvent) => void); },
    close,
  }));
  const instance = 'ab'.repeat(16);
  const nonce = '01'.repeat(16);
  const waiting = requestHandover(instance, channelFactory, startFollower, () => new Uint8Array(16).fill(1));
  expect(channelFactory).toHaveBeenCalledWith(`dilla-core:${instance}`);
  expect(posted).toEqual([{ t: 'takeover', instance, nonce }]);
  for (const listener of listeners) listener({ data: { t: 'released', instance, nonce: '02'.repeat(16) } } as MessageEvent);
  await Promise.resolve();
  expect(startFollower).not.toHaveBeenCalled();
  for (const listener of listeners) listener({ data: { t: 'released', instance, nonce, body: 'forbidden' } } as MessageEvent);
  await Promise.resolve();
  expect(startFollower).not.toHaveBeenCalled();
  for (const listener of listeners) listener({ data: { t: 'released', instance, nonce } } as MessageEvent);
  await waiting;
  expect(startFollower).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
