import { arr, bin, decode, encode, str, u64, type CborInput } from '../cbor';
import { Session } from '../account/session';
import type { CorePort } from '../core-port';
import { fromHex, toHex } from '../hex';
import { HttpClient } from '../http/client';
import { Routes } from '../http/routes';

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

export interface LoggedRequest { method: string; path: string; auth: string | null; body: Uint8Array }
export type Reply = { status: number; body?: CborInput } | 'network';
interface Account { userId: Uint8Array; username: string; display: string }

function reply(status: number, body?: CborInput): Response {
  if (body === undefined) return new Response(null, { status, headers: { 'X-Dilla-Generation': '1' } });
  return new Response(new Uint8Array(encode(body)), {
    status,
    headers: { 'Content-Type': 'application/cbor', 'X-Dilla-Generation': '1' },
  });
}

function refuse(status: number, code: string, detail = ''): Response {
  return reply(status, [code, detail, null]);
}

/** An in-memory model of the account routes of dillad, answering through fetch. */
export class FakeServer {
  readonly log: LoggedRequest[] = [];
  readonly invites = new Set<string>(['INVITE']);
  readonly accounts = new Map<string, Account>();
  readonly devices = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  readonly deviceLists = new Map<string, { version: bigint; blob: Uint8Array }>();
  readonly keyPackages: { device: string; count: number; lastResort: boolean }[] = [];
  scope = 0;
  private users = 0;
  private sessions = 0;
  private challenges = 0;
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

  /** An account and device as if an earlier tab's registration had succeeded. */
  register(username: string, deviceId: Uint8Array): Uint8Array {
    this.users += 1;
    const userId = new Uint8Array(16).fill(0x30 + this.users);
    this.accounts.set(toHex(userId), { userId, username, display: username });
    this.devices.set(toHex(deviceId), toHex(userId));
    return userId;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const header = request.headers.get('Authorization');
    const entry: LoggedRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      auth: header !== null && header.startsWith('Bearer ') ? header.slice(7) : null,
      body: new Uint8Array(await request.arrayBuffer()),
    };
    this.log.push(entry);
    const i = this.overrides.findIndex((o) => o.method === entry.method && o.path === entry.path);
    const override = i >= 0 ? this.overrides.splice(i, 1)[0] : undefined;
    if (override !== undefined) {
      if (override.reply === 'network') throw new TypeError('fetch failed');
      return reply(override.reply.status, override.reply.body);
    }
    return this.route(entry);
  };

  private route(r: LoggedRequest): Response {
    const line = `${r.method} ${r.path}`;
    if (line === 'POST /v1/accounts') return this.createAccount(r.body);
    if (line === 'GET /v1/instance/limits') {
      return reply(200, [131072, 104857600, 4, 2, 32, 8, 1073741824, 30000, 131584, 30, 30]);
    }
    if (/^POST \/v1\/devices\/[0-9a-f]{32}\/sessions\/challenge$/.test(line)) {
      this.challenges += 1;
      return reply(201, [nonceAt(this.challenges), NOW_S + 60]);
    }
    const establish = /^POST \/v1\/devices\/([0-9a-f]{32})\/sessions$/.exec(line);
    if (establish?.[1] !== undefined) return this.establish(establish[1]);
    const device = r.auth === null ? undefined : this.tokens.get(r.auth);
    const user = device === undefined ? undefined : this.devices.get(device);
    if (device === undefined || user === undefined) return refuse(401, 'E_UNAUTHENTICATED');
    const list = /^(PUT|GET) \/v1\/users\/([0-9a-f]{32})\/device-list$/.exec(line);
    if (list?.[2] !== undefined) return list[1] === 'PUT' ? this.putList(user, list[2], r.body) : this.getList(list[2]);
    if (line === 'POST /v1/keypackages') {
      const b = arr(decode(r.body), 2);
      const count = arr(b[0] ?? null).length;
      this.keyPackages.push({ device, count, lastResort: b[1] !== null });
      return reply(201, [count]);
    }
    if (line === 'GET /v1/accounts/me') {
      const a = this.accounts.get(user);
      if (a === undefined) return refuse(404, 'E_NOT_FOUND');
      return reply(200, [a.userId, a.username, a.display, 0, 0, NOW_S]);
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
    const account = this.accounts.get(toHex(userId));
    if (account !== undefined) account.display = display;
    return reply(200, [userId, deviceId, this.mint(toHex(deviceId)), NOW_S + SESSION_S]);
  }

  private mint(deviceHex: string): string {
    this.sessions += 1;
    const token = `tok-${this.sessions}`;
    this.tokens.set(token, deviceHex);
    return token;
  }

  private establish(deviceHex: string): Response {
    const user = this.devices.get(deviceHex);
    if (user === undefined) return refuse(401, 'E_UNAUTHENTICATED');
    return reply(201, [this.mint(deviceHex), this.scope, fromHex(user), fromHex(deviceHex), NOW_S + SESSION_S, NOW_S + IDLE_S, 1]);
  }

  private putList(user: string, target: string, body: Uint8Array): Response {
    if (user !== target) return refuse(403, 'E_FORBIDDEN');
    const b = arr(decode(body), 4);
    if (this.deviceLists.has(target)) return refuse(409, 'E_INVALID_REQUEST', 'device list version exists');
    this.deviceLists.set(target, { version: u64(b[0] ?? null), blob: bin(b[1] ?? null) });
    return reply(204);
  }

  private getList(target: string): Response {
    const l = this.deviceLists.get(target);
    if (l === undefined) return refuse(404, 'E_NOT_FOUND');
    return reply(200, [l.version, l.blob, new Uint8Array(64), new Uint8Array(32)]);
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
