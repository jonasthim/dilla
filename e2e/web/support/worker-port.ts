// A test-only handle on the app's own core worker (web3.7 ruling R27), on the RecordedWorker pattern of
// e2e/voice/support/peer-browser.ts. The init script wraps `window.Worker`, keeps the worker the bridge starts ("dilla-core")
// and the newest value of every slice it publishes, and lets the test post a `call` message of its own: the message
// `client.call(command)` would post, around the UI (a disabled composer, a hidden control). The reply comes back to the test,
// not to the app (the bridge drops a `ret` with an id it did not issue).
//
// `holdUploads` is the other half of the lying-sender attack: it rewrites the class of an upload on its way to the host. The
// worker's own fetch is not reachable from the page, so the browser context's route does it, on the request the worker made.
import type { BrowserContext, Page } from '@playwright/test';

export interface WorkerReply { ok: boolean; value?: unknown; error?: { code: string; detail: string; status: number; reason?: string } }
interface PortGlobal {
  call(command: Record<string, unknown>): Promise<WorkerReply>;
  slice(name: string): unknown;
}

/** Installs the handle in every page of `context` from its next navigation on. Call it before the first `goto`. */
export async function installWorkerPort(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const cores: Worker[] = [];
    const slices = new Map<string, { rev: number; value: unknown }>();
    let next = 2_000_000_000;
    const Native = window.Worker;
    class TappedWorker extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (options?.name === 'dilla-core') cores.push(this);
        this.addEventListener('message', (e) => {
          const m = (e as MessageEvent).data as { t?: unknown; name?: unknown; rev?: unknown; value?: unknown } | null;
          if (m === null || typeof m !== 'object' || m.t !== 'slice' || typeof m.name !== 'string' || typeof m.rev !== 'number') return;
          if (m.rev > (slices.get(m.name)?.rev ?? 0)) slices.set(m.name, { rev: m.rev, value: m.value });
        });
      }
    }
    Object.defineProperty(window, 'Worker', { value: TappedWorker, configurable: true, writable: true });
    const port: PortGlobal = {
      call(command) {
        const core = cores[cores.length - 1];
        if (core === undefined) return Promise.reject(new Error('the core worker has not started'));
        const id = next++;
        return new Promise<WorkerReply>((resolve) => {
          const onMessage = (e: Event): void => {
            const m = (e as MessageEvent).data as { t?: unknown; id?: unknown; ok?: unknown; value?: unknown; error?: unknown } | null;
            if (m === null || typeof m !== 'object' || m.t !== 'ret' || m.id !== id) return;
            core.removeEventListener('message', onMessage);
            resolve({ ok: m.ok === true, value: m.value, error: m.error as WorkerReply['error'] });
          };
          core.addEventListener('message', onMessage);
          core.postMessage({ t: 'call', id, command });
        });
      },
      slice: (name) => slices.get(name)?.value,
    };
    Object.defineProperty(window, '__dillaPort', { value: port, configurable: true });
  });
}

/** Posts `command` to the page's core worker as the app's own client would, and returns the worker's reply. */
export function portCall(page: Page, command: Record<string, unknown>): Promise<WorkerReply> {
  return page.evaluate((c) => (window as unknown as { __dillaPort: PortGlobal }).__dillaPort.call(c), command);
}

/** The newest value of a slice the worker published to this page (undefined before the first). */
export function portSlice<T>(page: Page, name: string): Promise<T | undefined> {
  return page.evaluate((n) => (window as unknown as { __dillaPort: PortGlobal }).__dillaPort.slice(n), name) as Promise<T | undefined>;
}

/** One upload the context's route saw: the host's status, and whether the class byte was rewritten on its way. */
export interface UploadSeen { status: number; relabelled: boolean }
export interface UploadHold { relabel: boolean; readonly seen: UploadSeen[] }

/**
 * Routes the group message upload (`POST /v1/groups/<id>/message`) of every page in `context`. While `relabel` is set, the
 * class (the last byte of the body, CBOR `[epoch, private_message, class]`) goes out as 1 instead of 0. The host's
 * answer is recorded in `seen` and handed back unchanged.
 */
export async function holdUploads(context: BrowserContext): Promise<UploadHold> {
  const hold: UploadHold = { relabel: false, seen: [] };
  await context.route(/\/v1\/groups\/[0-9a-f]{32}\/message$/, async (route) => {
    const request = route.request();
    const body = request.postDataBuffer();
    if (request.method() !== 'POST' || body === null) { await route.fallback(); return; }
    const relabel = hold.relabel && body.length > 0 && body[body.length - 1] === 0x00;
    if (relabel) body[body.length - 1] = 0x01;
    const response = await route.fetch(relabel ? { postData: body } : {});
    hold.seen.push({ status: response.status(), relabelled: relabel });
    await route.fulfill({ response });
  });
  return hold;
}
