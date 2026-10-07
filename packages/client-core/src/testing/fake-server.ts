import { createHash } from 'node:crypto';
import { arr, bin, decode, encode, str, u64, type CborInput, type CborValue } from '../cbor';
import { Session } from '../account/session';
import type { CorePort } from '../core-port';
import { fromHex, toHex } from '../hex';
import { HttpClient } from '../http/client';
import { Routes } from '../http/routes';
import { fakeDskPub, fakeListBlob, fakeListNames, readFakeList } from './fake-list';

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

/** The fake's stand-in for Ed25519(DSK, SessionPreimage(instance, device_id, nonce, purpose 0)): only the holder of
 *  `dskPub` is taken to produce it, so a body signed for another key or nonce fails as a real signature would. */
export function fakeDeviceProof(dskPub: Uint8Array, deviceId: Uint8Array, nonce: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha512').update('fake.proof').update(dskPub).update(deviceId).update(nonce).update(new Uint8Array([0])).digest());
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
  /** Every assertion issued, including ones subsequently spent. */
  readonly assertions: string[] = [];
  private readonly activeAssertions = new Map<string, { user: string; needsTotp: boolean }>();
  readonly backups = new Map<string, { object: Uint8Array; created: bigint }>();
  readonly listHistory = new Map<string, { version: bigint; blob: Uint8Array; sig: Uint8Array; prev: Uint8Array }[]>();
  readonly revoked = new Map<string, number>();
  readonly createdAt = new Map<string, number>();
  readonly tiers = new Map<string, 0 | 1>();
  /** token → protocol/02 item 4's scope: 0 enrolled, 1 pending, 2 provisional (the fake mints only 0 and 1; a test
   *  plants a provisional token directly). */
  readonly tokenScope = new Map<string, 0 | 1 | 2>();
  /** device hex → the hex of the dsk_pub its row holds; a row planted without one holds fakeDskPub(device). */
  readonly keys = new Map<string, string>();
  /** Challenge nonces not yet spent by POST /v1/devices: nonce hex → the device id it was issued for, its expiry. */
  private readonly nonces = new Map<string, { device: string; expires: number }>();
  private readonly tickets = new Map<string, { token: string; expires: number }>();
  private readonly uploadBuckets = new Map<string, { requests: number; bytes: number; at: number }>();
  nowS = NOW_S;
  maxDevices = 8;
  enrolmentsPerHour = 3;
  /** Hex SHA-256 of bytes an attachment references (blob_refs): a backup PUT of them is 409, since backup objects
   *  and attachments never share bytes (branch review BACKUPS-RECOVERY-05). */
  readonly attachmentBytes = new Set<string>();
  /** Hex SHA-256 of bytes an operator purged: tombstoned, so a PUT of them is 410 E_PRUNED, while a backup row that
   *  names them is still served (protocol/09 Admin). */
  readonly prunedBytes = new Set<string>();
  /** Hex SHA-256 of bytes a replaced state object's delete unlinks under the next upload of them: that PUT answers
   *  503 E_UNAVAILABLE (retry_after_ms 100) and records nothing, and the retry stores the bytes anew. One shot. */
  readonly bytesDeletedUnderNextUpload = new Set<string>();
  /** blobs.uploads_per_minute and blobs.upload_bytes_per_day, the defaults of internal/config/defaults.go. */
  uploadsPerMinute = 20;
  uploadBytesPerDay = 5_368_709_120;
  private users = 0;
  private sessions = 0;
  private challenges = 0;
  private assertionN = 0;
  private ticketN = 0;
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
  register(username: string, deviceId: Uint8Array, dskPub: Uint8Array = fakeDskPub(deviceId)): Uint8Array {
    this.users += 1;
    const userId = new Uint8Array(16).fill(0x30 + this.users);
    this.accounts.set(toHex(userId), { userId, username, display: username });
    this.devices.set(toHex(deviceId), toHex(userId));
    this.createdAt.set(toHex(deviceId), this.nowS);
    this.tiers.set(toHex(deviceId), 1);
    this.keys.set(toHex(deviceId), toHex(dskPub));
    return userId;
  }

  /** What the gateway's identify answers for a session token or a ticket (protocol/02 item 4, security review F4,
   *  branch review REGISTRATION-DEVICES-01): `ready` only for an enrolled session; a pending, provisional, unknown,
   *  revoked or spent one is an E_UNAUTHENTICATED error frame and close 4003. A ticket is single use and lives 30 s. */
  identify(credential: string): { op: 'ready' } | { op: 'error'; code: 'E_UNAUTHENTICATED'; close: 4003 } {
    const refused = { op: 'error', code: 'E_UNAUTHENTICATED', close: 4003 } as const;
    let token = credential;
    const ticket = this.tickets.get(credential);
    if (ticket !== undefined) {
      this.tickets.delete(credential);
      if (this.nowS > ticket.expires) return refused;
      token = ticket.token;
    }
    const device = this.tokens.get(token);
    if (device === undefined || this.revoked.has(device) || this.tokenScope.get(token) !== 0) return refused;
    return { op: 'ready' };
  }

  private keyOf(device: string): string {
    return this.keys.get(device) ?? toHex(fakeDskPub(fromHex(device)));
  }

  /** Whether the user's newest list names the row by its (device_id, dsk_pub) pair; with no list every row counts. */
  private listed(user: string, device: string): boolean {
    const newest = this.deviceLists.get(user);
    if (newest === undefined) return true;
    const list = readFakeList(newest.blob);
    return list !== null && fakeListNames(list, fromHex(device), fromHex(this.keyOf(device)));
  }

  /** auth.Sessions.AdmitDevice (`evict`, assertion registration): the 24-hour sweep, one live row per key (409), then
   *  the cap and the hourly rate, which decide which row the registration replaces (the oldest live unlisted one,
   *  whatever its age, ties by id), never whether it is admitted; only a cap of listed rows refuses (403).
   *  AdmitEnrolledDevice (not `evict`, POST /v1/devices, branch review REGISTRATION-DEVICES-03): the same sweep, key
   *  rule, cap and rate, but past the cap 403 "device cap reached" and past the rate 429 with the wait until enough
   *  creations leave the hour; it never evicts. Nothing is written on a refusal (the real one runs in the
   *  registration's transaction). */
  private admit(user: string, keyHex: string, evict: boolean): Response | { apply(): void } {
    const rows = [...this.devices].filter(([, owner]) => owner === user).map(([id]) => id);
    const cutoff = this.nowS - 86_399;
    const created = (id: string): number => this.createdAt.get(id) ?? this.nowS;
    const listed = new Set(rows.filter((id) => this.listed(user, id)));
    const swept = rows.filter((id) => !this.revoked.has(id) && created(id) < cutoff && !listed.has(id));
    const live = rows.filter((id) => !this.revoked.has(id) && !swept.includes(id));
    if (live.some((id) => this.keyOf(id) === keyHex))
      return refuse(409, 'E_INVALID_REQUEST', 'dsk_pub is already registered to a live device');
    const creations = live.map(created).filter((at) => at >= this.nowS - 3599);
    const atCap = live.length >= this.maxDevices;
    let evicted: string | undefined;
    if (!evict && atCap) return refuse(403, 'E_FORBIDDEN', 'device cap reached');
    if (!evict && creations.length >= this.enrolmentsPerHour)
      return refuse(429, 'E_RATE_LIMITED', 'rate limited', this.rateWait(creations) * 1000);
    if (atCap || creations.length >= this.enrolmentsPerHour) {
      evicted = live.filter((id) => !listed.has(id))
        .sort((a, b) => created(a) - created(b) || (a < b ? -1 : a > b ? 1 : 0))[0];
      if (evicted === undefined && atCap) return refuse(403, 'E_FORBIDDEN', 'device cap reached');
    }
    return {
      apply: () => {
        for (const id of evicted === undefined ? swept : [...swept, evicted]) {
          this.revoked.set(id, this.nowS);
          this.dropTokens(id);
        }
      },
    };
  }

  /** auth.rateWait: the seconds until enough of the hour's live creations leave the window that one more is under
   *  the rate; a creation at c counts while c >= now-3599, so it leaves at c+3600. */
  private rateWait(creations: readonly number[]): number {
    const sorted = [...creations].sort((a, b) => a - b);
    if (sorted.length === 0) return 3600;
    const i = Math.min(Math.max(sorted.length - this.enrolmentsPerHour, 0), sorted.length - 1);
    const wait = sorted[i]! + 3600 - this.nowS;
    return wait > 0 ? wait : 1;
  }

  readonly fetch =async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      const assertion = this.activeAssertions.get(value);
      this.activeAssertions.delete(value);
      if (assertion === undefined || !assertion.needsTotp || this.passwords.get(assertion.user)?.totp !== code)
        return refuse(401, 'E_UNAUTHENTICATED');
      return reply(200, [this.assertion(assertion.user, false)]);
    }
    if (line === 'GET /v1/instance/limits') {
      return reply(200, [131072, 104857600, 4, 2, 32, 8, 1073741824, 30000, 131584, 30, 30]);
    }
    const challenge = /^POST \/v1\/devices\/([0-9a-f]{32})\/sessions\/challenge$/.exec(line);
    if (challenge?.[1] !== undefined) {
      this.challenges += 1;
      const nonce = nonceAt(this.challenges);
      this.nonces.set(toHex(nonce), { device: challenge[1], expires: this.nowS + 60 });
      return reply(201, [nonce, this.nowS + 60]);
    }
    const establish = /^POST \/v1\/devices\/([0-9a-f]{32})\/sessions$/.exec(line);
    if (establish?.[1] !== undefined) return this.establish(establish[1], r.body);
    const device = r.auth === null ? undefined : this.tokens.get(r.auth);
    const user = device === undefined ? undefined : this.devices.get(device);
    if (device === undefined || user === undefined || this.revoked.has(device)) return refuse(401, 'E_UNAUTHENTICATED');
    const list = /^(PUT|GET) \/v1\/users\/([0-9a-f]{32})\/device-list$/.exec(line);
    if (list?.[2] !== undefined) {
      if (list[1] === 'PUT') {
        if (user !== list[2]) return refuse(403, 'E_FORBIDDEN');
        return this.putList(user, list[2], r.body);
      }
      if (user !== list[2] && this.tokenScope.get(r.auth!) === 1) return refuse(403, 'E_FORBIDDEN');
      return this.getList(list[2], r.query);
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
      // Listed is the pair: a row that only copies a listed key, or a listed id under another key, is removed here.
      if (this.deviceLists.has(user) && this.listed(user, target))
        return refuse(409, 'E_INVALID_REQUEST', 'a listed device is revoked by a signed device list');
      // The grace (branch review REGISTRATION-DEVICES-03): an unlisted row younger than 10 minutes is removed only
      // by its own session, so a stolen enrolled session cannot remove a recovering owner's new row on sight.
      if (target !== device && (this.createdAt.get(target) ?? this.nowS) > this.nowS - 600)
        return refuse(409, 'E_INVALID_REQUEST', 'the device registered less than 10 minutes ago and is too new to remove; ' +
          'its own session may remove it, or it expires unlisted after 24 hours');
      this.revoked.set(target, this.nowS);
      this.dropTokens(target);
      return reply(204);
    }
    if (line === 'POST /v1/devices') return this.createDevice(user, r.body);
    if (line === 'POST /v1/gateway/ticket') {
      const ticket = `tkt-${++this.ticketN}`;
      this.tickets.set(ticket, { token: r.auth!, expires: this.nowS + 30 });
      return reply(201, [ticket, this.nowS + 30]);
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
    const dskPub = bin(arr(b[7] ?? null, 5)[1] ?? null, 32);
    if (!this.invites.has(invite)) return refuse(410, 'E_INVITE_INVALID');
    if ([...this.accounts.values()].some((a) => a.username === username)) return refuse(409, 'E_INVALID_REQUEST', 'username taken');
    const userId = this.register(username, deviceId, dskPub);
    this.tiers.set(toHex(deviceId), Number(arr(b[7] ?? null, 5)[2]) as 0 | 1);
    const account = this.accounts.get(toHex(userId));
    if (account !== undefined) account.display = display;
    return reply(200, [userId, deviceId, this.mint(toHex(deviceId), 0), this.nowS + SESSION_S]);
  }

  private assertion(user: string, needsTotp: boolean): string {
    const value = `asrt-${++this.assertionN}`;
    this.assertions.push(value);
    this.activeAssertions.set(value, { user, needsTotp });
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
      const assertion = this.activeAssertions.get(login);
      this.activeAssertions.delete(login);
      if (assertion === undefined || assertion.needsTotp) return refuse(401, 'E_UNAUTHENTICATED');
      const account = [...this.accounts].find(([, value]) => value.username === assertion.user);
      if (account === undefined) return refuse(401, 'E_UNAUTHENTICATED');
      if (user !== undefined) {
        if (user !== account[0] || this.revoked.has(deviceHex)) return refuse(401, 'E_UNAUTHENTICATED');
      } else {
        user = account[0];
        if (!this.deviceLists.has(user)) return refuse(401, 'E_UNAUTHENTICATED');
        const key = toHex(bin(arr(b[3] ?? null, 5)[1] ?? null, 32));
        const admitted = this.admit(user, key, true);
        if (admitted instanceof Response) return admitted;
        admitted.apply();
        this.devices.set(deviceHex, user);
        this.createdAt.set(deviceHex, this.nowS);
        this.tiers.set(deviceHex, 1);
        this.keys.set(deviceHex, key);
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
          scope = fakeListNames(list, fromHex(deviceHex), fromHex(this.keyOf(deviceHex))) ? 0 : 1;
        }
      }
    }
    if (this.scope !== null) scope = this.scope;
    return reply(201, [this.mint(deviceHex, scope), scope, fromHex(user), fromHex(deviceHex),
      this.nowS + SESSION_S, this.nowS + IDLE_S, 1]);
  }

  /** POST /v1/devices (enrolled): [device_id, dsk_pub, tier, signer_tier, credential, nonce b32, sig b64] → 200
   *  [device_id]. The nonce is a challenge for the new device_id, spent here; sig is the purpose-0 proof by dsk_pub
   *  (403 "possession of dsk_pub is not proven"); then the enrolled admission (409 for a held key, the cap's 403, the
   *  rate's 429, never an eviction); a device_id that exists is 409. */
  private createDevice(user: string, body: Uint8Array): Response {
    let device: Uint8Array, key: Uint8Array, tier: bigint, nonce: CborValue, sig: CborValue;
    try {
      const b = arr(decode(body), 7);
      device = bin(b[0] ?? null, 16);
      key = bin(b[1] ?? null);
      tier = u64(b[2] ?? null);
      const signer = u64(b[3] ?? null);
      const credential = bin(b[4] ?? null);
      nonce = b[5] ?? null;
      sig = b[6] ?? null;
      if (device.every((x) => x === 0) || key.length !== 32 || tier > 1n || signer > 1n || credential.length < 1 ||
          credential.length > 8192) throw new Error('shape');
    } catch { return refuse(400, 'E_INVALID_REQUEST'); }
    const deviceHex = toHex(device);
    const notProven = refuse(403, 'E_FORBIDDEN', 'possession of dsk_pub is not proven');
    if (!(nonce instanceof Uint8Array) || nonce.length !== 32 || !(sig instanceof Uint8Array) || sig.length !== 64) return notProven;
    const issued = this.nonces.get(toHex(nonce));
    this.nonces.delete(toHex(nonce));
    if (issued === undefined || issued.device !== deviceHex || this.nowS > issued.expires ||
        !same(sig, fakeDeviceProof(key, device, nonce))) return notProven;
    const admitted = this.admit(user, toHex(key), false);
    if (admitted instanceof Response) return admitted;
    if (this.devices.has(deviceHex)) return refuse(409, 'E_INVALID_REQUEST', 'device_id already exists');
    admitted.apply();
    this.devices.set(deviceHex, user);
    this.createdAt.set(deviceHex, this.nowS);
    this.tiers.set(deviceHex, Number(tier) as 0 | 1);
    this.keys.set(deviceHex, toHex(key));
    return reply(200, [device]);
  }

  /** The blob upload meter PUT /v1/backups shares with the attachment routes (api.UploadMeter): two token buckets
   *  per user, refilled continuously from full. Answers the refusal, or null having spent one request and `bytes`. */
  private meter(user: string, bytes: number): Response | null {
    const perMinute = this.uploadsPerMinute;
    const perDay = this.uploadBytesPerDay;
    if (perMinute <= 0 && perDay <= 0) return null;
    let u = this.uploadBuckets.get(user);
    if (u === undefined) {
      u = { requests: perMinute, bytes: perDay, at: this.nowS };
      this.uploadBuckets.set(user, u);
    } else if (this.nowS > u.at) {
      const elapsed = this.nowS - u.at;
      u.requests = Math.min(perMinute, u.requests + elapsed * perMinute / 60);
      u.bytes = Math.min(perDay, u.bytes + elapsed * perDay / 86_400);
      u.at = this.nowS;
    }
    const after = (seconds: number): Response => refuse(429, 'E_RATE_LIMITED', 'rate limited', Math.floor(seconds * 1000));
    if (perMinute > 0 && u.requests < 1) return after((1 - u.requests) * 60 / perMinute);
    const held = perDay <= 0 ? 0 : Math.min(bytes, perDay);
    if (held > 0 && u.bytes < held) return after((held - u.bytes) * 86_400 / perDay);
    if (perMinute > 0) u.requests -= 1;
    u.bytes -= held;
    return null;
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
    // The upload meter before a byte is read: the reservation is the body cap or the body's length, whichever is
    // smaller, and every byte read spends the day's budget whatever happens to the object (security review F3).
    const metered = this.meter(user, Math.min(body.length, kind === 0 ? 256 : 1_048_640));
    if (metered !== null) return metered;
    let object: Uint8Array;
    try {
      const a = arr(decode(body), 1);
      object = bin(a[0] ?? null);
      const header = arr(decode(object), 3);
      if (header[0] !== 1n || bin(header[1] ?? null, 12).length !== 12 || !(header[2] instanceof Uint8Array) ||
          (kind === 0 && object.length !== 103)) throw new Error('shape');
    } catch { return refuse(400, 'E_INVALID_REQUEST', 'object is not a stored header object'); }
    // The server's order: the tombstone gate, then inside the recording transaction the file check, the
    // attachment overlap and the root's conflict.
    const blobHex = createHash('sha256').update(object).digest('hex');
    if (this.prunedBytes.has(blobHex)) return refuse(410, 'E_PRUNED', 'these bytes were removed by the server operator');
    if (this.bytesDeletedUnderNextUpload.delete(blobHex))
      return refuse(503, 'E_UNAVAILABLE', 'the stored bytes were removed during the upload; send them again', 100);
    if (this.attachmentBytes.has(blobHex))
      return refuse(409, 'E_INVALID_REQUEST', 'these bytes are an attachment; a backup object cannot share them');
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
