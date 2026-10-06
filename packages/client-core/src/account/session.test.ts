import { describe, expect, it } from 'vitest';
import { arr, decode } from '../cbor';
import { toHex } from '../hex';
import { FakeCore } from '../testing/fake-core';
import { FakeServer, IDLE_S, NONCE, nonceAt, NOW_S, SESSION_S, sessionFor } from '../testing/fake-server';
import { RENEW_MARGIN_S } from './session';

const INSTANCE = new Uint8Array(16).fill(0xab);
const DEVICE = new Uint8Array(16).fill(0xa1);
const DEV_HEX = toHex(DEVICE);

function setup(registered = true) {
  const server = new FakeServer();
  const userId = registered ? server.register('ada', DEVICE) : new Uint8Array(16).fill(0x99);
  const core = FakeCore.identified({ instanceId: INSTANCE, userId, deviceId: DEVICE, username: 'ada' });
  const { routes, session } = sessionFor(server, core);
  return { server, core, routes, session, userId };
}

describe('Session', () => {
  it('pins the renew margin', () => {
    expect(RENEW_MARGIN_S).toBe(3600);
  });

  it('establishes with a challenge and a purpose-0 signature, and stores the session', async () => {
    const { server, core, session } = setup();
    expect(session.token()).toBeNull();
    expect(await session.establish()).toBe(true);
    expect(server.paths()).toEqual([`POST /v1/devices/${DEV_HEX}/sessions/challenge`, `POST /v1/devices/${DEV_HEX}/sessions`]);
    expect(server.log.map((r) => r.auth)).toEqual([null, null]);
    expect(decode(server.log[1]?.body ?? new Uint8Array())).toEqual([NONCE, 0n, new Uint8Array(64).fill(6), null, null]);
    expect(core.session()).toEqual({ token: 'tok-1', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + IDLE_S) });
    expect(session.token()).toBe('tok-1');
  });

  it('a stale nonce does not sign the browser out', async () => {
    const { server, core, session } = setup();
    server.once('POST', `/v1/devices/${DEV_HEX}/sessions`, { status: 401, body: ['E_UNAUTHENTICATED', '', null] });
    expect(await session.establish()).toBe(true);
    expect(server.paths()).toEqual([
      `POST /v1/devices/${DEV_HEX}/sessions/challenge`, `POST /v1/devices/${DEV_HEX}/sessions`,
      `POST /v1/devices/${DEV_HEX}/sessions/challenge`, `POST /v1/devices/${DEV_HEX}/sessions`,
    ]);
    const signed = [server.log[1], server.log[3]].map((r) => arr(decode(r?.body ?? new Uint8Array()), 5)[0]);
    expect(signed).toEqual([nonceAt(1), nonceAt(2)]);
    expect(nonceAt(1)).not.toEqual(nonceAt(2));
    expect(core.calls.filter((c) => c === 'sessionSign')).toHaveLength(2);
    expect(core.session()).toEqual({ token: 'tok-1', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + IDLE_S) });
    expect(core.calls).not.toContain('sessionClear');
  });

  it('two refusals in a row are a confirmed refusal', async () => {
    const { server, core, session } = setup(false);
    core.sessionStore({ token: 'stale', expires: BigInt(NOW_S + 10), idleExpires: BigInt(NOW_S + 10) });
    expect(await session.establish()).toBe(false);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions/challenge`)).toBe(2);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions`)).toBe(2);
    expect(core.calls.filter((c) => c === 'sessionClear')).toHaveLength(1);
    expect(core.session()).toBeNull();
  });

  it('a confirmed refusal in phase 1 keeps the session record', async () => {
    const server = new FakeServer();
    const core = new FakeCore({ deviceId: DEVICE });
    core.signupBegin(INSTANCE);
    core.sessionStore({ token: 'registered', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + SESSION_S) });
    const { session } = sessionFor(server, core);
    expect(await session.establish()).toBe(false);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions`)).toBe(2);
    expect(core.session()).toEqual({ token: 'registered', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + SESSION_S) });
    expect(core.calls).not.toContain('sessionClear');
    expect(core.identity().phase).toBe(1);
  });

  it('propagates a refusal of the challenge without a second attempt', async () => {
    const { server, session } = setup();
    server.once('POST', `/v1/devices/${DEV_HEX}/sessions/challenge`, { status: 401, body: ['E_UNAUTHENTICATED', '', null] });
    await expect(session.establish()).rejects.toMatchObject({ status: 401, code: 'E_UNAUTHENTICATED' });
    expect(server.paths()).toEqual([`POST /v1/devices/${DEV_HEX}/sessions/challenge`]);
  });

  it('establishes once for concurrent callers', async () => {
    const { server, session } = setup();
    expect(await Promise.all([session.establish(), session.establish()])).toEqual([true, true]);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions/challenge`)).toBe(1);
  });

  it('refuses a session of another scope', async () => {
    const { server, core, session } = setup();
    server.scope = 1;
    await expect(session.establish()).rejects.toThrow('E_SESSION_SCOPE');
    expect(core.session()).toBeNull();
  });

  it('ensure renews only within the margin', async () => {
    const { server, core, session } = setup();
    expect(await session.ensure()).toBe(true);
    expect(server.log).toHaveLength(2);
    core.sessionStore({ token: 'fresh', expires: BigInt(NOW_S + 86_400), idleExpires: BigInt(NOW_S + RENEW_MARGIN_S + 1) });
    expect(await session.ensure()).toBe(true);
    expect(server.log).toHaveLength(2);
    expect(session.token()).toBe('fresh');
    core.sessionStore({ token: 'idle', expires: BigInt(NOW_S + 86_400), idleExpires: BigInt(NOW_S + RENEW_MARGIN_S) });
    expect(await session.ensure()).toBe(true);
    expect(server.log).toHaveLength(4);
    core.sessionStore({ token: 'old', expires: BigInt(NOW_S + RENEW_MARGIN_S), idleExpires: BigInt(NOW_S + 86_400) });
    expect(await session.ensure()).toBe(true);
    expect(server.log).toHaveLength(6);
  });

  it('ensure answers false for a device the server does not know', async () => {
    const { session } = setup(false);
    expect(await session.ensure()).toBe(false);
  });

  it('re-establishes once when an authenticated request meets 401, then retries it with the new token', async () => {
    const { server, core, routes, userId } = setup();
    core.sessionStore({ token: 'dead', expires: BigInt(NOW_S + 86_400), idleExpires: BigInt(NOW_S + 86_400) });
    await routes.putDeviceList(userId, core.deviceListBody());
    const listPath = `/v1/users/${toHex(userId)}/device-list`;
    expect(server.log.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['PUT', listPath, 'dead'],
      ['POST', `/v1/devices/${DEV_HEX}/sessions/challenge`, null],
      ['POST', `/v1/devices/${DEV_HEX}/sessions`, null],
      ['PUT', listPath, 'tok-1'],
    ]);
  });
});

