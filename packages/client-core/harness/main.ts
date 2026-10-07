import { CoreCallError, connectCore, type Command, type SliceName, type TestHook } from '../src/index';
import { isSpikeEvent, type SpikeEvent, type SpikeRequest } from './spike';

export type HarnessResult = { ok: true; value: unknown } | { ok: false; code: string; detail: string; status: number; retryAfterMs: number | null };
export type SpikeRecord = SpikeEvent & { at: number };
export interface SpikeApi {
  events(): SpikeRecord[];
  watchActive(communityId: string): void;
  activeLog(): { at: number; active: number }[];
  timeGroups(): Promise<Extract<SpikeEvent, { kind: 'groups' }>>;
}
export interface HarnessFileSpec { name: string; type: string; png?: { w: number; h: number }; bytes?: number; }
export interface HarnessFile { id: string; sha256: string; size: number; }
export type HarnessOpen = { ok: true; sha256: string; size: number; type: string; name: string; mime: string; head: number[] }
  | { ok: false; code: string; detail: string; status: number; retryAfterMs: number | null };
export interface HarnessApi {
  call(command: Command): Promise<HarnessResult>;
  get(name: string): unknown;
  hook(op: TestHook['op']): void;
  spike: SpikeApi;
  /** A File made in the page (a PNG drawn on a canvas, or `bytes` bytes of a fixed pattern), kept under a page-side id. */
  makeFile(spec: HarnessFileSpec): Promise<HarnessFile>;
  /** attachFiles with the kept Files of those ids (a File cannot cross page.evaluate). */
  attach(channelId: string, fileIds: readonly string[]): Promise<HarnessResult>;
  /** openAttachment, answered with the Blob's digest, size, type and first 16 bytes; nothing mints a blob: URL. */
  open(command: Extract<Command, { m: 'openAttachment' }>): Promise<HarnessOpen>;
}

// The core-worker suite's page (e2e/web/core-worker.spec.ts): the real bridge over the real worker,
// whose entry also honours the two gateway test hooks. It renders nothing; the spec reads slices.
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'dilla-core' });
const client = connectCore(worker);
const spikeEvents: SpikeRecord[] = [];
const active: { at: number; active: number }[] = [];
worker.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isSpikeEvent(event.data)) spikeEvents.push({ ...event.data, at: Date.now() });
});
const files = new Map<string, File>();
let nextFile = 0;

function refused(e: unknown): Extract<HarnessResult, { ok: false }> {
  if (e instanceof CoreCallError) return { ok: false, code: e.code, detail: e.detail, status: e.status, retryAfterMs: e.retryAfterMs };
  return { ok: false, code: 'E_HARNESS', detail: e instanceof Error ? e.message : String(e), status: 0, retryAfterMs: null };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Four quadrants and a 1-pixel diagonal, encoded as a PNG by the browser. */
function drawPng(w: number, h: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return Promise.reject(new Error('no 2d context'));
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  ctx.fillStyle = '#2e86de'; ctx.fillRect(0, 0, halfW, halfH);
  ctx.fillStyle = '#10ac84'; ctx.fillRect(halfW, 0, w - halfW, halfH);
  ctx.fillStyle = '#ee5253'; ctx.fillRect(0, halfH, halfW, h - halfH);
  ctx.fillStyle = '#feca57'; ctx.fillRect(halfW, halfH, w - halfW, h - halfH);
  ctx.strokeStyle = '#222f3e'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.stroke();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob === null) reject(new Error('toBlob gave nothing')); else resolve(blob); }, 'image/png');
  });
}

const api: HarnessApi = {
  async call(command) {
    try {
      return { ok: true, value: await client.call(command) };
    } catch (e) {
      return refused(e);
    }
  },
  async makeFile(spec) {
    let bytes: Uint8Array<ArrayBuffer>;
    if (spec.png !== undefined) bytes = new Uint8Array(await (await drawPng(spec.png.w, spec.png.h)).arrayBuffer());
    else bytes = new Uint8Array(spec.bytes ?? 0).map((_, i) => (i * 7) & 0xff);
    const id = `f${String(++nextFile)}`;
    files.set(id, new File([bytes], spec.name, { type: spec.type }));
    return { id, sha256: await sha256Hex(bytes), size: bytes.length };
  },
  async attach(channelId, fileIds) {
    const picked: File[] = [];
    for (const id of fileIds) {
      const f = files.get(id);
      if (f === undefined) return { ok: false, code: 'E_HARNESS', detail: `unknown file ${id}`, status: 0, retryAfterMs: null };
      picked.push(f);
    }
    return api.call({ m: 'attachFiles', channelId, files: picked });
  },
  async open(command) {
    let value: unknown;
    try { value = await client.call(command); }
    catch (e) { return refused(e); }
    const { blob, name, mime } = value as { blob: Blob; name: string; mime: string };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { ok: true, sha256: await sha256Hex(bytes), size: blob.size, type: blob.type, name, mime, head: Array.from(bytes.slice(0, 16)) };
  },
  get: (name) => client.get(name as SliceName) ?? null,
  hook: (op) => {
    const message: TestHook = { t: 'test', op };
    worker.postMessage(message);
  },
  spike: {
    events: () => [...spikeEvents],
    watchActive: (communityId) => {
      const name = `channels:${communityId}` as const;
      const record = (): void => {
        const channels = client.get(name);
        const count = channels?.filter((channel) => channel.group === 'active').length ?? 0;
        if (active.length === 0 || count > active[active.length - 1].active) {
          active.push({ at: Date.now(), active: count });
        }
      };
      record();
      client.subscribe(name, record);
    },
    activeLog: () => [...active],
    timeGroups: () => new Promise((resolve) => {
      const onMessage = (event: MessageEvent<unknown>): void => {
        if (!isSpikeEvent(event.data) || event.data.kind !== 'groups') return;
        worker.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ t: 'spike', op: 'time-groups' } satisfies SpikeRequest);
    }),
  },
};

(window as Window & { dilla?: HarnessApi }).dilla = api;
const status = document.getElementById('status');
if (status) status.textContent = 'ready';
