import { createHash } from 'node:crypto';
import { arr, bin, decode, encode, str, u64, type CborInput } from '../cbor';
import { Session } from '../account/session';
import type { CorePort } from '../core-port';
import { fromHex, toHex } from '../hex';
import { HttpClient } from '../http/client';
import { Routes } from '../http/routes';
import { fakeListBlob, fakeListNames, readFakeList } from './fake-list';

/** The fixed clock of every account test, in unix seconds. */
export const NOW_S = 1_800_000_000;
export const SESSION_S = 604_800;
export const IDLE_S = 43_200;
/** The nonce of the first challenge; challenge k (1-based) answers nonceAt(k), so every challenge is fresh. */
export const NONCE = new Uint8Array(32).fill(0x6e);
export function nonceAt(k: number): Uint8Array {
  const nonce = NONCE.slice();
  nonce[0] = 0x6e + k - 1;
  return nonce;
}

export interface LoggedRequest { method: string; path: string; query: string; auth: string | null; body: Uint8Array }
export type Reply = { status: number; body?: CborInput } | 'network' | 'lose';
interface Account { userId: Uint8Array; username: string; display: string }

function reply(status: number, body?: CborInput): Response {
  if (body === undefined) return new Response(null, { status, headers: { 'X-Dilla-Generation': '1' } });
  return new Response(new Uint8Array(encode(body)), {
    status,
    headers: { 'Content-Type': 'application/cbor', 'X-Dilla-Generation': '1' },
  });
}

function refuse(status: number, code: string, detail = '', retryAfterMs: number | null = null): Response {
  return reply(status, [code, detail, retryAfterMs]);
}
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** An in-memory model of the account routes of dillad, answering through fetch. */
export class FakeServer {
  readonly log: LoggedRequest[] = [];
  readonly invites = new Set<string>(['INVITE']);
  readonly accounts = new Map<string, Account>();
  readonly devices = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  readonly deviceLists = new Map<string, { version: bigint; blob: Uint8Array }>();
  readonly keyPackages: { device: string; count: number; lastResort: boolean }[] = [];
  scope: 0 | 1 | null = null;
  readonly passwords = new Map<string, { password: string; totp: string | null }>();
  readonly assertions = new Map<string, { user: string; needsTotp: boolean }>();
  readonly backups = new Map<string, { object: Uint8Array; created: bigint }>();
  readonly listHistory = new Map<string, { version: bigint; blob: Uint8Array; sig: Uint8Array; prev: Uint8Array }[]>();
  readonly revoked = new Map<string, number>();
  readonly createdAt = new Map<string, number>();
  readonly tiers = new Map<string, 0 | 1>();
  readonly tokenScope = new Map<string, 0 | 1>();
  nowS = NOW_S;
  maxDevices = 8;
  enrolmentsPerHour = 3;
  private users = 0;
  private sessions = 0;
  private challenges = 0;
  private assertionN = 0;
  private readonly overrides: { method: string; path: string; reply: Reply }[] = [];

  /** The next request with this method and path gets `answer` instead of the model's. */
  once(method: string, path: string, answer: Reply): void {
    this.overrides.push({ method, path, reply: answer });
  }

  count(method: string, path: string): number {
    return this.log.filter((r) => r.method === method && r.path === path).length;
  }

  paths(): string[] {
    return this.log.map((r) => `${r.method} ${r.path}`);
  }
  setPassword(username: string, password: string, totp: string | null = null): void {
    this.passwords.set(username, { password, totp });
  }
  publishList(userId: Uint8Array, entries: readonly { deviceId: Uint8Array; revokedAt?: bigint | null }[], at: bigint = BigInt(this.nowS)): bigint {
    const user = toHex(userId);
    const version = (this.deviceLists.get(user)?.version ?? 0n) + 1n;
    this.storeList(user, version, fakeListBlob(userId, entries.map((entry) => ({ deviceId: entry.deviceId, revokedAt: entry.revokedAt ?? null })), at),
      new Uint8Array(64), new Uint8Array(32));
    return version;
  }
  putBackupObject(userId: Uint8Array, kind: 0 | 1, object: Uint8Array): void {
    this.backups.set(`${toHex(userId)}/${kind}`, { object, created: BigInt(this.nowS) });
  }