describe('Session while enrolling (phase 3)', () => {
  const OTHER = new Uint8Array(16).fill(0xa9);

  /** DEVICE is registered for ada, whose newest list names only OTHER: the gate answers pending. */
  function enrolling() {
    const server = new FakeServer();
    const userId = server.register('ada', DEVICE);
    server.publishList(userId, [{ deviceId: OTHER, revokedAt: null }]);
    const core = new FakeCore({ deviceId: DEVICE });
    core.enrolBegin(INSTANCE);
    const { session } = sessionFor(server, core);
    return { server, core, session };
  }

  it('expects a pending scope while enrolling', async () => {
    const { server, core, session } = enrolling();
    expect(await session.establish()).toBe(true);
    expect(server.tokenScope.get('tok-1')).toBe(1);
    expect(core.session()).toEqual({ token: 'tok-1', expires: BigInt(NOW_S + SESSION_S), idleExpires: BigInt(NOW_S + IDLE_S) });
  });

  it('refuses an enrolled scope while enrolling', async () => {
    const { server, core, session } = enrolling();
    server.scope = 0;
    await expect(session.establish()).rejects.toThrow('E_SESSION_SCOPE');
    expect(core.session()).toBeNull();
  });

  it('a confirmed refusal while enrolling clears nothing', async () => {
    const server = new FakeServer();
    const core = new FakeCore({ deviceId: DEVICE });
    core.enrolBegin(INSTANCE);
    core.sessionStore({ token: 'pending', expires: BigInt(NOW_S + 60), idleExpires: BigInt(NOW_S + 60) });
    const { session } = sessionFor(server, core);
    expect(await session.establish()).toBe(false);
    expect(server.count('POST', `/v1/devices/${DEV_HEX}/sessions`)).toBe(2);
    expect(core.calls).not.toContain('sessionClear');
    expect(core.session()?.token).toBe('pending');
    expect(core.identity().phase).toBe(3);
  });
});
