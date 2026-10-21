import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { arr, decode, encode, type CborValue } from '../cbor';
import { fromHex, toHex } from '../hex';
import { CHANNEL, COMMUNITY, ME, ModelDs, PEER } from '../sync/testing/model';
import { DillaHttpError } from '../http/errors';
import type { Routes } from '../http/routes';
import { fakeDskPub, fakeListBlob, type FakeListEntry } from './fake-list';
import { FAKE_STEP_UP_EXPIRES_S, FAKE_TOTP_CODE, FAKE_TOTP_SECRET, FakeServer, NOW_S, fakeDeviceProof, routesFor } from './fake-server';

const DEV_A = new Uint8Array(16).fill(0xa1);
const DEV_B = new Uint8Array(16).fill(0xb1);

it('answers absent and paged peer lists like the HTTP route', async () => {
  // Missing and paged list responses stand in for dillad; signed-list validity is covered by client_trust.rs.
  const server = new FakeServer();
  const { c } = await ada(server);
  const peer = server.register('peer-list', DEV_B);
  expect(await c.routes.getDeviceList(peer)).toBeNull();
  expect(await c.routes.getDeviceListHistory(peer, 0n)).toMatchObject({ count: 0, lastVersion: null });
  for (let v = 1; v <= 65; v += 1) server.publishList(peer, [{ deviceId: DEV_B, revokedAt: null }]);
  expect((await c.routes.getDeviceListHistory(peer, 0n)).count).toBe(64);
  expect(await raw(server, 'GET', `/v1/users/${toHex(peer)}/device-list?after=0`, null)).toMatchObject({ status: 401 });
});

function client(server: FakeServer): { routes: Routes; use(token: string | null): void } {
  const holder: { token: string | null } = { token: null };
  const routes = routesFor(server, { token: () => holder.token, reauthenticate: () => Promise.resolve(false) });
  return { routes, use(token) { holder.token = token; } };
}

function listBody(user: Uint8Array, v: bigint, entries: FakeListEntry[]): Uint8Array {
  return encode([v, fakeListBlob(user, entries, 1n), new Uint8Array(64), new Uint8Array(32)]);
}

/** An establish body: the registration array and the login when login is set, else a credential bstr and null.
 *  The registration names the device's own key (fakeDskPub) unless `key` is given: one live row per key (F2). */
function establishBody(device: Uint8Array, login: string | null, key: Uint8Array = fakeDskPub(device)): Uint8Array {
  return encode([new Uint8Array(32), 0, new Uint8Array(64),
    login === null ? new Uint8Array([1]) : [device, key, 1, 1, new Uint8Array([2])],
    login === null ? null : new TextEncoder().encode(login)]);
}

/** One request straight to the model, outside HttpClient (which would retry a short 429). */
async function raw(server: FakeServer, method: string, path: string, token: string | null, body?: Uint8Array):
  Promise<{ status: number; body: CborValue }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/cbor' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await server.fetch(`http://127.0.0.1:8453${path}`, { method, headers, body: body as BodyInit | undefined });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body: bytes.length === 0 ? null : decode(bytes) };
}

/** A POST /v1/devices body: the device array, then a challenge nonce for `device` and the purpose-0 proof by `key`. */
function devicePostBody(device: Uint8Array, key: Uint8Array, nonce: Uint8Array, signer: Uint8Array = key): Uint8Array {
  return encode([device, key, 1, 1, new Uint8Array([2]), nonce, fakeDeviceProof(signer, device, nonce)]);
}

async function refusalOf(p: Promise<unknown>): Promise<DillaHttpError> {
  const e = await p.then(() => null, (err: unknown) => err);
  if (!(e instanceof DillaHttpError)) throw new Error('expected a DillaHttpError');
  return e;
}

/** ada with DEV_A enrolled and list v1 published; the client holds DEV_A's token. */
async function ada(server: FakeServer): Promise<{ c: ReturnType<typeof client>; user: Uint8Array }> {
  const user = server.register('ada', DEV_A);
  server.setPassword('ada', 'pw');
  const c = client(server);
  const a = await c.routes.postSession(DEV_A, establishBody(DEV_A, null));
  expect(a.scope).toBe(0);
  c.use(a.token);
  await c.routes.putDeviceList(user, listBody(user, 1n, [{ deviceId: DEV_A, revokedAt: null }]));
  return { c, user };
}