  /** An account and device as if an earlier tab's registration had succeeded. */
  register(username: string, deviceId: Uint8Array): Uint8Array {
    this.users += 1;
    const userId = new Uint8Array(16).fill(0x30 + this.users);
    this.accounts.set(toHex(userId), { userId, username, display: username });
    this.devices.set(toHex(deviceId), toHex(userId));
    this.createdAt.set(toHex(deviceId), this.nowS);
    this.tiers.set(toHex(deviceId), 1);
    return userId;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const header = request.headers.get('Authorization');
    const entry: LoggedRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      auth: header !== null && header.startsWith('Bearer ') ? header.slice(7) : null,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    this.log.push(entry);
    const i = this.overrides.findIndex((o) => o.method === entry.method && o.path === entry.path);
    const override = i >= 0 ? this.overrides.splice(i, 1)[0] : undefined;
    if (override !== undefined) {
      if (override.reply === 'network') throw new TypeError('fetch failed');
      if (override.reply === 'lose') { this.route(entry); throw new TypeError('fetch failed'); }
      return reply(override.reply.status, override.reply.body);
    }
    return this.route(entry);
  };

  private route(r: LoggedRequest): Response {
    const line = `${r.method} ${r.path}`;
    if (line === 'POST /v1/accounts') return this.createAccount(r.body);
    if (line === 'POST /v1/auth/password/login') {
      const body = arr(decode(r.body), 2);
      const username = str(body[0] ?? null);
      const password = str(body[1] ?? null);
      const stored = this.passwords.get(username);
      if (stored === undefined || stored.password !== password) return refuse(401, 'E_UNAUTHENTICATED');
      const assertion = this.assertion(username, stored.totp !== null);
      return reply(200, [assertion, stored.totp === null ? 0 : 1]);
    }
    if (line === 'POST /v1/auth/totp/verify') {
      const body = arr(decode(r.body), 2);
      const value = str(body[0] ?? null);
      const code = str(body[1] ?? null);
      const assertion = this.assertions.get(value);
      this.assertions.delete(value);
      if (assertion === undefined || !assertion.needsTotp || this.passwords.get(assertion.user)?.totp !== code)
        return refuse(401, 'E_UNAUTHENTICATED');
      return reply(200, [this.assertion(assertion.user, false)]);
    }
    if (line === 'GET /v1/instance/limits') {
      return reply(200, [131072, 104857600, 4, 2, 32, 8, 1073741824, 30000, 131584, 30, 30]);
    }
    if (/^POST \/v1\/devices\/[0-9a-f]{32}\/sessions\/challenge$/.test(line)) {
      this.challenges += 1;
      return reply(201, [nonceAt(this.challenges), this.nowS + 60]);
    }
    const establish = /^POST \/v1\/devices\/([0-9a-f]{32})\/sessions$/.exec(line);
    if (establish?.[1] !== undefined) return this.establish(establish[1], r.body);
    const device = r.auth === null ? undefined : this.tokens.get(r.auth);
    const user = device === undefined ? undefined : this.devices.get(device);
    if (device === undefined || user === undefined || this.revoked.has(device)) return refuse(401, 'E_UNAUTHENTICATED');
    const list = /^(PUT|GET) \/v1\/users\/([0-9a-f]{32})\/device-list$/.exec(line);
    if (list?.[2] !== undefined) {
      if (user !== list[2]) return refuse(403, 'E_FORBIDDEN');
      return list[1] === 'PUT' ? this.putList(user, list[2], r.body) : this.getList(list[2], r.query);
    }
    if (this.tokenScope.get(r.auth!) === 1 && line !== 'GET /v1/backups' &&
        !/^GET \/v1\/backups\/[01]\/0$/.test(line)) return refuse(403, 'E_FORBIDDEN');
    if (line === 'GET /v1/backups') return reply(200, ([0, 1] as const).flatMap((kind) => {
      const item = this.backups.get(`${user}/${kind}`);
      return item === undefined ? [] : [[kind, 0, item.object.length, item.created]];
    }));
    const backup = /^(GET|PUT|DELETE) \/v1\/backups\/([0-9]+)\/([0-9]+)$/.exec(line);
    if (backup !== null) return this.backup(user, backup[1], Number(backup[2]), Number(backup[3]), r.body);
    if (line === 'DELETE /v1/backups') return refuse(501, 'E_INTERNAL');
    if (line === 'GET /v1/devices') return reply(200, [...this.devices].filter(([, owner]) => owner === user).map(([id]) => [
      fromHex(id), this.tiers.get(id) ?? 1, this.tiers.get(id) ?? 1, null, this.revoked.has(id) ? this.revoked.get(id)! : null,
      this.createdAt.get(id) ?? this.nowS,
    ]));
    const deleteSessions = /^DELETE \/v1\/devices\/([0-9a-f]{32})\/sessions$/.exec(line);
    if (deleteSessions !== null) {
      const target = deleteSessions[1];
      if (this.devices.get(target) !== user) return refuse(404, 'E_NOT_FOUND');
      this.dropTokens(target);
      return reply(204);
    }
    const deleteDevice = /^DELETE \/v1\/devices\/([0-9a-f]{32})$/.exec(line);
    if (deleteDevice !== null) {
      const target = deleteDevice[1];
      if (this.devices.get(target) !== user) return refuse(404, 'E_NOT_FOUND');
      this.revoked.set(target, this.nowS);
      this.dropTokens(target);
      return reply(204);
    }
    if (line === 'POST /v1/keypackages') {
      const b = arr(decode(r.body), 2);
      const count = arr(b[0] ?? null).length;
      this.keyPackages.push({ device, count, lastResort: b[1] !== null });
      return reply(201, [count]);
    }
    if (line === 'GET /v1/accounts/me') {
      const a = this.accounts.get(user);
      if (a === undefined) return refuse(404, 'E_NOT_FOUND');
      return reply(200, [a.userId, a.username, a.display, 0, 0, this.nowS]);
    }
    return new Response('404 page not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  private createAccount(body: Uint8Array): Response {
    const b = arr(decode(body), 8);
    const invite = str(b[0] ?? null);
    const username = str(b[1] ?? null);
    const display = str(b[2] ?? null);
    const deviceId = bin(arr(b[7] ?? null, 5)[0] ?? null, 16);
    if (!this.invites.has(invite)) return refuse(410, 'E_INVITE_INVALID');
    if ([...this.accounts.values()].some((a) => a.username === username)) return refuse(409, 'E_INVALID_REQUEST', 'username taken');
    const userId = this.register(username, deviceId);
    this.tiers.set(toHex(deviceId), Number(arr(b[7] ?? null, 5)[2]) as 0 | 1);
    const account = this.accounts.get(toHex(userId));
    if (account !== undefined) account.display = display;
    return reply(200, [userId, deviceId, this.mint(toHex(deviceId), 0), this.nowS + SESSION_S]);
  }

  private assertion(user: string, needsTotp: boolean): string {
    const value = `asrt-${++this.assertionN}`;
    this.assertions.set(value, { user, needsTotp });
    return value;
  }
  private mint(deviceHex: string, scope: 0 | 1): string {
    this.sessions += 1;
    const token = `tok-${this.sessions}`;
    this.tokens.set(token, deviceHex);
    this.tokenScope.set(token, scope);
    return token;
  }

  private establish(deviceHex: string, body: Uint8Array): Response {
    const b = arr(decode(body), 5);
    const loginBytes = b[4];
    const login = loginBytes instanceof Uint8Array ? new TextDecoder().decode(loginBytes) : null;
    let user = this.devices.get(deviceHex);
    let scope: 0 | 1;
    if (login !== null) {
      if (user === undefined) {
        if (!Array.isArray(b[3]) || b[3].length !== 5) return refuse(400, 'E_INVALID_REQUEST', 'registration array required');
        const registration = b[3];
        if (!(registration[0] instanceof Uint8Array) || registration[0].length !== 16 ||
            !same(registration[0], fromHex(deviceHex))) return refuse(400, 'E_INVALID_REQUEST', 'device_id does not match');
        if (registration[2] !== 1n || registration[3] !== 1n)
          return refuse(400, 'E_INVALID_REQUEST', 'assertion registration is for browser devices');
        if (!(registration[1] instanceof Uint8Array) || registration[1].length !== 32)
          return refuse(400, 'E_INVALID_REQUEST');
      }
      const assertion = this.assertions.get(login);
      this.assertions.delete(login);
      if (assertion === undefined || assertion.needsTotp) return refuse(401, 'E_UNAUTHENTICATED');
      const account = [...this.accounts].find(([, value]) => value.username === assertion.user);
      if (account === undefined) return refuse(401, 'E_UNAUTHENTICATED');
      if (user !== undefined) {
        if (user !== account[0] || this.revoked.has(deviceHex)) return refuse(401, 'E_UNAUTHENTICATED');
      } else {
        user = account[0];
        if (!this.deviceLists.has(user)) return refuse(401, 'E_UNAUTHENTICATED');
        const live = [...this.devices].filter(([id, owner]) => owner === user && !this.revoked.has(id));
        if (live.length >= this.maxDevices) return refuse(403, 'E_FORBIDDEN', 'device cap reached');
        const since = this.nowS - 3599;
        const creations = [...this.devices].filter(([, owner]) => owner === user).map(([id]) => this.createdAt.get(id) ?? this.nowS)
          .filter((at) => at >= since).sort((a, b) => a - b);
        if (creations.length >= this.enrolmentsPerHour) {
          const oldest = creations[creations.length - this.enrolmentsPerHour];
          return refuse(429, 'E_RATE_LIMITED', '', (oldest + 3600 - this.nowS) * 1000);
        }
        this.devices.set(deviceHex, user);
        this.createdAt.set(deviceHex, this.nowS);
        this.tiers.set(deviceHex, 1);
      }
      scope = 1;
    } else {
      if (user === undefined || this.revoked.has(deviceHex)) return refuse(401, 'E_UNAUTHENTICATED');
      if (this.scope !== null) scope = this.scope;
      else {
        const newest = this.deviceLists.get(user);
        if (newest === undefined) scope = 0;
        else {
          const list = readFakeList(newest.blob);
          if (list === null || toHex(list.userId) !== user) return refuse(401, 'E_UNAUTHENTICATED');
          scope = fakeListNames(list, fromHex(deviceHex)) ? 0 : 1;
        }
      }
    }
    return reply(201, [this.mint(deviceHex, scope), scope, fromHex(user), fromHex(deviceHex),
      this.nowS + SESSION_S, this.nowS + IDLE_S, 1]);
  }

  private putList(user: string, target: string, body: Uint8Array): Response {
    if (user !== target) return refuse(403, 'E_FORBIDDEN');
    const b = arr(decode(body), 4);
    const version = u64(b[0] ?? null);
    const expected = (this.deviceLists.get(target)?.version ?? 0n) + 1n;
    if (version !== expected) return refuse(409, 'E_INVALID_REQUEST', `device-list version ${version} is not the next version`);
    this.storeList(target, version, bin(b[1] ?? null), bin(b[2] ?? null), bin(b[3] ?? null));
    return reply(204);
  }

  private getList(target: string, query: string): Response {
    if (query.startsWith('?after=')) {
      const after = BigInt(query.slice(7));
      const rows = (this.listHistory.get(target) ?? []).filter((row) => row.version > after).slice(0, 64);
      return reply(200, rows.map((row) => [row.version, row.blob, row.sig, row.prev]));
    }
    const l = this.deviceLists.get(target);
    if (l === undefined) return refuse(404, 'E_NOT_FOUND');
    const row = this.listHistory.get(target)?.find((item) => item.version === l.version);
    return reply(200, [l.version, l.blob, row?.sig ?? new Uint8Array(64), row?.prev ?? new Uint8Array(32)]);
  }
  private storeList(user: string, version: bigint, blob: Uint8Array, sig: Uint8Array, prev: Uint8Array): void {
    this.deviceLists.set(user, { version, blob });
    const rows = this.listHistory.get(user) ?? [];
    rows.push({ version, blob, sig, prev });
    this.listHistory.set(user, rows);
    const list = readFakeList(blob);
    if (list === null) return;
    for (const entry of list.entries) {
      const device = toHex(entry.deviceId);
      if (entry.revokedAt !== null && this.devices.get(device) === user && !this.revoked.has(device)) {
        this.revoked.set(device, this.nowS);
        this.dropTokens(device);
      }
    }
  }
  private dropTokens(device: string): void {
    for (const [token, id] of this.tokens) if (id === device) {
      this.tokens.delete(token);
      this.tokenScope.delete(token);
    }
  }
  private backup(user: string, method: string, kind: number, chunk: number, body: Uint8Array): Response {
    if (method === 'DELETE') return refuse(501, 'E_INTERNAL');
    if ((kind !== 0 && kind !== 1) || chunk !== 0) return refuse(404, 'E_NOT_FOUND');
    const key = `${user}/${kind}`;
    const existing = this.backups.get(key);
    if (method === 'GET') return existing === undefined ? refuse(404, 'E_NOT_FOUND') : reply(200, [existing.object, existing.created]);
    let object: Uint8Array;
    try {
      const a = arr(decode(body), 1);
      object = bin(a[0] ?? null);
      const header = arr(decode(object), 3);
      if (header[0] !== 1n || bin(header[1] ?? null, 12).length !== 12 || !(header[2] instanceof Uint8Array) ||
          (kind === 0 && object.length !== 103)) throw new Error('shape');
    } catch { return refuse(400, 'E_INVALID_REQUEST', 'object is not a stored header object'); }
    if (kind === 0 && existing !== undefined && !same(existing.object, object))
      return refuse(409, 'E_INVALID_REQUEST', 'root object already stored');
    const created = existing === undefined;
    if (created || kind === 1) this.backups.set(key, { object, created: BigInt(this.nowS) });
    return reply(created ? 201 : 200, [new Uint8Array(createHash('sha256').update(object).digest()), object.length]);
  }
}

export function routesFor(server: FakeServer, auth: { token(): string | null; reauthenticate(): Promise<boolean> }): Routes {
  return new Routes(new HttpClient({
    baseUrl: 'http://127.0.0.1:8453',
    fetch: server.fetch,
    now: () => NOW_S * 1000,
    sleep: () => Promise.resolve(),
    random: () => 0,
    token: () => auth.token(),
    reauthenticate: () => auth.reauthenticate(),
    onGeneration: () => undefined,
  }));
}

/** Routes whose token and 401 recovery come from a Session over `core`, as the worker wires them. */
export function sessionFor(server: FakeServer, core: CorePort): { routes: Routes; session: Session } {
  const holder: { session: Session | null } = { session: null };
  const routes = routesFor(server, {
    token: () => holder.session?.token() ?? null,
    reauthenticate: () => holder.session?.establish() ?? Promise.resolve(false),
  });
  const session = new Session({ core, routes, now: () => NOW_S * 1000 });
  holder.session = session;
  return { routes, session };
}
