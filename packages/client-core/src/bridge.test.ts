import { describe, expect, it } from 'vitest';
import { CoreCallError, connectCore } from './bridge';
import type { AccountState } from './state/types';

class FakeWorker {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners: ((e: MessageEvent) => void)[] = [];
  postMessage(message: unknown): void { this.posted.push(message); }
  terminate(): void { this.terminated = true; }
  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    if (type === 'message') this.listeners.push(listener);
  }
  removeEventListener(): void {}
  emit(data: unknown): void { for (const l of this.listeners) l({ data } as MessageEvent); }
}

function account(phase: AccountState['phase']): AccountState {
  return { phase, instance: null, user: null, deviceId: null, recoveryKey: null, error: null, signIn: null };
}

function connected() {
  const worker = new FakeWorker();
  return { worker, client: connectCore(worker as unknown as Worker) };
}

describe('connectCore', () => {
  it("posts each call with a fresh id and resolves it with the worker's value", async () => {
    const { worker, client } = connected();
    const first = client.call({ m: 'joinCommunity', invite: 'code' });
    const second = client.call({ m: 'selectCommunity', communityId: 'a'.repeat(32) });
    expect(worker.posted).toEqual([
      { t: 'call', id: 1, command: { m: 'joinCommunity', invite: 'code' } },
      { t: 'call', id: 2, command: { m: 'selectCommunity', communityId: 'a'.repeat(32) } },
    ]);
    worker.emit({ t: 'ret', id: 2, ok: true, value: null });
    worker.emit({ t: 'ret', id: 1, ok: true, value: { communityId: 'b'.repeat(32) } });
    await expect(first).resolves.toEqual({ communityId: 'b'.repeat(32) });
    await expect(second).resolves.toBeNull();
  });

  it("rejects with the worker's error: code, detail, status and wait", async () => {
    const { worker, client } = connected();
    const pending = client.call({ m: 'send', channelId: 'a'.repeat(32), text: 'x' });
    const later = client.call({ m: 'joinCommunity', invite: 'code' });
    worker.emit({ t: 'ret', id: 1, ok: false, error: { code: 'E_NOT_READY', detail: 'the phase is needs-signup', status: 0, retryAfterMs: null } });
    worker.emit({ t: 'ret', id: 2, ok: false, error: { code: 'E_RATE_LIMITED', detail: '', status: 429, retryAfterMs: 4200 } });
    const error: unknown = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreCallError);
    expect(error).toMatchObject({
      name: 'CoreCallError', code: 'E_NOT_READY', detail: 'the phase is needs-signup', status: 0, retryAfterMs: null,
      message: 'E_NOT_READY: the phase is needs-signup',
    });
    const limited: unknown = await later.catch((e: unknown) => e);
    expect(limited).toMatchObject({ code: 'E_RATE_LIMITED', detail: '', status: 429, retryAfterMs: 4200, message: 'E_RATE_LIMITED' });
    expect(new CoreCallError({ code: 'E_X', detail: 'd', status: 409, retryAfterMs: null })).toMatchObject({ code: 'E_X', detail: 'd', status: 409, message: 'E_X: d' });
  });

  it('ignores an answer to an id it never sent and a message of no known kind', () => {
    const { worker, client } = connected();
    expect(() => worker.emit({ t: 'ret', id: 99, ok: true, value: 1 })).not.toThrow();
    expect(() => worker.emit({ t: 'nonsense' })).not.toThrow();
    expect(client.get('account')).toBeUndefined();
  });

  it('keeps the newest revision of each slice and notifies its listeners once per accepted revision', () => {
    const { worker, client } = connected();
    let calls = 0;
    const off = client.subscribe('account', () => { calls += 1; });
    worker.emit({ t: 'slice', name: 'account', rev: 1, value: account('loading') });
    const held = client.get('account');
    expect(held?.phase).toBe('loading');
    expect(client.get('account')).toBe(held);
    worker.emit({ t: 'slice', name: 'account', rev: 3, value: account('ready') });
    worker.emit({ t: 'slice', name: 'account', rev: 2, value: account('other-tab') });
    worker.emit({ t: 'slice', name: 'account', rev: 3, value: account('error') });
    expect(client.get('account')?.phase).toBe('ready');
    expect(calls).toBe(2);
    off();
    worker.emit({ t: 'slice', name: 'account', rev: 4, value: account('revoked') });
    expect(calls).toBe(2);
    expect(client.get('account')?.phase).toBe('revoked');
    expect(client.get('communities')).toBeUndefined();
  });

  it('dispose terminates the worker and rejects pending and later calls with E_DISPOSED', async () => {
    const { worker, client } = connected();
    const pending = client.call({ m: 'start' });
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'E_DISPOSED', detail: '', status: 0, retryAfterMs: null });
    await expect(client.call({ m: 'start' })).rejects.toMatchObject({ code: 'E_DISPOSED', detail: '', status: 0, retryAfterMs: null });
    expect(worker.posted).toHaveLength(1);
  });
});