describe('FakeServer answers the web-2a account routes as dillad does', () => {
  it('lets an enrolled session read a peer list but forbids a pending session', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const peer = server.register('bea', new Uint8Array(16).fill(0xbe));
    server.publishList(peer, [{ deviceId: new Uint8Array(16).fill(0xbe) }]);
    expect((await c.routes.getDeviceList(peer))?.version).toBe(1n);
    await expect(c.routes.putDeviceList(peer, listBody(peer, 2n, []))).rejects.toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    const pending = await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    c.use(pending.token);
    expect((await c.routes.getDeviceList(user))?.version).toBe(1n);
    await expect(c.routes.getDeviceList(peer)).rejects.toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
  });

  it('spends an assertion after registration shape checks', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const assertion = (await c.routes.passwordLogin('ada', 'pw')).assertion;
    const wrong = encode([new Uint8Array(32), 0, new Uint8Array(64),
      [DEV_A, new Uint8Array(32), 1, 1, new Uint8Array([2])], new TextEncoder().encode(assertion)]);
    expect((await refusalOf(c.routes.postSessionPending(DEV_B, wrong))).status).toBe(400);
    expect((await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, assertion))).scope).toBe(1);
  });

  it('refuses an unreadable newest list and sends an empty 501 detail', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const token = server.log.at(-1)?.auth;
    expect(token).toBeTruthy();
    const deleted = await server.fetch('http://127.0.0.1:8453/v1/backups', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleted.status).toBe(501);
    expect(decode(new Uint8Array(await deleted.arrayBuffer()))).toEqual(['E_INTERNAL', '', null]);
    server.deviceLists.set(toHex(user), { version: 2n, blob: new Uint8Array([0xff]) });
    expect((await refusalOf(c.routes.postSession(DEV_A, establishBody(DEV_A, null)))).status).toBe(401);
  });

  it('registers a second device by password login: pending until the list names it, enrolled after', async () => {
    const server = new FakeServer();
    const lone = server.register('lee', new Uint8Array(16).fill(0xc5));
    server.setPassword('lee', 'pw');
    const anon = client(server);
    expect((await refusalOf(anon.routes.passwordLogin('lee', 'wrong'))).status).toBe(401);
    const noList = await anon.routes.passwordLogin('lee', 'pw');
    // A user with no list: assertion registration is refused (Q26).
    expect((await refusalOf(anon.routes.postSessionPending(new Uint8Array(16).fill(9), establishBody(new Uint8Array(16).fill(9), noList.assertion)))).status).toBe(401);
    expect(server.devices.get(toHex(new Uint8Array(16).fill(9)))).toBeUndefined();
    expect(toHex(lone)).toHaveLength(32);

    const { c, user } = await ada(server);
    const login = await c.routes.passwordLogin('ada', 'pw');
    expect(login.needs).toBe(0);
    const pending = await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, login.assertion));
    expect([pending.scope, pending.userId]).toEqual([1, user]);
    expect((await refusalOf(c.routes.postSessionPending(DEV_B, establishBody(DEV_B, login.assertion)))).status).toBe(401);
    c.use(pending.token);
    expect((await c.routes.getDeviceList(user))?.version).toBe(1n);
    expect(await c.routes.listBackups()).toEqual([]);
    expect((await refusalOf(c.routes.listDevices())).status).toBe(403);
    expect((await refusalOf(c.routes.putBackup(1, encode([1, new Uint8Array(12), new Uint8Array(4)])))).status).toBe(403);
    expect((await refusalOf(c.routes.putDeviceList(user, listBody(user, 1n, []))))).toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    await c.routes.putDeviceList(user, listBody(user, 2n, [{ deviceId: DEV_A, revokedAt: null }, { deviceId: DEV_B, revokedAt: null }]));
    const enrolled = await c.routes.postSession(DEV_B, establishBody(DEV_B, null));
    expect(enrolled.scope).toBe(0);
    c.use(enrolled.token);
    expect((await c.routes.listDevices()).map((d) => d.id)).toEqual([DEV_A, DEV_B]);
    const history = await c.routes.getDeviceListHistory(user, 0n);
    expect([history.count, history.lastVersion]).toEqual([2, 2n]);
    expect((await c.routes.getDeviceListHistory(user, 2n)).count).toBe(0);
  });

  it('needs the second factor before an assertion registers', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setPassword('ada', 'pw', '123456');
    const first = await c.routes.passwordLogin('ada', 'pw');
    expect(first.needs).toBe(1);
    expect((await refusalOf(c.routes.postSessionPending(DEV_B, establishBody(DEV_B, first.assertion)))).status).toBe(401);
    const second = await c.routes.passwordLogin('ada', 'pw');
    expect((await refusalOf(c.routes.totpVerify(second.assertion, '000000'))).status).toBe(401);
    const third = await c.routes.passwordLogin('ada', 'pw');
    const cleared = await c.routes.totpVerify(third.assertion, '123456');
    expect((await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, cleared.assertion))).scope).toBe(1);
  });

  it('past the hourly rate replaces the oldest unlisted row and admits, the first device counting (ruling 32), never 429', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);   // DEV_A created at NOW_S counts (ruling 32)
    server.enrolmentsPerHour = 2;
    const dev = (n: number) => new Uint8Array(16).fill(0x40 + n);
    const enrol = async (d: Uint8Array) => c.routes.postSessionPending(d, establishBody(d, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    const first = await enrol(dev(1));   // one creation (DEV_A) in the window: below the rate
    expect(first.scope).toBe(1);
    // Two live creations in the window: dev(2) replaces dev(1), the oldest unlisted row, and is admitted.
    expect((await enrol(dev(2))).scope).toBe(1);
    expect([server.revoked.get(toHex(dev(1))), server.revoked.has(toHex(DEV_A)), server.revoked.has(toHex(dev(2)))])
      .toEqual([NOW_S, false, false]);
    expect(server.tokens.has(first.token)).toBe(false);   // the replaced row's sessions are deleted
    // One second inside the window: since = nowS − 3599 = NOW_S still counts DEV_A and dev(2) (dev(1) is revoked).
    server.nowS = NOW_S + 3599;
    expect((await enrol(dev(3))).scope).toBe(1);
    expect(server.revoked.get(toHex(dev(2)))).toBe(NOW_S + 3599);
    // The boundary second for dev(3)'s window is NOW_S + 3599 + 3600; at NOW_S + 3600 DEV_A has left it, one remains.
    server.nowS = NOW_S + 3600;
    expect((await enrol(dev(4))).scope).toBe(1);
    expect(server.revoked.has(toHex(dev(3)))).toBe(false);
    expect(server.paths().filter((p) => p.endsWith('/sessions'))).toHaveLength(5);   // ada's establish and four registrations, none refused
  });

  it('past the rate with every live row listed replaces nothing and refuses nothing', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.enrolmentsPerHour = 1;   // DEV_A alone fills it, and DEV_A is listed
    const login = await c.routes.passwordLogin('ada', 'pw');
    expect((await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, login.assertion))).scope).toBe(1);
    expect([server.revoked.size, server.devices.get(toHex(DEV_B))]).toEqual([0, server.devices.get(toHex(DEV_A))]);
  });

  it('at the cap replaces the oldest unlisted row whatever its age, ties by id, and admits', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.maxDevices = 3;
    server.enrolmentsPerHour = 60;
    const dev = (n: number) => new Uint8Array(16).fill(0x40 + n);
    const enrol = async (d: Uint8Array) => c.routes.postSessionPending(d, establishBody(d, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    await enrol(dev(2));
    await enrol(dev(1));   // the same second as dev(2): the smaller id is the older
    expect((await enrol(dev(3))).scope).toBe(1);   // live A, dev(1), dev(2): at the cap; dev(1) is replaced, 0 s old
    expect([...server.revoked.keys()]).toEqual([toHex(dev(1))]);
  });

  it('refuses 403 device cap reached only when every live row is listed', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    server.maxDevices = 2;
    await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    await c.routes.putDeviceList(user, listBody(user, 2n, [{ deviceId: DEV_A, revokedAt: null }, { deviceId: DEV_B, revokedAt: null }]));
    const third = new Uint8Array(16).fill(0x77);
    const capped = await refusalOf(c.routes.postSessionPending(third, establishBody(third, (await c.routes.passwordLogin('ada', 'pw')).assertion)));
    expect([capped.status, capped.code, capped.detail]).toEqual([403, 'E_FORBIDDEN', 'device cap reached']);
    expect([server.devices.has(toHex(third)), server.revoked.size]).toEqual([false, 0]);
  });

  it('sweeps an unlisted row older than 24 hours at the next registration', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    server.nowS = NOW_S + 86_400;
    const late = new Uint8Array(16).fill(0x78);
    expect((await c.routes.postSessionPending(late, establishBody(late, (await c.routes.passwordLogin('ada', 'pw')).assertion))).scope).toBe(1);
    expect(server.revoked.get(toHex(DEV_B))).toBe(NOW_S + 86_400);
  });

  it('refuses 409 a registration whose dsk_pub a live row of the user holds, and writes nothing', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const copy = await refusalOf(c.routes.postSessionPending(DEV_B,
      establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion, fakeDskPub(DEV_A))));
    expect([copy.status, copy.code, copy.detail]).toEqual([409, 'E_INVALID_REQUEST', 'dsk_pub is already registered to a live device']);
    expect(server.devices.has(toHex(DEV_B))).toBe(false);
  });

  it('judges listed by the (device_id, dsk_pub) pair: a listed id under another key is pending, and is deletable', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    // v2 names DEV_B, but with another key than the row's.
    await c.routes.putDeviceList(user, listBody(user, 2n, [{ deviceId: DEV_A, revokedAt: null },
      { deviceId: DEV_B, revokedAt: null, dskPub: new Uint8Array(32).fill(0x5a) }]));
    expect((await c.routes.postSession(DEV_B, establishBody(DEV_B, null))).scope).toBe(1);
    await expect(c.routes.deleteDevice(DEV_A)).rejects.toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    server.nowS = NOW_S + 600;   // past the key-less DELETE's 10-minute grace for another device's row
    await c.routes.deleteDevice(DEV_B);
    expect(server.revoked.has(toHex(DEV_B))).toBe(true);
    // The pair, listed: enrolled.
    const fresh = new Uint8Array(16).fill(0x79);
    await c.routes.postSessionPending(fresh, establishBody(fresh, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    await c.routes.putDeviceList(user, listBody(user, 3n, [{ deviceId: DEV_A, revokedAt: null }, { deviceId: fresh, revokedAt: null }]));
    expect((await c.routes.postSession(fresh, establishBody(fresh, null))).scope).toBe(0);
  });

  it('POST /v1/devices proves possession of dsk_pub with a challenge nonce for the new id (403), and refuses a held key (409)', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const token = server.log.at(-1)?.auth ?? null;
    const challenge = async (d: Uint8Array) => (await c.routes.postChallenge(d)).nonce;
    const key = fakeDskPub(DEV_B);
    // The web-2a five-element body is 400.
    expect((await raw(server, 'POST', '/v1/devices', token, encode([DEV_B, key, 1, 1, new Uint8Array([2])]))).status).toBe(400);
    const notProven = ['E_FORBIDDEN', 'possession of dsk_pub is not proven', null];
    // Signed by another key (a stolen session copying DEV_A's key cannot sign for it; here: any wrong signer).
    expect(await raw(server, 'POST', '/v1/devices', token, devicePostBody(DEV_B, key, await challenge(DEV_B), fakeDskPub(DEV_A))))
      .toEqual({ status: 403, body: notProven });
    // A nonce issued for another device id.
    expect(await raw(server, 'POST', '/v1/devices', token, devicePostBody(DEV_B, key, await challenge(DEV_A))))
      .toEqual({ status: 403, body: notProven });
    expect(server.devices.has(toHex(DEV_B))).toBe(false);
    // The key holder: 200 [device_id], a row.
    const body = devicePostBody(DEV_B, key, await challenge(DEV_B));
    expect(await raw(server, 'POST', '/v1/devices', token, body)).toEqual({ status: 200, body: [DEV_B] });
    expect(server.devices.get(toHex(DEV_B))).toBe(server.devices.get(toHex(DEV_A)));
    // The nonce is spent: the same body replayed is 403.
    expect((await raw(server, 'POST', '/v1/devices', token, body)).status).toBe(403);
    // The same key under a second id: 409.
    const second = new Uint8Array(16).fill(0x7a);
    expect(await raw(server, 'POST', '/v1/devices', token, devicePostBody(second, key, await challenge(second))))
      .toEqual({ status: 409, body: ['E_INVALID_REQUEST', 'dsk_pub is already registered to a live device', null] });
    // An expired nonce (60 s).
    const old = await challenge(second);
    server.nowS += 61;
    expect((await raw(server, 'POST', '/v1/devices', token, devicePostBody(second, fakeDskPub(second), old))).status).toBe(403);
    // A pending session never reaches the route.
    const pending = await c.routes.postSessionPending(second, establishBody(second, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    const third = new Uint8Array(16).fill(0x7b);
    expect((await raw(server, 'POST', '/v1/devices', pending.token, devicePostBody(third, fakeDskPub(third), await challenge(third)))).status)
      .toBe(403);
  });

  it('meters PUT /v1/backups on the upload budget: 429 E_RATE_LIMITED past 20 a minute and past the daily bytes, nothing stored', async () => {
    const server = new FakeServer();
    const { user } = await ada(server);
    const token = server.log.at(-1)?.auth ?? null;
    const object = (n: number) => encode([1, new Uint8Array(12).fill(n), new Uint8Array(40)]);
    const state = (n: number) => encode([object(n)]);
    for (let n = 0; n < 20; n++) expect((await raw(server, 'PUT', '/v1/backups/1/0', token, state(n))).status).toBe(n === 0 ? 201 : 200);
    // 20 a minute refill one request every 3 s.
    expect(await raw(server, 'PUT', '/v1/backups/1/0', token, state(20))).toEqual({ status: 429, body: ['E_RATE_LIMITED', 'rate limited', 3000n] });
    expect(server.backups.get(`${toHex(user)}/1`)?.object).toEqual(object(19));
    server.nowS += 60;
    expect((await raw(server, 'PUT', '/v1/backups/1/0', token, state(20))).status).toBe(200);

    const daily = new FakeServer();
    daily.uploadBytesPerDay = 150;
    const d = await ada(daily);
    const dt = daily.log.at(-1)?.auth ?? null;
    const size = state(1).length;   // each PUT reserves and spends its body's bytes
    expect((await raw(daily, 'PUT', '/v1/backups/1/0', dt, state(1))).status).toBe(201);
    expect((await raw(daily, 'PUT', '/v1/backups/1/0', dt, state(2))).status).toBe(200);
    const wait = BigInt(Math.floor((size - (150 - 2 * size)) * 86_400 / 150 * 1000));
    expect(await raw(daily, 'PUT', '/v1/backups/1/0', dt, state(3))).toEqual({ status: 429, body: ['E_RATE_LIMITED', 'rate limited', wait] });
    expect(daily.backups.get(`${toHex(d.user)}/1`)?.object).toEqual(object(2));
    daily.nowS += 86_400;
    expect((await raw(daily, 'PUT', '/v1/backups/1/0', dt, state(3))).status).toBe(200);
  });

  it('identify refuses a pending session with E_UNAUTHENTICATED and close 4003, by token or ticket', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const enrolled = server.log.at(-1)?.auth ?? '';
    const ticket = await c.routes.postTicket();
    expect(ticket.expires).toBe(BigInt(NOW_S + 30));
    expect(server.identify(ticket.ticket)).toEqual({ op: 'ready' });
    expect(server.identify(ticket.ticket)).toEqual({ op: 'error', code: 'E_UNAUTHENTICATED', close: 4003 });   // single use
    expect(server.identify(enrolled)).toEqual({ op: 'ready' });
    const pending = await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    expect(server.identify(pending.token)).toEqual({ op: 'error', code: 'E_UNAUTHENTICATED', close: 4003 });
    c.use(pending.token);
    await expect(c.routes.postTicket()).rejects.toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect(server.identify('tok-unknown')).toEqual({ op: 'error', code: 'E_UNAUTHENTICATED', close: 4003 });
  });

  it('refuses a native registration by assertion (ruling 31)', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const login = await c.routes.passwordLogin('ada', 'pw');
    const native = encode([new Uint8Array(32), 0, new Uint8Array(64), [DEV_B, new Uint8Array(32), 0, 1, new Uint8Array([2])], new TextEncoder().encode(login.assertion)]);
    const refused = await refusalOf(c.routes.postSessionPending(DEV_B, native));
    expect([refused.status, refused.code, refused.detail]).toEqual([400, 'E_INVALID_REQUEST', 'assertion registration is for browser devices']);
    expect(server.devices.get(toHex(DEV_B))).toBeUndefined();
  });

  it('a lost answer: the model acts, the fetch fails, the retry meets the stored version', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const path = `/v1/users/${toHex(user)}/device-list`;
    server.once('PUT', path, 'lose');
    const raced = await refusalOf(c.routes.putDeviceList(user, listBody(user, 2n, [{ deviceId: DEV_A, revokedAt: null }])));
    expect([raced.status, raced.code]).toEqual([409, 'E_INVALID_REQUEST']);
    expect(server.count('PUT', path)).toBe(3);   // ada's v1, the lost v2, the HttpClient's retry of v2
    expect((await c.routes.getDeviceList(user))?.version).toBe(2n);
    expect(server.listHistory.get(toHex(user))?.map((r) => r.version)).toEqual([1n, 2n]);
  });

  it('PATCH /v1/devices/{id} names an own device, null clears it, and another user\'s device is 404', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    expect((await c.routes.listDevices()).map((d) => d.label)).toEqual([null]);
    await c.routes.patchDevice(DEV_A, 'work laptop');
    expect((await c.routes.listDevices()).map((d) => d.label)).toEqual(['work laptop']);
    await c.routes.patchDevice(DEV_A, null);
    expect((await c.routes.listDevices()).map((d) => d.label)).toEqual([null]);
    server.register('bea', new Uint8Array(16).fill(0xbe));
    expect((await refusalOf(c.routes.patchDevice(new Uint8Array(16).fill(0xbe), 'mine'))).status).toBe(404);
    expect((await refusalOf(c.routes.patchDevice(DEV_A, ''))).status).toBe(400);
    expect((await refusalOf(c.routes.patchDevice(DEV_A, 'x'.repeat(65)))).status).toBe(400);
  });

  it('DELETE /v1/devices/{id} revokes an own unlisted row and drops its tokens', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const anon = client(server);
    const pending = await anon.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    anon.use(pending.token);
    expect(server.tokenScope.get(pending.token)).toBe(1);
    expect(await anon.routes.listBackups()).toEqual([]);
    server.nowS = NOW_S + 600;   // past the key-less DELETE's 10-minute grace for another device's row
    await c.routes.deleteDevice(DEV_B);
    expect((await refusalOf(anon.routes.listBackups())).status).toBe(401);
    expect((await c.routes.listDevices()).map((d) => [d.id, d.revokedAt])).toEqual([[DEV_A, null], [DEV_B, BigInt(NOW_S + 600)]]);
    expect((await c.routes.getDeviceList(user))?.version).toBe(1n);
    const other = server.register('bea', new Uint8Array(16).fill(0xbe));
    expect(toHex(other)).toHaveLength(32);
    expect((await refusalOf(c.routes.deleteDevice(new Uint8Array(16).fill(0xbe)))).status).toBe(404);
    expect((await refusalOf(c.routes.deleteDevice(new Uint8Array(16).fill(0x99)))).status).toBe(404);
  });

  it('publishList and putBackupObject seed what a PUT would store', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    server.devices.set(toHex(DEV_B), toHex(user));
    expect(server.publishList(user, [{ deviceId: DEV_A }, { deviceId: DEV_B }])).toBe(2n);
    expect(server.publishList(user, [{ deviceId: DEV_A }, { deviceId: DEV_B, revokedAt: 7n }], 9n)).toBe(3n);
    expect(server.revoked.get(toHex(DEV_B))).toBe(NOW_S);
    expect((await c.routes.getDeviceListHistory(user, 1n)).count).toBe(2);
    const odd = new Uint8Array([1, 2, 3]);
    server.putBackupObject(user, 1, odd);
    expect(await c.routes.getBackup(1)).toEqual({ object: odd, created: BigInt(NOW_S) });
  });

  it('scope null lets the gate decide; 0 or 1 forces the answer', async () => {
    const server = new FakeServer();
    expect(server.scope).toBeNull();
    const { c } = await ada(server);
    server.scope = 1;
    const forced = await c.routes.postSession(DEV_A, establishBody(DEV_A, null));
    expect([forced.scope, server.tokenScope.get(forced.token)]).toEqual([1, 1]);
    server.scope = null;
    expect((await c.routes.postSession(DEV_A, establishBody(DEV_A, null))).scope).toBe(0);
  });

  it('a revoking list deletes the device tokens and its next establish is refused', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    server.devices.set(toHex(DEV_B), toHex(user));
    await c.routes.putDeviceList(user, listBody(user, 2n, [{ deviceId: DEV_A, revokedAt: null }, { deviceId: DEV_B, revokedAt: null }]));
    const b = client(server);
    b.use((await b.routes.postSession(DEV_B, establishBody(DEV_B, null))).token);
    expect(await b.routes.listBackups()).toEqual([]);
    await c.routes.putDeviceList(user, listBody(user, 3n, [{ deviceId: DEV_A, revokedAt: null }, { deviceId: DEV_B, revokedAt: 5n }]));
    expect((await refusalOf(b.routes.listBackups())).status).toBe(401);
    expect((await refusalOf(b.routes.postSession(DEV_B, establishBody(DEV_B, null)))).status).toBe(401);
    expect((await c.routes.listDevices()).map((d) => d.revokedAt)).toEqual([null, BigInt(NOW_S)]);
  });

  it('stores the root object once and replaces the state object', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const root = encode([1, new Uint8Array(12).fill(1), new Uint8Array(86).fill(2)]);
    expect(root).toHaveLength(103);
    const first = await c.routes.putBackup(0, root);
    expect([first.created, first.size, first.blobId.length]).toEqual([true, 103, 32]);
    expect((await c.routes.putBackup(0, root)).created).toBe(false);
    const other = await refusalOf(c.routes.putBackup(0, encode([1, new Uint8Array(12).fill(3), new Uint8Array(86).fill(4)])));
    expect([other.status, other.code, other.detail]).toEqual([409, 'E_INVALID_REQUEST', 'root object already stored']);
    const state = encode([1, new Uint8Array(12).fill(5), new Uint8Array(40)]);
    const state2 = encode([1, new Uint8Array(12).fill(6), new Uint8Array(40)]);
    expect((await c.routes.putBackup(1, state)).created).toBe(true);
    expect((await c.routes.putBackup(1, state2)).created).toBe(false);
    expect(await c.routes.listBackups()).toEqual([
      { kind: 0, chunkSeq: 0, size: 103, created: BigInt(NOW_S) },
      { kind: 1, chunkSeq: 0, size: state2.length, created: BigInt(NOW_S) },
    ]);
    expect(await c.routes.getBackup(1)).toEqual({ object: state2, created: BigInt(NOW_S) });
    expect((await refusalOf(c.routes.putBackup(1, new Uint8Array([1, 2])))).status).toBe(400);
    expect((await refusalOf(c.routes.putBackup(0, encode([1, new Uint8Array(12), new Uint8Array(10)])))).status).toBe(400);
  });

  // Fix wave S (branch review REGISTRATION-DEVICES-03): the enrolled route pays no host login, so it never evicts.
  it('POST /v1/devices refuses 403 at the cap and 429 past the rate, evicting nothing and writing nothing', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const token = server.log.at(-1)?.auth ?? null;
    const post = async (d: Uint8Array) =>
      raw(server, 'POST', '/v1/devices', token, devicePostBody(d, fakeDskPub(d), (await c.routes.postChallenge(d)).nonce));
    const dev = (n: number) => new Uint8Array(16).fill(0x50 + n);
    // An unlisted row the assertion path would replace.
    await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    // Past the rate (DEV_A and DEV_B at NOW_S, rate 2): 429 with the wait until NOW_S's creations leave the hour.
    server.enrolmentsPerHour = 2;
    server.nowS = NOW_S + 100;
    expect(await post(dev(1))).toEqual({ status: 429, body: ['E_RATE_LIMITED', 'rate limited', 3_500_000n] });
    expect([server.devices.has(toHex(dev(1))), server.revoked.size]).toEqual([false, 0]);
    // At the cap (two live rows, one of them unlisted): 403, and DEV_B stays live.
    server.enrolmentsPerHour = 60;
    server.maxDevices = 2;
    expect(await post(dev(2))).toEqual({ status: 403, body: ['E_FORBIDDEN', 'device cap reached', null] });
    expect([server.devices.has(toHex(dev(2))), server.revoked.size]).toEqual([false, 0]);
    // Under both: admitted.
    server.maxDevices = 8;
    expect(await post(dev(3))).toEqual({ status: 200, body: [dev(3)] });
  });

  it('the key-less DELETE refuses 409 an unlisted row younger than 10 minutes unless the caller is that row', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const b = client(server);
    const pending = await b.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    b.use(pending.token);
    const young = await refusalOf(c.routes.deleteDevice(DEV_B));
    expect([young.status, young.code, young.detail]).toEqual([409, 'E_INVALID_REQUEST',
      'the device registered less than 10 minutes ago and is too new to remove; its own session may remove it, or it expires unlisted after 24 hours']);
    server.nowS = NOW_S + 599;
    expect((await refusalOf(c.routes.deleteDevice(DEV_B))).status).toBe(409);
    expect(server.revoked.has(toHex(DEV_B))).toBe(false);
    // At 10 minutes another device's session removes it.
    server.nowS = NOW_S + 600;
    await c.routes.deleteDevice(DEV_B);
    expect(server.revoked.get(toHex(DEV_B))).toBe(NOW_S + 600);
  });

  it('the key-less DELETE lets a young unlisted row remove itself (a user with no list: every row enrolled)', async () => {
    const server = new FakeServer();
    const user = server.register('lee', DEV_A);
    server.devices.set(toHex(DEV_B), toHex(user));
    server.createdAt.set(toHex(DEV_B), NOW_S);
    const a = client(server);
    a.use((await a.routes.postSession(DEV_A, establishBody(DEV_A, null))).token);
    const b = client(server);
    b.use((await b.routes.postSession(DEV_B, establishBody(DEV_B, null))).token);
    expect((await refusalOf(a.routes.deleteDevice(DEV_B))).status).toBe(409);
    await b.routes.deleteDevice(DEV_B);
    expect(server.revoked.get(toHex(DEV_B))).toBe(NOW_S);
  });

  it('identify refuses a provisional session like a pending one', async () => {
    const server = new FakeServer();
    await ada(server);
    server.tokens.set('tok-provisional', toHex(DEV_A));
    server.tokenScope.set('tok-provisional', 2);
    expect(server.identify('tok-provisional')).toEqual({ op: 'error', code: 'E_UNAUTHENTICATED', close: 4003 });
  });

  it('a backup PUT of purged bytes is 410 E_PRUNED while the stored object is still served', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const root = encode([1, new Uint8Array(12).fill(1), new Uint8Array(86).fill(2)]);
    server.putBackupObject(user, 0, root);
    server.prunedBytes.add(createHash('sha256').update(root).digest('hex'));
    const pruned = await refusalOf(c.routes.putBackup(0, root));
    expect([pruned.status, pruned.code, pruned.detail]).toEqual([410, 'E_PRUNED', 'these bytes were removed by the server operator']);
    expect((await c.routes.getBackup(0))?.object).toEqual(root);
  });

  it('a backup PUT whose bytes are deleted under it is 503 E_UNAVAILABLE once, and the retry stores them', async () => {
    const server = new FakeServer();
    const { user } = await ada(server);
    const token = server.log.at(-1)?.auth ?? null;
    const state = encode([1, new Uint8Array(12).fill(5), new Uint8Array(40)]);
    server.bytesDeletedUnderNextUpload.add(createHash('sha256').update(state).digest('hex'));
    expect(await raw(server, 'PUT', '/v1/backups/1/0', token, encode([state]))).toEqual({ status: 503,
      body: ['E_UNAVAILABLE', 'the stored bytes were removed during the upload; send them again', 100n] });
    expect(server.backups.has(`${toHex(user)}/1`)).toBe(false);
    expect((await raw(server, 'PUT', '/v1/backups/1/0', token, encode([state]))).status).toBe(201);
    expect(server.backups.get(`${toHex(user)}/1`)?.object).toEqual(state);
  });

  it('HttpClient retries the 503 of bytes deleted under an upload', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const state = encode([1, new Uint8Array(12).fill(5), new Uint8Array(40)]);
    server.bytesDeletedUnderNextUpload.add(createHash('sha256').update(state).digest('hex'));
    expect((await c.routes.putBackup(1, state)).created).toBe(true);
    expect(server.count('PUT', '/v1/backups/1/0')).toBe(2);
  });

  it('a backup PUT of bytes an attachment references is 409, and nothing is stored', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const state = encode([1, new Uint8Array(12).fill(5), new Uint8Array(40)]);
    server.attachmentBytes.add(createHash('sha256').update(state).digest('hex'));
    const overlap = await refusalOf(c.routes.putBackup(1, state));
    expect([overlap.status, overlap.code, overlap.detail])
      .toEqual([409, 'E_INVALID_REQUEST', 'these bytes are an attachment; a backup object cannot share them']);
    expect(server.backups.has(`${toHex(user)}/1`)).toBe(false);
  });

  it('deleteSessions drops every token of an own device and answers 404 for a device of another user', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const other = server.register('bea', DEV_B);
    expect(toHex(other)).toHaveLength(32);
    expect((await refusalOf(c.routes.deleteSessions(DEV_B))).status).toBe(404);
    await c.routes.deleteSessions(DEV_A);
    expect((await refusalOf(c.routes.listDevices())).status).toBe(401);
  });
});

