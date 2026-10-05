import { type CorePort, type CoreWasmModule, wrapCore } from '../core-port';
import { toHex } from '../hex';
import type { Instance } from '../http/routes';
import type { KekStore } from './kek';

export interface OpenedStore { core: CorePort; reserveCapacity(n: number): Promise<void>; }
export interface BootDeps {
  instance: Instance;
  probePersistence(): Promise<string>;
  storeExists(directory: string): Promise<boolean>;
  kek: KekStore;
  openCore(directory: string, dbName: string, kekHex: string): Promise<OpenedStore>;
}
export const STORE_DB_NAME = 'dilla.db';
export const RESERVE_CAPACITY = 16;
export const OPEN_BACKOFF_MS = [300, 600, 900, 1200, 1500] as const;
export const WRONG_KEY_TEXT = 'file is not a database';
export const storeDirectory = (instanceHex: string): string => `dilla/${instanceHex}`;
export type BootOutcome = { kind: 'unsupported'; reason: string } | { kind: 'store-lost' } | { kind: 'opened'; core: CorePort; instance: Instance };

export async function boot(deps: BootDeps): Promise<BootOutcome> {
  let probe: unknown;
  try { probe = JSON.parse(await deps.probePersistence()) as unknown; } catch { return { kind: 'unsupported', reason: 'probe' }; }
  if (typeof probe !== 'object' || probe === null || !('mode' in probe)) return { kind: 'unsupported', reason: 'probe' };
  if (probe.mode !== 'opfs') return { kind: 'unsupported', reason: 'reason' in probe && typeof probe.reason === 'string' ? probe.reason : '' };
  const hex = toHex(deps.instance.instanceId);
  const dir = storeDirectory(hex);
  let kek: Uint8Array | null;
  try { kek = await deps.kek.load(hex); }
  catch (err) { if (err instanceof Error && err.message === 'E_KEK_UNWRAP') return { kind: 'store-lost' }; throw err; }
  if (kek === null) {
    if (await deps.storeExists(dir)) return { kind: 'store-lost' };
    kek = await deps.kek.create(hex);
  }
  let opened: OpenedStore;
  try {
    try { opened = await deps.openCore(dir, STORE_DB_NAME, toHex(kek)); }
    finally { kek.fill(0); }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('E_STORE_KEY') && err.message.includes(WRONG_KEY_TEXT)) return { kind: 'store-lost' };
    throw err;
  }
  await opened.reserveCapacity(RESERVE_CAPACITY);
  return { kind: 'opened', core: opened.core, instance: deps.instance };
}

export function wasmCoreOpener(mod: CoreWasmModule, sleep: (ms: number) => Promise<void>): BootDeps['openCore'] {
  return async (directory, dbName, kekHex) => {
    for (let attempt = 1; attempt <= OPEN_BACKOFF_MS.length + 1; attempt++) {
      try {
        const cfg = new mod.StoreOpenConfig(directory, dbName, kekHex);
        const handle = await mod.core_open(cfg);
        return { core: wrapCore(handle), reserveCapacity: (n: number) => handle.reserve_capacity(n) };
      } catch (err) {
        if (!mod.is_sah_contention(err) || attempt > OPEN_BACKOFF_MS.length) throw err;
        await sleep(OPEN_BACKOFF_MS[attempt - 1] ?? 0);
      }
    }
    throw new Error('E_STORE_OPEN');
  };
}

export async function opfsDirectoryExists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  let directory = root;
  for (const segment of path.split('/').filter(Boolean)) {
    try { directory = await directory.getDirectoryHandle(segment); }
    catch (err) {
      if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return false;
      throw err;
    }
  }
  return true;
}
