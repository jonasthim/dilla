import { describe, expect, it } from 'vitest';
import { arr, bin, decode } from '../cbor';
import { CoreError } from '../core-port';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import { FAKE_RECOVERY_KEY, FakeCore } from '../testing/fake-core';
import { FakeServer, NOW_S, SESSION_S, sessionFor } from '../testing/fake-server';
import { publishDeviceList, Signup } from './signup';

const INSTANCE = new Uint8Array(16).fill(0xab);
const DEVICE = new Uint8Array(16).fill(0xa1);
const OTHER = new Uint8Array(16).fill(0xb1);
const DEV_HEX = toHex(DEVICE);
const INPUT = { invite: 'INVITE', username: 'ada', display: 'Ada', password: null };

function setup(core = new FakeCore({ deviceId: DEVICE })) {
  const server = new FakeServer();
  const { routes, session } = sessionFor(server, core);
  const signup = new Signup({ core, routes, session, now: () => NOW_S * 1000 });
  return { server, core, routes, session, signup };
}

async function httpError(p: Promise<unknown>): Promise<DillaHttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof DillaHttpError) return err;
    throw err;
  }
  throw new Error('nothing was thrown');
}

describe('Signup', () => {
  it('begins with the recovery key in 13 groups of 4', () => {
    const { signup, core } = setup();
    const groups = signup.begin(INSTANCE);
    expect(groups).toHaveLength(13);
    expect(groups.every((g) => g.length === 4)).toBe(true);
    expect(groups.join('')).toBe(FAKE_RECOVERY_KEY);
    expect(core.identity().phase).toBe(1);
    expect(() => signup.begin(INSTANCE)).toThrow(CoreError);
  });

  it('registers, stores the session, signs the device list, publishes it and the KeyPackages, in that order', async () => {
    const { signup, core, server } = setup();
    signup.begin(INSTANCE);
    await signup.submit(INPUT);
    const userId = core.identity().userId;
    if (userId === null) throw new Error('no user id');
    const listPath = `/v1/users/${toHex(userId)}/device-list`;
    expect(server.paths()).toEqual(['POST /v1/accounts', `PUT ${listPath}`, 'GET /v1/instance/limits', 'POST /v1/keypackages']);
    expect(server.log.map((r) => r.auth)).toEqual([null, 'tok-1', null, 'tok-1']);
    const steps = ['signupRequest', 'sessionStore', 'signupComplete', 'deviceListPublished', 'keyPackages'];
    expect(core.calls.filter((c) => steps.includes(c))).toEqual(steps);
    const account = arr(decode(server.log[0]?.body ?? new Uint8Array()), 8);
    expect(account.slice(0, 3)).toEqual(['INVITE', 'ada', 'Ada']);
    expect(account[6]).toBeNull();
    expect(core.identity()).toEqual({ phase: 2, instanceId: INSTANCE, userId, deviceId: DEVICE, username: 'ada', listPublished: true });
    expect(core.session()).toEqual({ token: 'tok-1', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + SESSION_S) });
    const list = arr(decode(server.log[1]?.body ?? new Uint8Array()), 4);
    expect(decode(bin(list[1] ?? null))).toEqual(['fake.list', userId, DEVICE, BigInt(NOW_S)]);
    expect(server.keyPackages).toEqual([{ device: DEV_HEX, count: 32, lastResort: true }]);
  });

  it('keeps phase 1 when the server refuses, and a second submit with other fields succeeds', async () => {
    const { signup, core, server } = setup();
    server.register('ada', OTHER);
    signup.begin(INSTANCE);
    const taken = await httpError(signup.submit(INPUT));
    expect([taken.status, taken.code, taken.detail]).toEqual([409, 'E_INVALID_REQUEST', 'username taken']);
    expect(core.identity().phase).toBe(1);
    expect(core.session()).toBeNull();
    const invalid = await httpError(signup.submit({ ...INPUT, username: 'grace', invite: 'NOPE' }));
    expect([invalid.status, invalid.code]).toEqual([410, 'E_INVITE_INVALID']);
    expect(server.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
    await signup.submit({ ...INPUT, username: 'grace' });
    expect(core.identity()).toMatchObject({ phase: 2, username: 'grace', listPublished: true });
  });

  it('never repeats a registration blindly after a network failure', async () => {
    const { signup, core, server } = setup();
    server.once('POST', '/v1/accounts', 'network');
    signup.begin(INSTANCE);
    const lost = await httpError(signup.submit(INPUT));
    expect([lost.status, lost.code]).toEqual([0, 'E_NETWORK']);
    expect(server.count('POST', '/v1/accounts')).toBe(1);
    expect(core.identity().phase).toBe(1);
    expect(core.session()).toBeNull();
  });

  it('resumes after a reload when the earlier registration went through', async () => {
    const { core, server } = setup();
    core.signupBegin(INSTANCE);
    const userId = server.register('ada', DEVICE);
    const { signup } = (() => {
      const { routes, session } = sessionFor(server, core);
      return { signup: new Signup({ core, routes, session, now: () => NOW_S * 1000 }) };
    })();
    expect(await signup.resume()).toBe(2);
    expect(core.identity()).toEqual({ phase: 2, instanceId: INSTANCE, userId, deviceId: DEVICE, username: 'ada', listPublished: true });
    expect(server.paths().slice(0, 3)).toEqual([`POST /v1/devices/${DEV_HEX}/sessions/challenge`, `POST /v1/devices/${DEV_HEX}/sessions`,
      'GET /v1/accounts/me']);
    expect(server.deviceLists.get(toHex(userId))?.version).toBe(1n);
    expect(server.keyPackages).toEqual([{ device: DEV_HEX, count: 32, lastResort: true }]);
  });

  it('a resumed signup that was never registered starts over', async () => {
    const { signup, core, server } = setup();
    signup.begin(INSTANCE);
    expect(await signup.resume()).toBe(0);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions`)).toBe(2);
    expect(core.calls).toContain('signupReset');
    expect(core.identity().phase).toBe(0);
    expect(server.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
  });

  it('a resumed signup with a stored session is never reset', async () => {
    const { signup, core, server } = setup();
    signup.begin(INSTANCE);
    core.sessionStore({ token: 'registered', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + SESSION_S) });
    expect(await signup.resume()).toBe('revoked');
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions`)).toBe(2);
    expect(core.calls).not.toContain('signupReset');
    expect(core.calls).not.toContain('sessionClear');
    expect(core.identity().phase).toBe(1);
    expect(core.session()).not.toBeNull();
    expect(server.paths().filter((p) => p.startsWith('PUT'))).toEqual([]);
  });

  it('resume does nothing outside phase 1', async () => {
    const { signup, server } = setup();
    expect(await signup.resume()).toBe(0);
    expect(server.log).toEqual([]);
  });
});

