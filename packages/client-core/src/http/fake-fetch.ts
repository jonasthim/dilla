// Test support for the HTTP layer: a scripted fetch, a manual clock, and recorders for sleeps,
// generations and re-authentication. Only *.test.ts files import this module.
import { encode, type CborInput } from '../cbor';
import { HttpClient, type HttpDeps, type HttpRequest, type HttpResponse } from './client';

export const BASE_URL = 'https://dilla.test';
export const GENERATION = '7';

export interface SeenRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  init: RequestInit;
}

export type Reply = Response | Error | (() => Response | Error);

export interface FakeTransport {
  readonly deps: HttpDeps;
  readonly seen: SeenRequest[];
  readonly replies: Reply[];
  readonly sleeps: number[];
  readonly generations: bigint[];
  readonly reauthCalls: number;
  readonly now: number;
}

export interface FakeOptions {
  token?: string | null;
  reauth?: () => { ok: boolean; token?: string };
  random?: number;
}

export function fakeTransport(opts: FakeOptions = {}): FakeTransport {
  const seen: SeenRequest[] = [];
  const replies: Reply[] = [];
  const sleeps: number[] = [];
  const generations: bigint[] = [];
  const state = { token: opts.token === undefined ? 'tok-1' : opts.token, now: 1_000_000, reauthCalls: 0 };
  const reauth: () => { ok: boolean; token?: string } = opts.reauth ?? (() => ({ ok: false }));
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : null;
    seen.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body, init: init ?? {} });
    const next = replies.shift();
    const reply = typeof next === 'function' ? next() : next;
    if (reply === undefined) return Promise.reject(new Error(`unscripted request ${url}`));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply);
  };
  const deps: HttpDeps = {
    baseUrl: BASE_URL,
    fetch: fetchFn,
    now: () => state.now,
    sleep: (ms, signal) => {
      sleeps.push(ms);
      state.now += ms;
      return signal?.aborted
        ? Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
        : Promise.resolve();
    },
    random: () => opts.random ?? 0.5,
    token: () => state.token,
    reauthenticate: () => {
      state.reauthCalls += 1;
      const result = reauth();
      if (result.token !== undefined) state.token = result.token;
      return Promise.resolve(result.ok);
    },
    onGeneration: (generation) => {
      generations.push(generation);
    },
  };
  return {
    deps, seen, replies, sleeps, generations,
    get reauthCalls() { return state.reauthCalls; },
    get now() { return state.now; },
  };
}

function headersWith(extra: Record<string, string>, contentType: string | null): Headers {
  const headers = new Headers({ 'X-Dilla-Generation': GENERATION });
  if (contentType !== null) headers.set('Content-Type', contentType);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

export function bytesReply(status: number, body: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(body.slice(), { status, headers: headersWith(headers, 'application/cbor') });
}

export function cborReply(status: number, value: CborInput, headers: Record<string, string> = {}): Response {
  return bytesReply(status, encode(value), headers);
}

export function refusal(status: number, code: string, detail = '', retryAfterMs: number | null = null,
  extra: readonly CborInput[] = [], headers: Record<string, string> = {}): Response {
  return cborReply(status, [code, detail, retryAfterMs, ...extra], headers);
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: headersWith(headers, null) });
}

export function textReply(status: number, text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: headersWith(headers, 'text/plain; charset=utf-8') });
}

/** An HttpClient that remembers every request it was asked to make, for bucket and idempotency checks. */
export class RecordingClient extends HttpClient {
  readonly requests: HttpRequest[] = [];
  override request(r: HttpRequest): Promise<HttpResponse> {
    this.requests.push(r);
    return super.request(r);
  }
}
