// The client core's HTTP transport; every typed route passes through request.
import { DillaHttpError, decodeErrorBody } from './errors';
import { TokenBuckets, type Bucket } from './pacing';
export { PACING, type Bucket } from './pacing';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Uint8Array;
  bucket: Bucket;
  idempotent: boolean;
  auth?: boolean;
  accept?: string;
  ok?: readonly number[];
  signal?: AbortSignal;
}
export interface HttpResponse { status: number; body: Uint8Array; }
export interface HttpDeps {
  baseUrl: string;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  token(): string | null;
  reauthenticate(): Promise<boolean>;
  onGeneration(generation: bigint): void;
}
export const RETRY = { maxAttempts: 5, baseMs: 500, capMs: 8000, jitterMs: 250, maxWaitMs: 60000 } as const;
const abort = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

export class HttpClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly buckets: TokenBuckets;

  constructor(private readonly deps: HttpDeps) {
    this.baseUrl = deps.baseUrl.endsWith('/') ? deps.baseUrl.slice(0, -1) : deps.baseUrl;
    this.fetchFn = deps.fetch;
    this.buckets = new TokenBuckets({ now: () => deps.now(), sleep: (ms, signal) => deps.sleep(ms, signal) });
  }

  async request(r: HttpRequest): Promise<HttpResponse> {
    let reauthenticated = false;
    for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
      if (r.signal?.aborted) throw abort();
      await this.buckets.take(r.bucket, r.signal);
      if (r.signal?.aborted) throw abort();
      const headers = new Headers();
      const token = r.auth !== false ? this.deps.token() : null;
      if (token !== null) headers.set('Authorization', `Bearer ${token}`);
      if (r.body !== undefined) headers.set('Content-Type', 'application/cbor');
      if (r.accept !== undefined) headers.set('Accept', r.accept);
      const init: RequestInit = { method: r.method, headers, body: r.body?.slice(),
        signal: r.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' };
      let error: DillaHttpError;
      try {
        const response = await this.fetchFn(this.baseUrl + r.path, init);
        const generation = response.headers.get('X-Dilla-Generation');
        if (generation !== null && /^[0-9]{1,20}$/.test(generation)) {
          const number = BigInt(generation);
          if (number <= (1n << 64n) - 1n) this.deps.onGeneration(number);
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if ((r.ok ?? [200, 201, 204]).includes(response.status)) return { status: response.status, body };
        error = decodeErrorBody(response.status, body, response.headers.get('Retry-After'));
      } catch (e) {
        if (r.signal?.aborted) throw abort();
        if (e instanceof DillaHttpError) throw e;
        error = new DillaHttpError({ status: 0, code: 'E_NETWORK', detail: e instanceof Error ? e.message : 'network failure',
          retryAfterMs: null, extra: [] });
      }
      if (error.status === 401 && r.auth !== false && !reauthenticated) {
        reauthenticated = true;
        const renewed = await this.deps.reauthenticate();
        if (renewed && attempt < RETRY.maxAttempts) continue;
      }
      if (error.status === 429 || error.status === 503) {
        const wait = error.retryAfterMs ?? 1000;
        if (attempt < RETRY.maxAttempts && wait <= RETRY.maxWaitMs) {
          try { await this.deps.sleep(wait, r.signal); }
          catch (e) { if (r.signal?.aborted) throw abort(); throw e; }
          continue;
        }
      }
      if (r.idempotent && (error.status === 0 || error.status === 500) && attempt < RETRY.maxAttempts) {
        const wait = Math.min(RETRY.capMs, RETRY.baseMs * 2 ** (attempt - 1))
          + Math.floor(this.deps.random() * RETRY.jitterMs);
        try { await this.deps.sleep(wait, r.signal); }
        catch (e) { if (r.signal?.aborted) throw abort(); throw e; }
        continue;
      }
      throw error;
    }
    throw new Error('unreachable');
  }
}
