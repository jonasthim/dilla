import { describe, expect, it } from 'vitest';
import { arr, bin, decode, str, u64 } from '../cbor';
import { CoreError } from '../core-port';
import { FAKE_RECOVERY_KEY, FakeCore } from './fake-core';

const INSTANCE = new Uint8Array(16).fill(0xab);
const COMMUNITY = new Uint8Array(16).fill(0xc1);
const CHANNEL = new Uint8Array(16).fill(0xc2);
const GROUP = new Uint8Array(16).fill(0x67);
const DEV_A = new Uint8Array(16).fill(0xa1);
const USER_A = new Uint8Array(16).fill(0xa2);

const member = () => FakeCore.identified({ instanceId: INSTANCE, userId: USER_A, deviceId: DEV_A, username: 'ada' });

function caught(fn: () => unknown): CoreError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CoreError) return err;
    throw err;
  }
  throw new Error('nothing was thrown');
}

const codeOf = (fn: () => unknown): string => caught(fn).code;

describe('FakeCore identity', () => {
  it('walks phase 0 → 1 → 2 with the ledger errors', () => {
    const core = new FakeCore({ deviceId: DEV_A });
    expect(core.identity()).toEqual({ phase: 0, instanceId: null, userId: null, deviceId: null, username: '', listPublished: false });
    expect(codeOf(() => core.sessionSign(new Uint8Array(32), 0))).toBe('E_CORE_NO_IDENTITY');
    expect(codeOf(() => core.sessionStore({ token: 't', expires: 2n, idleExpires: 1n }))).toBe('E_CORE_NO_IDENTITY');
    expect(caught(() => core.signupReset())).toMatchObject({ code: 'E_CORE_STATE', detail: 'no signup is pending' });
    expect(core.signupBegin(INSTANCE)).toBe(FAKE_RECOVERY_KEY);
    expect(FAKE_RECOVERY_KEY).toHaveLength(52);
    expect(core.identity()).toEqual({ phase: 1, instanceId: INSTANCE, userId: null, deviceId: DEV_A, username: '', listPublished: false });
    expect(codeOf(() => core.signupBegin(INSTANCE))).toBe('E_CORE_STATE');
    expect(codeOf(() => core.keyPackages(1, false))).toBe('E_CORE_NO_IDENTITY');
    expect(codeOf(() => core.sessionSign(new Uint8Array(32), 2 as unknown as 0))).toBe('E_CORE_INPUT');
    const req = arr(decode(core.signupRequest('INVITE', 'ada', 'Ada', null)), 8);
    expect([str(req[0] ?? null), str(req[1] ?? null), str(req[2] ?? null), req[6]]).toEqual(['INVITE', 'ada', 'Ada', null]);
    const deviceEntry = arr(req[7] ?? null, 5);
    expect(bin(deviceEntry[0] ?? null)).toEqual(DEV_A);
    expect(decode(bin(deviceEntry[4] ?? null))).toEqual(['fake.cred', new Uint8Array(16), DEV_A]);
    const list = core.signupComplete(USER_A, 'ada', 1_800_000_000n);
    const body = arr(decode(list), 4);
    expect(u64(body[0] ?? null)).toBe(1n);
    expect(decode(bin(body[1] ?? null))).toEqual(['fake.list', USER_A, DEV_A, 1_800_000_000n]);
    expect(core.identity()).toEqual({ phase: 2, instanceId: INSTANCE, userId: USER_A, deviceId: DEV_A, username: 'ada', listPublished: false });
    expect(caught(() => core.signupReset())).toMatchObject({ code: 'E_CORE_STATE', detail: 'the identity is complete' });
    expect(core.deviceListBody()).toEqual(list);
    core.deviceListPublished();
    expect(core.identity().listPublished).toBe(true);
    const kp = arr(decode(core.keyPackages(3, true)), 2);
    expect(arr(kp[0] ?? null).map((k) => decode(bin(k)))).toEqual([
      ['fake.kp', DEV_A, 0n, 0n], ['fake.kp', DEV_A, 1n, 0n], ['fake.kp', DEV_A, 2n, 0n],
    ]);
    expect(decode(bin(kp[1] ?? null))).toEqual(['fake.kp', DEV_A, 3n, 1n]);
    expect(arr(decode(core.keyPackages(2, false)), 2)[1]).toBeNull();
    expect(codeOf(() => core.keyPackages(33, false))).toBe('E_CORE_INPUT');
    expect(decode(core.sessionSign(new Uint8Array(32).fill(9), 0))).toEqual([new Uint8Array(32).fill(9), 0n, new Uint8Array(64).fill(6), null, null]);
  });

  it('resets a pending signup that has no session record', () => {
    const core = new FakeCore();
    core.signupBegin(INSTANCE);
    core.signupReset();
    expect(core.identity().phase).toBe(0);
    expect(core.signupBegin(INSTANCE)).toBe(FAKE_RECOVERY_KEY);
  });

  it('refuses to reset a pending signup whose account is registered, and changes nothing', () => {
    const core = new FakeCore({ deviceId: DEV_A });
    core.signupBegin(INSTANCE);
    core.sessionStore({ token: 'tok', expires: 9n, idleExpires: 8n });
    const e = caught(() => core.signupReset());
    expect([e.code, e.detail]).toEqual(['E_CORE_STATE', 'the account is registered']);
    expect(core.identity()).toEqual({ phase: 1, instanceId: INSTANCE, userId: null, deviceId: DEV_A, username: '', listPublished: false });
    expect(core.session()).toEqual({ token: 'tok', expires: 9n, idleExpires: 8n });
  });

  it('keeps one session record', () => {
    const core = member();
    expect(core.session()).toBeNull();
    core.sessionStore({ token: 't', expires: 2n, idleExpires: 1n });
    expect(core.session()).toEqual({ token: 't', expires: 2n, idleExpires: 1n });
    core.sessionStore({ token: 'u', expires: 4n, idleExpires: 3n });
    expect(core.session()).toEqual({ token: 'u', expires: 4n, idleExpires: 3n });
    core.sessionClear();
    expect(core.session()).toBeNull();
  });
});

