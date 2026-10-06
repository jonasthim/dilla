import { describe, expect, it } from 'vitest';
import { SliceStore } from './store';
import type { AccountState, CommunitySummary, SliceName } from './types';

function account(phase: AccountState['phase']): AccountState {
  return { phase, instance: null, user: null, deviceId: null, recoveryKey: null, error: null, signIn: null };
}

function recording() {
  const posted: { name: SliceName; rev: number; value: unknown }[] = [];
  const store = new SliceStore((name, rev, value) => posted.push({ name, rev, value }));
  return { store, posted };
}

describe('SliceStore', () => {
  it('publishes every change with a revision per slice name that starts at 1', () => {
    const { store, posted } = recording();
    store.set('account', account('loading'));
    store.set('account', account('needs-signup'));
    store.set('communities', []);
    expect(posted.map((p) => [p.name, p.rev])).toEqual([['account', 1], ['account', 2], ['communities', 1]]);
    expect(posted[1]?.value).toEqual(account('needs-signup'));
    expect(store.rev('account')).toBe(2);
    expect(store.rev(`timeline:${'a'.repeat(32)}`)).toBe(0);
    expect(store.get('account')?.phase).toBe('needs-signup');
  });

  it('does not publish a value equal to the one it holds', () => {
    const { store, posted } = recording();
    store.set('connection', { status: 'offline', generation: null });
    store.set('connection', { status: 'offline', generation: null });
    expect(posted).toHaveLength(1);
    expect(store.rev('connection')).toBe(1);
  });

  it('stores a deep-frozen copy, so neither the caller nor a reader can change what was published', () => {
    const { store } = recording();
    const list: CommunitySummary[] = [{ id: 'a'.repeat(32), name: 'one' }];
    store.set('communities', list);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the brief's test, kept as written
    list[0]!.name = 'changed';
    list.push({ id: 'b'.repeat(32), name: 'two' });
    const held = store.get('communities')!;
    expect(held).toEqual([{ id: 'a'.repeat(32), name: 'one' }]);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held[0])).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the brief's test, kept as written
    expect(() => (held as CommunitySummary[]).push({ id: 'c'.repeat(32), name: 'three' })).toThrow(TypeError);
  });

  it('returns the same object until the slice changes', () => {
    const { store } = recording();
    store.set('communities', []);
    const first = store.get('communities');
    store.set('communities', []);
    expect(store.get('communities')).toBe(first);
    store.set('communities', [{ id: 'a'.repeat(32), name: 'x' }]);
    expect(store.get('communities')).not.toBe(first);
  });
});
