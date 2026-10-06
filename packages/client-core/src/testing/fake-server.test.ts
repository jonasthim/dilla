import { describe, expect, it } from 'vitest';
import { arr, decode, encode, str, u64 } from '../cbor';
import { toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import type { Routes } from '../http/routes';
import { fakeListBlob } from './fake-list';
import { FakeServer, NOW_S, routesFor } from './fake-server';

const DEV_A = new Uint8Array(16).fill(0xa1);
const DEV_B = new Uint8Array(16).fill(0xb1);

function client(server: FakeServer): { routes: Routes; use(token: string | null): void } {
  const holder: { token: string | null } = { token: null };
  const routes = routesFor(server, { token: () => holder.token, reauthenticate: () => Promise.resolve(false) });
  return { routes, use(token) { holder.token = token; } };
}

function listBody(user: Uint8Array, v: bigint, entries: { deviceId: Uint8Array; revokedAt: bigint | null }[]): Uint8Array {
  return encode([v, fakeListBlob(user, entries, 1n), new Uint8Array(64), new Uint8Array(32)]);
}

/** An establish body: the registration array and the login when login is set, else a credential bstr and null. */
function establishBody(device: Uint8Array, login: string | null): Uint8Array {
  return encode([new Uint8Array(32), 0, new Uint8Array(64),
    login === null ? new Uint8Array([1]) : [device, new Uint8Array(32), 1, 1, new Uint8Array([2])],
    login === null ? null : new TextEncoder().encode(login)]);
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
    expect(login.needsTotp).toBe(false);
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
    expect(first.needsTotp).toBe(true);
    expect((await refusalOf(c.routes.postSessionPending(DEV_B, establishBody(DEV_B, first.assertion)))).status).toBe(401);
    const second = await c.routes.passwordLogin('ada', 'pw');
    expect((await refusalOf(c.routes.totpVerify(second.assertion, '000000'))).status).toBe(401);
    const third = await c.routes.passwordLogin('ada', 'pw');
    const cleared = await c.routes.totpVerify(third.assertion, '123456');
    expect((await c.routes.postSessionPending(DEV_B, establishBody(DEV_B, cleared.assertion))).scope).toBe(1);
  });

  it('counts the enrolment rate with the server arithmetic, the first device included, and caps live devices', async () => {
    const server = new FakeServer();
    const { c } = await ada(server);   // DEV_A created at NOW_S counts (ruling 32)
    server.enrolmentsPerHour = 2;
    const dev = (n: number) => new Uint8Array(16).fill(0x40 + n);
    const enrol = async (d: Uint8Array) => c.routes.postSessionPending(d, establishBody(d, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    expect((await enrol(dev(1))).scope).toBe(1);   // creations [NOW_S, NOW_S] afterwards
    const limited = await refusalOf(enrol(dev(2)));
    expect([limited.status, limited.code, limited.retryAfterMs]).toEqual([429, 'E_RATE_LIMITED', 3_600_000]);
    // One second inside the window: since = nowS − 3599 = NOW_S still counts both creations. Read raw: through
    // Routes the HttpClient would retry a 1000 ms 429 (RETRY.maxWaitMs 60000) with the already spent assertion.
    server.nowS = NOW_S + 3599;
    const edge = await server.fetch(`http://127.0.0.1:8453/v1/devices/${toHex(dev(2))}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/cbor' },
      body: establishBody(dev(2), (await c.routes.passwordLogin('ada', 'pw')).assertion) as BodyInit,
    });
    expect(edge.status).toBe(429);
    const refusalBody = arr(decode(new Uint8Array(await edge.arrayBuffer())));
    expect([str(refusalBody[0] ?? null), u64(refusalBody[2] ?? null)]).toEqual(['E_RATE_LIMITED', 1000n]);
    // The boundary second: a creation leaves the window exactly 3600 s after it.
    server.nowS = NOW_S + 3600;
    server.maxDevices = 3;
    expect((await enrol(dev(2))).scope).toBe(1);
    const capped = await refusalOf(enrol(dev(3)));
    expect([capped.status, capped.code, capped.detail]).toEqual([403, 'E_FORBIDDEN', 'device cap reached']);
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

  it('DELETE /v1/devices/{id} revokes an own unlisted row and drops its tokens', async () => {
    const server = new FakeServer();
    const { c, user } = await ada(server);
    const anon = client(server);
    const pending = await anon.routes.postSessionPending(DEV_B, establishBody(DEV_B, (await c.routes.passwordLogin('ada', 'pw')).assertion));
    anon.use(pending.token);
    expect(server.tokenScope.get(pending.token)).toBe(1);
    expect(await anon.routes.listBackups()).toEqual([]);
    await c.routes.deleteDevice(DEV_B);
    expect((await refusalOf(anon.routes.listBackups())).status).toBe(401);
    expect((await c.routes.listDevices()).map((d) => [d.id, d.revokedAt])).toEqual([[DEV_A, null], [DEV_B, BigInt(NOW_S)]]);
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