describe('FakeCore group half', () => {
  it('throws not modelled for every group, commit, send, outbox and timeline method, and logs the call', () => {
    const core = member();
    const apply = caught(() => core.groupApply(GROUP, new Uint8Array([0x80]), new Uint8Array([0x80]), 1n));
    expect([apply.code, apply.detail]).toEqual(['E_CORE_STATE', 'not modelled']);
    const send = caught(() => core.sendPrepare(GROUP, 'hi', 1n));
    expect([send.code, send.detail]).toEqual(['E_CORE_STATE', 'not modelled']);
    const others: [string, () => unknown][] = [
      ['groups', () => core.groups()],
      ['groupCreate', () => core.groupCreate(GROUP, COMMUNITY, CHANNEL, 1n, new Uint8Array(32))],
      ['groupRegistered', () => core.groupRegistered(GROUP, 1n)],
      ['groupDiscard', () => core.groupDiscard(GROUP)],
      ['groupJoinExternal', () => core.groupJoinExternal({ groupId: GROUP, communityId: COMMUNITY, channelId: CHANNEL, policyVersion: 1n },
        new Uint8Array([0x80]), new Uint8Array([0x80]))],
      ['groupJoined', () => core.groupJoined(GROUP, 1n)],
      ['welcomesApply', () => core.welcomesApply(new Uint8Array([0x80]), [])],
      ['commitBuild', () => core.commitBuild(GROUP, new Uint8Array([0x80]))],
      ['commitConfirm', () => core.commitConfirm(GROUP)],
      ['commitAbort', () => core.commitAbort(GROUP)],
      ['cursorBody', () => core.cursorBody(GROUP)],
      ['cursorAcked', () => core.cursorAcked(GROUP, 1n, 1n)],
      ['messageDeleted', () => core.messageDeleted(GROUP, 1n)],
      ['sendEncrypt', () => core.sendEncrypt(GROUP)],
      ['sendConfirm', () => core.sendConfirm(GROUP, new Uint8Array([0x80]))],
      ['sendRequeue', () => core.sendRequeue(GROUP)],
      ['sendFail', () => core.sendFail(GROUP, 'E_X')],
      ['sendRetry', () => core.sendRetry(GROUP)],
      ['sendDiscard', () => core.sendDiscard(GROUP)],
      ['outbox', () => core.outbox(GROUP)],
      ['timeline', () => core.timeline(GROUP, 0n, 10)],
    ];
    for (const [, fn] of others) expect(caught(fn)).toMatchObject({ code: 'E_CORE_STATE', detail: 'not modelled' });
    expect(core.calls).toEqual(['groupApply', 'sendPrepare', ...others.map(([name]) => name)]);
  });
});

describe('FakeCore test hooks', () => {
  it('logs calls, injects one failure, and refuses calls while paused', async () => {
    const core = member();
    core.failOnce('session', new CoreError('E_CORE_STORAGE', 'disk'));
    expect(codeOf(() => core.session())).toBe('E_CORE_STORAGE');
    expect(core.session()).toBeNull();
    expect(core.calls.slice(-2)).toEqual(['session', 'session']);
    core.pause();
    expect(codeOf(() => core.identity())).toBe('E_STORE_PAUSED');
    await core.resume();
    expect(core.identity().phase).toBe(2);
    core.close();
    expect(codeOf(() => core.identity())).toBe('E_STORE_PAUSED');
  });
});