describe('publishDeviceList', () => {
  /** listed === false: the instance already holds a v1 that names only OTHER, published after this device's session
   *  was established (while the user had no list, the gate answered enrolled). */
  async function identified(server: FakeServer, listPublished: boolean, listed = true) {
    const userId = server.register('ada', DEVICE);
    const core = FakeCore.identified({ instanceId: INSTANCE, userId, deviceId: DEVICE, username: 'ada', listPublished });
    const { routes, session } = sessionFor(server, core);
    if (!listed) {
      await session.establish();
      server.publishList(userId, [{ deviceId: OTHER, revokedAt: null }]);
    }
    return { core, routes, session, userId, listPath: `/v1/users/${toHex(userId)}/device-list` };
  }
  /** The log with each request's query string (task 10's paths() prints the pathname only). */
  const lines = (s: FakeServer): string[] => s.log.map((r) => `${r.method} ${r.path}${r.query}`);

  it('does nothing when the list is already published', async () => {
    const server = new FakeServer();
    const { core, routes } = await identified(server, true);
    await publishDeviceList(core, routes);
    expect(server.log).toEqual([]);
  });

  it('treats a 409 as published when the server already holds version 1', async () => {
    const server = new FakeServer();
    const { core, routes, session, userId } = await identified(server, false);
    await session.establish();
    server.deviceLists.set(toHex(userId), { version: 1n, blob: new Uint8Array([1]) });
    await publishDeviceList(core, routes);
    expect(core.identity().listPublished).toBe(true);
    expect(server.paths().slice(-2)).toEqual([`PUT /v1/users/${toHex(userId)}/device-list`, `GET /v1/users/${toHex(userId)}/device-list`]);
  });

  it('rethrows a 409 when the server holds no list', async () => {
    const server = new FakeServer();
    const { core, routes, session, userId } = await identified(server, false);
    await session.establish();
    server.once('PUT', `/v1/users/${toHex(userId)}/device-list`, { status: 409, body: ['E_INVALID_REQUEST', 'x', null] });
    const err = await httpError(publishDeviceList(core, routes));
    expect(err.status).toBe(409);
    expect(core.identity().listPublished).toBe(false);
  });

  it('a 409 because the instance holds this device own list (an answer lost) marks it published', async () => {
    const server = new FakeServer();
    const { core, routes, session, listPath } = await identified(server, false);
    await session.establish();
    server.log.splice(0);
    server.once('PUT', listPath, 'lose');
    await publishDeviceList(core, routes);
    expect(server.paths()).toEqual([`PUT ${listPath}`, `PUT ${listPath}`, `GET ${listPath}`]);
    expect(core.calls).toContain('deviceListPublished');
    expect(core.identity().listPublished).toBe(true);
  });

  it('a 409 because a newer list names this device adopts that list and publishes nothing', async () => {
    const server = new FakeServer();
    const { core, routes, session, userId, listPath } = await identified(server, false);
    await session.establish();
    server.publishList(userId, [{ deviceId: DEVICE, revokedAt: null }]);
    server.publishList(userId, [{ deviceId: DEVICE, revokedAt: null }, { deviceId: OTHER, revokedAt: null }]);
    server.log.splice(0);
    await publishDeviceList(core, routes);
    expect(lines(server)).toEqual([`PUT ${listPath}`, `GET ${listPath}`, `GET ${listPath}?after=1`]);
    expect(core.calls).not.toContain('deviceListPublished');
    expect(core.identity().listPublished).toBe(true);
    expect(core.ownDeviceList().version).toBe(2n);
  });

  it('a 409 because a newer list leaves this device out is E_DEVICE_UNLISTED (card 27)', async () => {
    const server = new FakeServer();
    const { core, routes, userId, listPath } = await identified(server, false, false);
    // v1 (OTHER only) equals the stored version, which the core answers from its own entries; v2 is what leaves DEVICE out.
    server.publishList(userId, [{ deviceId: OTHER, revokedAt: null }]);
    server.log.splice(0);
    await expect(publishDeviceList(core, routes)).rejects.toThrow('E_DEVICE_UNLISTED');
    expect(lines(server)).toEqual([`PUT ${listPath}`, `GET ${listPath}`, `GET ${listPath}?after=1`]);
    expect(core.calls).not.toContain('deviceListPublished');
  });
});