const CH = new Uint8Array(16).fill(0xc5);
const CH_2 = new Uint8Array(16).fill(0xc6);
const BYTES = new Uint8Array([9, 8, 7, 6, 5]);
const sha = (b: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(b).digest());
const BLOB = sha(BYTES);
const blobPath = (ch: Uint8Array, blob: Uint8Array, tail = ''): string => `/v1/channels/${toHex(ch)}/blobs/${toHex(blob)}${tail}`;
const refKey = (ch: Uint8Array, blob: Uint8Array): string => `${toHex(ch)}:${toHex(blob)}`;

/** A registered user with an enrolled session on `device` (no device list: scope 0). */
async function signedIn(server: FakeServer, name: string, device: Uint8Array) {
  const user = server.register(name, device);
  const c = client(server);
  const s = await c.routes.postSession(device, establishBody(device, null));
  c.use(s.token);
  return { c, user, token: s.token };
}

/** One octet-stream request straight to the model, outside HttpClient (which would wait out a 429). */
async function octet(server: FakeServer, method: string, path: string, token: string, body?: Uint8Array): Promise<{ status: number; body: CborValue }> {
  const response = await server.fetch(`http://127.0.0.1:8453${path}`, { method,
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` }, body: body as BodyInit | undefined });
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, body: bytes.length === 0 ? null : decode(bytes) };
}

describe('FakeServer answers the blob routes as dillad does after web-2b task 4 (L-TS-31, lesson f)', () => {
  it('stores new bytes under a pending reference, answers 201 then 200, and serves them in that channel only', async () => {
    const server = new FakeServer();
    const { c, user } = await signedIn(server, 'ada', DEV_A);
    expect(await c.routes.putBlob(CH, BLOB, BYTES)).toEqual({ created: true, size: 5 });
    expect(server.blobs.get(toHex(BLOB))).toEqual(BYTES);
    expect(server.blobRefs.get(refKey(CH, BLOB))).toEqual({ uploaderUser: toHex(user), confirmed: false, created: NOW_S });
    expect(server.attachmentBytes.has(toHex(BLOB))).toBe(true);
    expect(server.log.find((r) => r.method === 'PUT')?.contentType).toBe('application/octet-stream');
    expect(await c.routes.putBlob(CH, BLOB, BYTES)).toEqual({ created: false, size: 5 });
    expect(await c.routes.getBlob(CH, BLOB)).toEqual(BYTES);
    expect(await c.routes.getBlob(CH_2, BLOB)).toBeNull();
  });

  it('refuses a body that is not octet-stream (415), one that does not hash to its name (422) and one over the cap (413), storing nothing', async () => {
    const server = new FakeServer();
    const { c, token } = await signedIn(server, 'ada', DEV_A);
    expect(await raw(server, 'PUT', blobPath(CH, BLOB), token, BYTES))
      .toEqual({ status: 415, body: ['E_INVALID_REQUEST', 'Content-Type must be application/octet-stream', null] });
    expect(await refusalOf(c.routes.putBlob(CH, new Uint8Array(32).fill(1), BYTES))).toMatchObject({ status: 422, code: 'E_INVALID_REQUEST' });
    server.maxBlobBytes = 4;
    expect(await refusalOf(c.routes.putBlob(CH, BLOB, BYTES))).toMatchObject({ status: 413, code: 'E_TOO_LARGE', detail: 'at most 4 bytes' });
    expect([server.blobs.size, server.blobRefs.size]).toEqual([0, 0]);
  });

  // Attacker statement (L-HTTP-82): only the uploading user can confirm or delete a reference, so nobody else's action
  // can make an honest upload expire or vanish.
  it('lets only the uploading user confirm (204, twice) and answers 403 to another user and 404 without a reference', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    const bob = await signedIn(server, 'bob', DEV_B);
    await ada.c.routes.putBlob(CH, BLOB, BYTES);
    expect(await refusalOf(bob.c.routes.confirmBlob(CH, BLOB))).toMatchObject({ status: 403, code: 'E_NOT_UPLOADER' });
    expect(server.blobRefs.get(refKey(CH, BLOB))?.confirmed).toBe(false);
    await ada.c.routes.confirmBlob(CH, BLOB);
    await ada.c.routes.confirmBlob(CH, BLOB);
    expect(server.blobRefs.get(refKey(CH, BLOB))?.confirmed).toBe(true);
    expect(await refusalOf(ada.c.routes.confirmBlob(CH_2, BLOB))).toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
  });

  it('deletes a reference for its uploading user only, and an absent reference is already gone (204)', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    const bob = await signedIn(server, 'bob', DEV_B);
    await ada.c.routes.putBlob(CH, BLOB, BYTES);
    expect(await refusalOf(bob.c.routes.deleteBlob(CH, BLOB))).toMatchObject({ status: 403, code: 'E_NOT_UPLOADER' });
    await ada.c.routes.deleteBlob(CH, BLOB);
    expect(server.blobRefs.has(refKey(CH, BLOB))).toBe(false);
    expect((await octet(server, 'DELETE', blobPath(CH, BLOB), ada.token)).status).toBe(204);
    expect(await ada.c.routes.getBlob(CH, BLOB)).toBeNull();
  });

  it('answers 404 on every blob route to a user who may not view the channel', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    const bob = await signedIn(server, 'bob', DEV_B);
    server.channelViewers.set(toHex(CH), new Set([toHex(ada.user)]));
    await ada.c.routes.putBlob(CH, BLOB, BYTES);
    for (const [method, tail] of [['PUT', ''], ['GET', ''], ['DELETE', ''], ['POST', '/confirm']] as const) {
      const answer = await octet(server, method, blobPath(CH, BLOB, tail), bob.token, method === 'PUT' ? BYTES : undefined);
      expect(answer, `${method}${tail}`).toEqual({ status: 404, body: ['E_NOT_FOUND', 'no such object', null] });
    }
    expect(server.blobRefs.get(refKey(CH, BLOB))?.uploaderUser).toBe(toHex(ada.user));
  });

  it('answers 410 E_PRUNED for purged bytes on PUT, GET and confirm', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    await ada.c.routes.putBlob(CH, BLOB, BYTES);
    server.prunedBytes.add(toHex(BLOB));
    expect(await refusalOf(ada.c.routes.putBlob(CH, BLOB, BYTES))).toMatchObject({ status: 410, code: 'E_PRUNED' });
    expect(await refusalOf(ada.c.routes.getBlob(CH, BLOB))).toMatchObject({ status: 410, code: 'E_PRUNED' });
    expect(await refusalOf(ada.c.routes.confirmBlob(CH, BLOB))).toMatchObject({ status: 410, code: 'E_PRUNED' });
  });

  it('meters blob uploads on the per-user budget it shares with backups', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    server.uploadsPerMinute = 2;
    expect((await octet(server, 'PUT', blobPath(CH, BLOB), ada.token, BYTES)).status).toBe(201);
    expect((await octet(server, 'PUT', blobPath(CH_2, BLOB), ada.token, BYTES)).status).toBe(200);
    const third = await octet(server, 'PUT', blobPath(CH, BLOB), ada.token, BYTES);
    expect(third.status).toBe(429);
    expect(arr(third.body)[0]).toBe('E_RATE_LIMITED');
  });

  it('answers the next blob request once with an injected refusal', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    server.failNextBlob(507, 'E_STORAGE_FULL');
    expect(await octet(server, 'PUT', blobPath(CH, BLOB), ada.token, BYTES)).toEqual({ status: 507, body: ['E_STORAGE_FULL', '', null] });
    expect(server.blobs.size).toBe(0);
    server.failNextBlob(429, 'E_RATE_LIMITED', 1500);
    expect(await octet(server, 'GET', blobPath(CH, BLOB), ada.token)).toEqual({ status: 429, body: ['E_RATE_LIMITED', '', 1500n] });
    expect((await octet(server, 'PUT', blobPath(CH, BLOB), ada.token, BYTES)).status).toBe(201);
  });

  it('sweeps unconfirmed references older than the ttl and keeps confirmed and younger ones and the bytes', async () => {
    const server = new FakeServer();
    const ada = await signedIn(server, 'ada', DEV_A);
    const other = new Uint8Array([1]);
    const third = new Uint8Array([2]);
    await ada.c.routes.putBlob(CH, BLOB, BYTES);
    await ada.c.routes.putBlob(CH, sha(other), other);
    await ada.c.routes.confirmBlob(CH, sha(other));
    server.nowS += 100;
    await ada.c.routes.putBlob(CH, sha(third), third);
    expect(server.sweepPending(NOW_S + 86_400, 0)).toBe(0);
    expect(server.sweepPending(NOW_S + 86_401, 86_400)).toBe(1);
    expect([...server.blobRefs.keys()].sort()).toEqual([refKey(CH, sha(other)), refKey(CH, sha(third))].sort());
    expect(server.blobs.has(toHex(BLOB))).toBe(true);
  });
});

describe('FakeServer answers the message delete through its delivery-service model (L-HTTP-80, lesson f)', () => {
  it('answers 404 without a model, then 204, 403 and 404 as ModelDs.deleteAs decides', async () => {
    const server = new FakeServer();
    const me = await signedIn(server, 'me', ME.device);
    expect(await raw(server, 'DELETE', `/v1/groups/${'9a'.repeat(16)}/messages/3`, me.token))
      .toEqual({ status: 404, body: ['E_NOT_FOUND', 'no such object', null] });
    const ds = new ModelDs();
    ds.own(ME.user, ME.device);
    ds.own(PEER.user, PEER.device);
    ds.addChannel(COMMUNITY, CHANNEL);
    const g = ds.peerCreate(PEER, CHANNEL);
    ds.join(g, ME.device);
    const mine = ds.peerSend(g, ME, 'mine');
    const theirs = ds.peerSend(g, PEER, 'theirs');
    server.groupDelete = (groupHex, deviceHex, seq) => ds.deleteAs(fromHex(groupHex), fromHex(deviceHex), seq);
    expect(await raw(server, 'DELETE', `/v1/groups/${toHex(g)}/messages/${String(theirs)}`, me.token))
      .toEqual({ status: 403, body: ['E_NOT_UPLOADER', 'only the uploading user may delete this message', null] });
    expect((await raw(server, 'DELETE', `/v1/groups/${toHex(g)}/messages/${String(mine)}`, me.token)).status).toBe(204);
    expect(ds.view(g).messages.map((m) => m.seq)).toEqual([theirs]);
    expect((await raw(server, 'DELETE', `/v1/groups/${toHex(g)}/messages/99`, me.token)).status).toBe(404);
  });
});

// web-3 task 6 (lesson f): the call routes answer through the real Routes as 09 § Voice says dillad does.
describe('FakeServer calls (L-HTTP-100..104)', () => {
  it('answers the snapshot, the start (201 then 200), E_CALL_FULL, and the decline with its 204, 400 and 404', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const dm = new Uint8Array(16).fill(0xd7);
    const voice = new Uint8Array(16).fill(0xc7);
    const group = new Uint8Array(16).fill(0x9d);
    expect(await c.routes.getChannelCall(dm).catch((e: DillaHttpError) => e.code)).toBe('E_NOT_FOUND');
    server.calls.set(toHex(dm), { groupId: group, callId: null, dm: true, participants: [] });
    server.calls.set(toHex(voice), { groupId: group, callId: null, dm: false, participants: [] });
    expect(await c.routes.getChannelCall(dm)).toEqual({ groupId: group, callId: null, participants: [] });
    await expect(c.routes.declineCall(dm, 1700000030)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    expect((await c.routes.startCall(dm, 'vp8')).created).toBe(true);
    expect((await c.routes.startCall(dm, '')).created).toBe(false);
    expect(await c.routes.declineCall(dm, 1700000030)).toBeUndefined();
    expect((await raw(server, 'POST', `/v1/calls/${toHex(dm)}/decline`, [...server.tokens.keys()].at(-1) ?? null, encode([])))).toMatchObject({ status: 400 });
    await c.routes.startCall(voice, '');
    await expect(c.routes.declineCall(voice, 1)).rejects.toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    server.maxVoiceParticipants = 0;
    await expect(c.routes.startCall(voice, '')).rejects.toMatchObject({ status: 409, code: 'E_CALL_FULL' });
    expect(await c.routes.postProposal(group, encode([1, new Uint8Array(4)]))).toEqual({ seq: 1n });
    await c.routes.shareCall(dm);
    await c.routes.unshareCall(dm);
    await c.routes.postCallStats(dm, [0, null, 1, 0, 0, 0]);
  });
});

describe('FakeServer answers the web3.6 second-factor routes as dillad does', () => {
  it('refuses an owed account everywhere but the allow-list; the same account not owed is served', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    expect((await c.routes.listDevices()).length).toBeGreaterThan(0);
    server.setOwed('ada');
    expect(await refusalOf(c.routes.listDevices())).toMatchObject({ status: 403, code: 'E_FACTOR_REQUIRED' });
    expect(await refusalOf(c.routes.postTicket())).toMatchObject({ status: 403, code: 'E_FACTOR_REQUIRED' });
    expect(await c.routes.getFactors()).toMatchObject({ owed: true, totp: null, passkeys: [], backupCodesLeft: 0, hasPassword: true });
    expect((await c.routes.getAccountMe()).username).toBe('ada');
  });

  it('enrols an app: a wrong code is refused, the right one clears the debt and mints ten codes once', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    const enrol = await c.routes.totpEnroll(null);
    expect(enrol.secret).toBe(FAKE_TOTP_SECRET);
    expect(await refusalOf(c.routes.totpConfirm('000000'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    expect(await c.routes.getFactors()).toMatchObject({ owed: true, totp: null });
    const codes = await c.routes.totpConfirm(FAKE_TOTP_CODE);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-Z2-7]{26}$/.test(code))).toBe(true);
    expect(await c.routes.getFactors()).toMatchObject({ owed: false, backupCodesLeft: 10 });
    expect((await c.routes.listDevices()).length).toBeGreaterThan(0);
    expect(await refusalOf(c.routes.totpEnroll(null))).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    const login = await c.routes.passwordLogin('ada', 'pw');
    expect(login.needs).toBe(1);
  });

  it('asks for a step-up once an account holds a factor; a token is single use and bound to its session', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.addPasskey('ada', 'Laptop');
    expect(await refusalOf(c.routes.totpEnroll(null))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.totpEnroll('su-bogus'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const step = await c.routes.stepUp(0, 'pw');
    expect(step.expires).toBe(BigInt(NOW_S + FAKE_STEP_UP_EXPIRES_S));
    expect((await c.routes.totpEnroll(step.token)).secret).toBe(FAKE_TOTP_SECRET);
    expect(await refusalOf(c.routes.totpEnroll(step.token))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const mine = await c.routes.stepUp(0, 'pw');
    const other = client(server);
    const second = await other.routes.postSession(DEV_A, establishBody(DEV_A, null));
    other.use(second.token);
    expect(await refusalOf(other.routes.passkeyRegisterBegin(mine.token))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect((await c.routes.passkeyRegisterBegin(mine.token)).options).toContain('publicKey');
  });

  it('refuses a wrong step-up secret and rate-limits on the fifth (dillad: four free attempts)', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.addPasskey('ada', 'Laptop');
    for (let i = 0; i < 4; i += 1) expect(await refusalOf(c.routes.stepUp(0, 'nope'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.stepUp(0, 'nope'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
    expect(await refusalOf(c.routes.stepUp(0, 'pw'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
  });

  it('steps up with the app code, a backup code and a passkey ceremony', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setPassword('ada', 'pw', FAKE_TOTP_CODE);
    expect((await c.routes.stepUp(1, FAKE_TOTP_CODE)).token).toMatch(/^su-/);
    expect(await refusalOf(c.routes.stepUp(1, '000000'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const [code] = await c.routes.regenerateBackupCodes((await c.routes.stepUp(0, 'pw')).token);
    expect((await c.routes.stepUp(2, code ?? '')).token).toMatch(/^su-/);
    expect(await refusalOf(c.routes.stepUp(2, code ?? ''))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const cred = server.addPasskey('ada', 'Phone');
    const begin = await c.routes.stepUpPasskeyBegin();
    expect((await c.routes.stepUpPasskeyFinish(begin.ceremonyId, toHex(cred))).token).toMatch(/^su-/);
    const again = await c.routes.stepUpPasskeyBegin();
    expect(await refusalOf(c.routes.stepUpPasskeyFinish(again.ceremonyId, 'ff'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.stepUpPasskeyFinish(again.ceremonyId, toHex(cred)))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
  });

  it('registers a passkey, signs in with it, and says E_PASSKEY_UNKNOWN for one it does not hold', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    const begin = await c.routes.passkeyRegisterBegin(null);
    const done = await c.routes.passkeyRegisterFinish(begin.ceremonyId, '{}', 'Laptop');
    expect(done.backupCodes).toHaveLength(10);
    expect(await c.routes.getFactors()).toMatchObject({ owed: false, passkeys: [{ credId: done.credId, name: 'Laptop', lastUsed: null }] });
    const anon = client(server);
    const loginBegin = await anon.routes.passkeyLoginBegin();
    const finished = await anon.routes.passkeyLoginFinish(loginBegin.ceremonyId, toHex(done.credId));
    expect(finished.needs).toBe(0);
    expect((await anon.routes.postSessionPending(DEV_B, establishBody(DEV_B, finished.assertion))).scope).toBe(1);
    const noUv = await anon.routes.passkeyLoginFinish((await anon.routes.passkeyLoginBegin()).ceremonyId, `${toHex(done.credId)}:nouv`);
    expect(noUv.needs).toBe(1);
    const stranger = new Uint8Array(16).fill(8);
    expect(await refusalOf(anon.routes.postSessionPending(stranger, establishBody(stranger, noUv.assertion)))).toMatchObject({ status: 401 });
    expect(await refusalOf(anon.routes.passkeyLoginFinish((await anon.routes.passkeyLoginBegin()).ceremonyId, 'ee')))
      .toMatchObject({ status: 401, code: 'E_PASSKEY_UNKNOWN' });
    expect(await refusalOf(anon.routes.passkeyLoginFinish(loginBegin.ceremonyId, toHex(done.credId))))
      .toMatchObject({ status: 401, code: 'E_UNAUTHENTICATED' });
  });

  it('takes a backup code for an assertion that owes needs 1 or 2, once', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.addPasskey('ada', 'Laptop');
    const [one, two] = await c.routes.regenerateBackupCodes((await c.routes.stepUp(0, 'pw')).token);
    const owes2 = await c.routes.passwordLogin('ada', 'pw');
    expect(owes2.needs).toBe(2);
    expect((await c.routes.recoveryVerify(owes2.assertion, one ?? '')).assertion).toMatch(/^asrt-/);
    const again = await c.routes.passwordLogin('ada', 'pw');
    expect(await refusalOf(c.routes.recoveryVerify(again.assertion, one ?? ''))).toMatchObject({ status: 401 });
    server.setPassword('ada', 'pw', FAKE_TOTP_CODE);
    const owes1 = await c.routes.passwordLogin('ada', 'pw');
    expect(owes1.needs).toBe(1);
    expect((await c.routes.recoveryVerify(owes1.assertion, two ?? '')).assertion).toMatch(/^asrt-/);
    expect(server.backupCodesOf('ada')).toHaveLength(8);
  });

  it('removes a factor with a step-up while another remains, never the last, and says 404 for a stranger', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const cred = server.addPasskey('ada', 'Laptop');
    const token = async (): Promise<string> => (await c.routes.stepUp(0, 'pw')).token;
    expect(await refusalOf(c.routes.removeFactor(await token(), 1, cred))).toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    expect((await c.routes.getFactors()).passkeys).toHaveLength(1);
    expect(await refusalOf(c.routes.removeFactor('su-bogus', 1, cred))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    server.setPassword('ada', 'pw', FAKE_TOTP_CODE);
    expect(await refusalOf(c.routes.removeFactor(await token(), 1, new Uint8Array(32).fill(1)))).toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    await c.routes.removeFactor(await token(), 1, cred);
    expect((await c.routes.getFactors()).passkeys).toEqual([]);
    expect(await refusalOf(c.routes.removeFactor(await token(), 0, null))).toMatchObject({ status: 409 });
    expect((await c.routes.getFactors()).totp).not.toBeNull();
  });

  it('makes ten new backup codes and the old ones stop working', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.addPasskey('ada', 'Laptop');
    const first = await c.routes.regenerateBackupCodes((await c.routes.stepUp(0, 'pw')).token);
    const second = await c.routes.regenerateBackupCodes((await c.routes.stepUp(0, 'pw')).token);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(second.filter((code) => first.includes(code))).toEqual([]);
    expect(await refusalOf(c.routes.regenerateBackupCodes('su-bogus'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await c.routes.getFactors()).toMatchObject({ backupCodesLeft: 10 });
  });
});

// C1 review B2 and B3: the fake refuses exactly where dillad does, so a web test cannot pass on leniency.
describe('FakeServer refuses the second-factor routes as strictly as dillad', () => {
  /** A pending (scope 1) token on ada's own device, planted as the fake mints none for a listed device. */
  function pending(server: FakeServer): ReturnType<typeof client> {
    server.tokens.set('tok-pending', toHex(DEV_A));
    server.tokenScope.set('tok-pending', 1);
    const p = client(server);
    p.use('tok-pending');
    return p;
  }

  it('refuses a pending session on the enrolled-only factor routes; the enrolled session is served', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const cred = server.addPasskey('ada', 'Laptop');
    server.addPasskey('ada', 'Phone');
    const p = pending(server);
    const forbidden = { status: 403, code: 'E_FORBIDDEN' };
    expect(await refusalOf(p.routes.stepUp(0, 'pw'))).toMatchObject(forbidden);
    expect(await refusalOf(p.routes.getFactors())).toMatchObject(forbidden);
    expect(await refusalOf(p.routes.passkeyRegisterBegin(null))).toMatchObject(forbidden);
    const token = (await c.routes.stepUp(0, 'pw')).token;
    expect(await refusalOf(p.routes.totpEnroll(token))).toMatchObject(forbidden);
    expect(await refusalOf(p.routes.regenerateBackupCodes(token))).toMatchObject(forbidden);
    expect(await refusalOf(p.routes.removeFactor(token, 1, cred))).toMatchObject(forbidden);
    // Control: the same token on its own enrolled session is served, unspent by the refusals above.
    await c.routes.removeFactor(token, 1, cred);
    expect((await c.routes.getFactors()).passkeys).toHaveLength(1);
  });

  it('answers an owed account by scope: a pending token is E_FORBIDDEN, the enrolled one E_FACTOR_REQUIRED', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    const p = pending(server);
    expect(await refusalOf(p.routes.listDevices())).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect(await refusalOf(p.routes.totpEnroll(null))).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect(await refusalOf(c.routes.listDevices())).toMatchObject({ status: 403, code: 'E_FACTOR_REQUIRED' });
    expect((await c.routes.totpEnroll(null)).secret).toBe(FAKE_TOTP_SECRET);
  });

  it('confirms only an enrolled secret, once: no enrol is 404, a wrong code 400, a second confirm 404', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    expect(await refusalOf(c.routes.totpConfirm(FAKE_TOTP_CODE))).toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    expect(await c.routes.getFactors()).toMatchObject({ owed: true, totp: null });
    await c.routes.totpEnroll(null);
    expect(await refusalOf(c.routes.totpConfirm('000000'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    expect(await c.routes.totpConfirm(FAKE_TOTP_CODE)).toHaveLength(10);
    expect(await refusalOf(c.routes.totpConfirm(FAKE_TOTP_CODE))).toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
  });

  it('burns an app code on use: a replayed code is refused, the next code is accepted', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    await c.routes.totpEnroll(null);
    await c.routes.totpConfirm(FAKE_TOTP_CODE);
    // The code that confirmed the app cannot also step up.
    expect(await refusalOf(c.routes.stepUp(1, FAKE_TOTP_CODE))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const now = server.totpCodeNow('ada') ?? '';
    expect(now).not.toBe(FAKE_TOTP_CODE);
    expect((await c.routes.stepUp(1, now)).token).toMatch(/^su-/);
    expect(await refusalOf(c.routes.stepUp(1, now))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    const login = await c.routes.passwordLogin('ada', 'pw');
    expect(await refusalOf(c.routes.totpVerify(login.assertion, now))).toMatchObject({ status: 401 });
    const again = await c.routes.passwordLogin('ada', 'pw');
    expect((await c.routes.totpVerify(again.assertion, server.totpCodeNow('ada') ?? '')).assertion).toMatch(/^asrt-/);
  });

  it('re-checks the step-up rule at confirm and finish: a factor added since an unstepped begin is E_STEP_UP', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    await c.routes.totpEnroll(null);
    const register = await c.routes.passkeyRegisterBegin(null);
    // Another device registers a passkey meanwhile, which clears the debt there.
    server.addPasskey('ada', 'Other device');
    server.setOwed('ada', false);
    expect(await refusalOf(c.routes.totpConfirm(FAKE_TOTP_CODE))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.passkeyRegisterFinish(register.ceremonyId, '{}', 'Laptop'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await c.routes.getFactors()).toMatchObject({ totp: null, passkeys: [{ name: 'Other device' }] });
    // Control: the same ceremonies begun with a step-up are served.
    await c.routes.totpEnroll((await c.routes.stepUp(0, 'pw')).token);
    expect(await c.routes.totpConfirm(FAKE_TOTP_CODE)).toHaveLength(10);
    const stepped = await c.routes.passkeyRegisterBegin((await c.routes.stepUp(0, 'pw')).token);
    expect((await c.routes.passkeyRegisterFinish(stepped.ceremonyId, '{}', 'Laptop')).backupCodes).toEqual([]);
  });

  it('an unstepped begin with no factor held meanwhile is served (control)', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setOwed('ada');
    const register = await c.routes.passkeyRegisterBegin(null);
    expect((await c.routes.passkeyRegisterFinish(register.ceremonyId, '{}', 'Laptop')).backupCodes).toHaveLength(10);
  });
});

// The S2 review's wire-mismatch list: dillad (auth.go, session.go) is the authority.
describe('FakeServer answers the second-factor edges as dillad does (S2 review)', () => {
  const plant = (server: FakeServer, token: string, scope: 1 | 2): ReturnType<typeof client> => {
    server.tokens.set(token, toHex(DEV_A));
    server.tokenScope.set(token, scope);
    const p = client(server);
    p.use(token);
    return p;
  };

  it('stepup/passkey/begin for an account without a passkey is 400 E_INVALID_REQUEST; with one it begins', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    expect(await refusalOf(c.routes.stepUpPasskeyBegin())).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    server.addPasskey('ada', 'Laptop');
    expect((await c.routes.stepUpPasskeyBegin()).options).toContain('publicKey');
  });

  it('register/finish checks the name first and keeps the ceremony; a bad or foreign ceremony is 400', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const begin = await c.routes.passkeyRegisterBegin(null);
    const badName = (name: string) => raw(server, 'POST', '/v1/auth/passkey/register/finish', [...server.tokens.keys()][0] ?? null,
      encode([begin.ceremonyId, '{}', name]));
    expect((await badName('')).status).toBe(400);
    expect((await badName('Lap\u0007top')).status).toBe(400);
    expect((await badName('x'.repeat(65))).status).toBe(400);
    // The refused names did not spend the ceremony.
    expect((await c.routes.passkeyRegisterFinish(begin.ceremonyId, '{}', 'Laptop')).backupCodes).toHaveLength(10);
    // Spent, unknown and another account's ceremonies are one answer: 400 E_INVALID_REQUEST.
    expect(await refusalOf(c.routes.passkeyRegisterFinish(begin.ceremonyId, '{}', 'Phone'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    expect(await refusalOf(c.routes.passkeyRegisterFinish(new Uint8Array(16).fill(9), '{}', 'Phone'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    const bea = client(server);
    server.register('bea', DEV_B);
    bea.use((await bea.routes.postSession(DEV_B, establishBody(DEV_B, null))).token);
    const foreign = await bea.routes.passkeyRegisterBegin(null);
    const step = await c.routes.stepUp(0, 'pw');
    const mine = await c.routes.passkeyRegisterBegin(step.token);
    expect(await refusalOf(c.routes.passkeyRegisterFinish(foreign.ceremonyId, '{}', 'Phone'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    // Control: the account's own ceremony with the same name is served.
    expect((await c.routes.passkeyRegisterFinish(mine.ceremonyId, '{}', 'Phone')).backupCodes).toEqual([]);
  });

  it('a successful step-up does not clear the account-wide count: it ages out over 15 minutes', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    for (let i = 0; i < 4; i += 1) await refusalOf(c.routes.stepUp(0, 'nope'));
    expect((await c.routes.stepUp(0, 'pw')).token).toMatch(/^su-/);
    expect(await refusalOf(c.routes.stepUp(0, 'nope'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
    // Control: once the failures are older than the window, a wrong secret is a plain 403 again and the right one serves.
    server.nowS += 901;
    expect(await refusalOf(c.routes.stepUp(0, 'nope'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect((await c.routes.stepUp(0, 'pw')).token).toMatch(/^su-/);
  });

  it('passkey step-up failures charge the same ledger: the fifth failure of either kind is 429, and so is any attempt after', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const cred = server.addPasskey('ada', 'Laptop');
    for (let i = 0; i < 3; i += 1) expect(await refusalOf(c.routes.stepUp(0, 'nope'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.stepUpPasskeyFinish((await c.routes.stepUpPasskeyBegin()).ceremonyId, 'ff'))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
    expect(await refusalOf(c.routes.stepUpPasskeyFinish((await c.routes.stepUpPasskeyBegin()).ceremonyId, 'ff'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
    expect(await refusalOf(c.routes.stepUpPasskeyFinish((await c.routes.stepUpPasskeyBegin()).ceremonyId, toHex(cred)))).toMatchObject({ status: 429 });
    expect(await refusalOf(c.routes.stepUp(0, 'pw'))).toMatchObject({ status: 429 });
    // Control: another account's ledger is its own.
    const other = new FakeServer();
    const o = await ada(other);
    const key = other.addPasskey('ada', 'Laptop');
    expect((await o.c.routes.stepUpPasskeyFinish((await o.c.routes.stepUpPasskeyBegin()).ceremonyId, toHex(key))).token).toMatch(/^su-/);
  });

  it('an owed provisional session is refused E_FACTOR_REQUIRED on the E-or-V routes; not owed it is served', async () => {
    const server = new FakeServer();
    await ada(server);
    const p = plant(server, 'tok-provisional', 2);
    server.setOwed('ada');
    expect(await refusalOf(p.routes.postKeyPackages(encode([[new Uint8Array(4)], null])))).toMatchObject({ status: 403, code: 'E_FACTOR_REQUIRED' });
    server.setOwed('ada', false);
    await p.routes.postKeyPackages(encode([[new Uint8Array(4)], null]));
    expect(server.keyPackages).toHaveLength(1);
  });

  it('a provisional session on a factor route is E_PROVISIONAL_OUTSIDE_PAIRING, a pending one E_FORBIDDEN', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    expect(await refusalOf(plant(server, 'tok-provisional', 2).routes.getFactors())).toMatchObject({ status: 403, code: 'E_PROVISIONAL_OUTSIDE_PAIRING' });
    expect(await refusalOf(plant(server, 'tok-pending', 1).routes.getFactors())).toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    expect((await c.routes.getFactors()).owed).toBe(false);
  });

  it('factors/remove checks kind before it spends the token', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const cred = server.addPasskey('ada', 'Laptop');
    server.addPasskey('ada', 'Phone');
    const token = (await c.routes.stepUp(0, 'pw')).token;
    const session = [...server.tokens.keys()][0] ?? null;
    expect((await raw(server, 'POST', '/v1/auth/factors/remove', session, encode([token, 2, null]))).status).toBe(400);
    expect((await raw(server, 'POST', '/v1/auth/factors/remove', session, encode([token, 1, null]))).status).toBe(400);
    // Control: the same token, unspent, removes the passkey.
    await c.routes.removeFactor(token, 1, cred);
    expect((await c.routes.getFactors()).passkeys).toHaveLength(1);
  });

  it('kind 0 removes an unconfirmed app enrolment too (204); with no app row at all it is 404', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.addPasskey('ada', 'Laptop');
    expect(await refusalOf(c.routes.removeFactor((await c.routes.stepUp(0, 'pw')).token, 0, null))).toMatchObject({ status: 404 });
    await c.routes.totpEnroll((await c.routes.stepUp(0, 'pw')).token);
    await c.routes.removeFactor((await c.routes.stepUp(0, 'pw')).token, 0, null);
    // The enrolment is gone: its confirm finds nothing.
    expect(await refusalOf(c.routes.totpConfirm(FAKE_TOTP_CODE))).toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
  });

  it('totp/enroll, passkey/register/begin and recovery/codes take exactly [stepup|null]: [] is 400', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const session = [...server.tokens.keys()][0] ?? null;
    for (const path of ['/v1/auth/totp/enroll', '/v1/auth/passkey/register/begin', '/v1/auth/recovery/codes']) {
      expect((await raw(server, 'POST', path, session, encode([]))).status).toBe(400);
    }
    // Control: [null] is served for an account without a factor.
    expect((await raw(server, 'POST', '/v1/auth/totp/enroll', session, encode([null]))).status).toBe(200);
    expect((await raw(server, 'POST', '/v1/auth/passkey/register/begin', session, encode([null]))).status).toBe(200);
    expect(await c.routes.getFactors()).toMatchObject({ totp: null });
  });
});

// The server's guess caps (w3-srv 9bbde5c8): every guess at a second factor is capped per account.
describe('FakeServer caps guesses as dillad does', () => {
  const sessionOf = (server: FakeServer): string | null => [...server.tokens.keys()][0] ?? null;
  const changePassword = (server: FakeServer, old: string | null, next: string) =>
    raw(server, 'POST', '/v1/auth/password', sessionOf(server), encode([old, next]));
  /** Five wrong password logins: the account's login ledger locks on the fifth. */
  async function lockLogin(c: ReturnType<typeof client>): Promise<void> {
    for (let i = 0; i < 4; i += 1) expect(await refusalOf(c.routes.passwordLogin('ada', 'nope'))).toMatchObject({ status: 401 });
    expect(await refusalOf(c.routes.passwordLogin('ada', 'nope'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
  }

  it('POST /v1/auth/password: a wrong old password is 403 on the step-up ledgers; the fifth is 429, then the right one too', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    for (let i = 0; i < 4; i += 1) expect(await changePassword(server, 'nope', 'new pw')).toMatchObject({ status: 403, body: ['E_FORBIDDEN', 'the old password is wrong', null] });
    expect((await changePassword(server, 'nope', 'new pw')).status).toBe(429);
    expect((await changePassword(server, 'pw', 'new pw')).status).toBe(429);
    // The same ledgers as the step-ups; the owner's login ledger is untouched and nothing changed.
    expect(await refusalOf(c.routes.stepUp(0, 'pw'))).toMatchObject({ status: 429 });
    expect((await c.routes.passwordLogin('ada', 'pw')).needs).toBe(0);
  });

  it('POST /v1/auth/password with the right old password changes it (204); without one, or with an empty new one, it is refused', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    expect((await changePassword(server, null, 'new pw')).status).toBe(403);
    expect((await changePassword(server, 'pw', '')).status).toBe(400);
    expect((await changePassword(server, 'pw', 'new pw')).status).toBe(204);
    expect((await c.routes.passwordLogin('ada', 'new pw')).needs).toBe(0);
    expect(await refusalOf(c.routes.passwordLogin('ada', 'pw'))).toMatchObject({ status: 401 });
  });

  it('/totp/verify and /recovery/verify answer 429 while the account is locked, and the assertion is spent', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setPassword('ada', 'pw', FAKE_TOTP_CODE);
    server.factorsOf('ada').codes = ['A'.repeat(26)];
    const forCode = await c.routes.passwordLogin('ada', 'pw');
    const forBackup = await c.routes.passwordLogin('ada', 'pw');
    expect(forCode.needs).toBe(1);
    await lockLogin(c);
    expect(await refusalOf(c.routes.totpVerify(forCode.assertion, FAKE_TOTP_CODE))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
    expect(await refusalOf(c.routes.recoveryVerify(forBackup.assertion, 'A'.repeat(26)))).toMatchObject({ status: 429 });
    server.nowS += 901;
    // Spent: the same assertions are refused once the lockout is over.
    expect(await refusalOf(c.routes.totpVerify(forCode.assertion, FAKE_TOTP_CODE))).toMatchObject({ status: 401 });
    expect(await refusalOf(c.routes.recoveryVerify(forBackup.assertion, 'A'.repeat(26)))).toMatchObject({ status: 401 });
    // Control: unlocked, a fresh assertion takes the code and the backup code.
    expect((await c.routes.totpVerify((await c.routes.passwordLogin('ada', 'pw')).assertion, FAKE_TOTP_CODE)).assertion).toMatch(/^asrt-/);
    expect((await c.routes.recoveryVerify((await c.routes.passwordLogin('ada', 'pw')).assertion, 'A'.repeat(26))).assertion).toMatch(/^asrt-/);
  });

  it('wrong second-factor codes charge the account ledger: the fifth is 429', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.setPassword('ada', 'pw', FAKE_TOTP_CODE);
    for (let i = 0; i < 4; i += 1) {
      expect(await refusalOf(c.routes.totpVerify((await c.routes.passwordLogin('ada', 'pw')).assertion, '000000'))).toMatchObject({ status: 401 });
    }
    expect(await refusalOf(c.routes.totpVerify((await c.routes.passwordLogin('ada', 'pw')).assertion, '000000'))).toMatchObject({ status: 429 });
    expect(await refusalOf(c.routes.passwordLogin('ada', 'pw'))).toMatchObject({ status: 429 });
  });

  it('passkey/login/finish is 429 with no assertion when the login would owe a code while locked; a verified one serves and clears', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const cred = server.addPasskey('ada', 'Laptop');
    const anon = client(server);
    await lockLogin(c);
    const issued = server.assertions.length;
    expect(await refusalOf(anon.routes.passkeyLoginFinish((await anon.routes.passkeyLoginBegin()).ceremonyId, `${toHex(cred)}:nouv`)))
      .toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
    expect(server.assertions).toHaveLength(issued);
    // Control: a passkey that verified the user owes nothing, is served, and clears the account's ledger.
    expect((await anon.routes.passkeyLoginFinish((await anon.routes.passkeyLoginBegin()).ceremonyId, toHex(cred))).needs).toBe(0);
    expect((await c.routes.passwordLogin('ada', 'pw')).needs).toBe(2);
  });

  it('step-up failures from other addresses count on the account-wide ledger', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    server.stepUpFailuresElsewhere('ada', 4);
    // Control: four elsewhere leave this address its guess.
    expect((await c.routes.stepUp(0, 'pw')).token).toMatch(/^su-/);
    server.stepUpFailuresElsewhere('ada', 1);
    expect(await refusalOf(c.routes.stepUp(0, 'pw'))).toMatchObject({ status: 429, code: 'E_RATE_LIMITED' });
  });

  it('at 1024 passkeys register/begin (before the token is spent) and register/finish are 409', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    for (let i = 0; i < 1023; i += 1) server.addPasskey('ada', `key ${String(i)}`);
    const step = (await c.routes.stepUp(0, 'pw')).token;
    const open = await c.routes.passkeyRegisterBegin(step);
    server.addPasskey('ada', 'the 1024th');
    const token = (await c.routes.stepUp(0, 'pw')).token;
    expect(await refusalOf(c.routes.passkeyRegisterBegin(token))).toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    expect(await refusalOf(c.routes.passkeyRegisterFinish(open.ceremonyId, '{}', 'one more'))).toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    // Control: the token the capped begin refused is unspent, and below the cap a ceremony finishes.
    await c.routes.removeFactor(token, 1, server.factorsOf('ada').passkeys[0].credId);
    const again = await c.routes.passkeyRegisterBegin((await c.routes.stepUp(0, 'pw')).token);
    expect((await c.routes.passkeyRegisterFinish(again.ceremonyId, '{}', 'one more')).credId.length).toBeGreaterThan(0);
  });

  it('register/finish with another account\'s ceremony is 400 and leaves it for its own account to finish', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);
    const bea = client(server);
    server.register('bea', DEV_B);
    bea.use((await bea.routes.postSession(DEV_B, establishBody(DEV_B, null))).token);
    const theirs = await bea.routes.passkeyRegisterBegin(null);
    expect(await refusalOf(c.routes.passkeyRegisterFinish(theirs.ceremonyId, '{}', 'Phone'))).toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    expect((await bea.routes.passkeyRegisterFinish(theirs.ceremonyId, '{}', 'Phone')).backupCodes).toHaveLength(10);
  });
});

// web3.7 3f: POST /v1/auth/password is [old|null, new, stepup?] as dillad decodes it, and a first password on an
// account holding a factor spends a step-up token.
describe('FakeServer sets a first password behind a step-up as dillad does', () => {
  const BACKUP = 'B'.repeat(26);
  /** An enrolled session for an account without a password (a passkey sign-up). */
  async function noPassword(server: FakeServer): Promise<{ c: ReturnType<typeof client>; session: string | null }> {
    const user = server.register('cy', DEV_A);
    const c = client(server);
    const a = await c.routes.postSession(DEV_A, establishBody(DEV_A, null));
    c.use(a.token);
    await c.routes.putDeviceList(user, listBody(user, 1n, [{ deviceId: DEV_A, revokedAt: null }]));
    return { c, session: a.token };
  }
  const setFirst = (server: FakeServer, session: string | null, body: CborValue[]) =>
    raw(server, 'POST', '/v1/auth/password', session, encode(body));

  it('a first password on an account holding a factor needs a valid step-up (403 E_STEP_UP); with one it is set and the token spent', async () => {
    const server = new FakeServer();
    const { c, session } = await noPassword(server);
    server.addPasskey('cy', 'Laptop');
    server.factorsOf('cy').codes = [BACKUP];
    for (const body of [[null, 'new pw'], [null, 'new pw', null], [null, 'new pw', 'su-not-a-token']] as CborValue[][]) {
      expect(await setFirst(server, session, body)).toMatchObject({ status: 403, body: ['E_STEP_UP', '', null] });
    }
    expect(await refusalOf(c.routes.passwordLogin('cy', 'new pw'))).toMatchObject({ status: 401 });
    const token = (await c.routes.stepUp(2, BACKUP)).token;
    expect((await setFirst(server, session, [null, 'new pw', token])).status).toBe(204);
    expect((await c.routes.passwordLogin('cy', 'new pw')).needs).toBe(2);
    // Spent: the same token does not stand in for a step-up again.
    expect(await refusalOf(c.routes.regenerateBackupCodes(token))).toMatchObject({ status: 403, code: 'E_STEP_UP' });
  });

  it('the two-element body is still served, and a third element is ignored when a password exists', async () => {
    const server = new FakeServer();
    const { c, session } = await noPassword(server);
    // An account holding no factor: [null, new] sets the first password, no step-up asked.
    expect((await setFirst(server, session, [null, 'first pw'])).status).toBe(204);
    expect((await setFirst(server, session, ['first pw', 'second pw', null])).status).toBe(204);
    expect((await setFirst(server, session, ['second pw', 'third pw', 'su-not-a-token'])).status).toBe(204);
    expect((await c.routes.passwordLogin('cy', 'third pw')).needs).toBe(0);
    // Four elements are not a body dillad decodes.
    expect((await setFirst(server, session, ['third pw', 'fourth pw', null, null])).status).toBe(400);
  });
});
