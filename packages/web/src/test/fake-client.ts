import type { Command, CoreClient, SliceName, SliceTypes } from '@dilla/client-core';
import type { UiError } from '../core/errors.ts';

/** What a refused call rejects with: the four fields of the worker's error, as the bridge's CoreCallError carries them. */
export class FakeCallError extends Error implements UiError {
  readonly code: string;
  readonly detail: string;
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(code: string, detail: string, status: number, retryAfterMs: number | null) {
    super(`${code}: ${detail}`);
    this.name = 'FakeCallError';
    this.code = code;
    this.detail = detail;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A refusal to script with `Promise.reject(refusal({ … }))`; status 0 and no wait unless given. */
export function refusal(init: { code: string; detail?: string; status?: number; retryAfterMs?: number | null }): FakeCallError {
  return new FakeCallError(init.code, init.detail ?? '', init.status ?? 0, init.retryAfterMs ?? null);
}

/** An in-memory CoreClient: tests set slices and script the answers of calls. */
export class FakeClient implements CoreClient {
  readonly calls: Command[] = [];
  handler: (command: Command) => Promise<unknown> = () => Promise.resolve(null);
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<() => void>>();

  call<C extends Command>(command: C): Promise<unknown> {
    this.calls.push(command);
    return this.handler(command);
  }
  get<N extends SliceName>(name: N): SliceTypes[N] | undefined {
    return this.values.get(name) as SliceTypes[N] | undefined;
  }
  subscribe(name: SliceName, listener: () => void): () => void {
    const set = this.listeners.get(name) ?? new Set<() => void>();
    this.listeners.set(name, set);
    set.add(listener);
    return () => { set.delete(listener); };
  }
  dispose(): void {}
  set<N extends SliceName>(name: N, value: SliceTypes[N]): void {
    this.values.set(name, value);
    for (const l of [...(this.listeners.get(name) ?? [])]) l();
  }
  callsOf<M extends Command['m']>(m: M): Extract<Command, { m: M }>[] {
    return this.calls.filter((c): c is Extract<Command, { m: M }> => c.m === m);
  }
}
