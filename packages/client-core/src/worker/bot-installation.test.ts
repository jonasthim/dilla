import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../hex';
import { COMMUNITY, world, toReady } from './world';

const REQUEST = new Uint8Array(16).fill(0x74);

describe('managed bot installation worker commands', () => {
  it('saves a community bot name through the authorized route', async () => {
    const w = world();
    const patch = vi.fn(() => Promise.resolve('Music Bot'));
    Object.assign(w.routes, { patchBotProfile: patch });
    await toReady(w);
    w.call(7, { m: 'patchBotProfile', communityId: toHex(COMMUNITY), display: 'Music Bot' });
    await vi.waitFor(() => expect(w.ret(7)).toMatchObject({ t: 'ret', ok: true, value: 'Music Bot' }));
    expect(patch).toHaveBeenCalledWith(COMMUNITY, 'Music Bot');
  });
  it('preserves the stable request ID and revision through configure and disable', async () => {
    const w = world();
    await toReady(w);
    w.call(2, { m: 'configureBotInstallation', communityId: toHex(COMMUNITY), requestId: toHex(REQUEST),
      expectedRevision: null, capabilities: 0, stepUp: 'fresh-factor-token' });
    await vi.waitFor(() => expect(w.ret(2)).toMatchObject({ t: 'ret', ok: true,
      value: { communityId: toHex(COMMUNITY), state: 0, revision: '1', capabilities: 0 } }));
    expect(w.routes.configureBotInstallation).toHaveBeenCalledWith(COMMUNITY, REQUEST, null, 0, 'fresh-factor-token');

    w.call(3, { m: 'disableBotInstallation', communityId: toHex(COMMUNITY), requestId: toHex(REQUEST), expectedRevision: '1' });
    await vi.waitFor(() => expect(w.ret(3)).toMatchObject({ t: 'ret', ok: true, value: { state: 4, revision: '2' } }));
    expect(w.routes.disableBotInstallation).toHaveBeenCalledWith(COMMUNITY, REQUEST, 1n);
  });

  it('rejects malformed revisions and tokens before any installation route call', async () => {
    const w = world();
    await toReady(w);
    w.call(2, { m: 'configureBotInstallation', communityId: toHex(COMMUNITY), requestId: toHex(REQUEST),
      expectedRevision: '18446744073709551616', capabilities: 0, stepUp: 'factor' });
    w.call(3, { m: 'configureBotInstallation', communityId: toHex(COMMUNITY), requestId: toHex(REQUEST),
      expectedRevision: null, capabilities: 0, stepUp: '' });
    await vi.waitFor(() => expect(w.ret(3)).toBeDefined());
    expect(w.ret(2)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.ret(3)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.configureBotInstallation).not.toHaveBeenCalled();
  });
});
