import { describe, expect, it } from 'vitest';
import { encode } from '../cbor';
import type { CoreHandle, CoreWasmModule, StoreOpenConfigLike } from '../core-port';
import type { Instance } from '../http/routes';
import { FakeCore } from '../testing/fake-core';
import { boot, opfsDirectoryExists, OPEN_BACKOFF_MS, RESERVE_CAPACITY, STORE_DB_NAME, storeDirectory, wasmCoreOpener,
  WRONG_KEY_TEXT, type BootDeps } from './boot';
import type { KekStore } from './kek';

const INSTANCE: Instance = { instanceId: new Uint8Array(16).fill(0xab), generation: 1n, name: 'dilla.test', registrationMode: 0,
  authMethods: [0], policyVersion: 1n, externalSenderPub: new Uint8Array(32).fill(0xcd) };
const HEX = 'ab'.repeat(16);

class MemoryKek implements KekStore {
  readonly records = new Map<string, Uint8Array>();
  readonly handedOut: Uint8Array[] = [];
  failLoad: Error | null = null;
  load(hex: string): Promise<Uint8Array | null> {
    if (this.failLoad !== null) return Promise.reject(this.failLoad);
    const r = this.records.get(hex);
    if (r === undefined) return Promise.resolve(null);
    const copy = r.slice();
    this.handedOut.push(copy);
    return Promise.resolve(copy);
  }
  create(hex: string): Promise<Uint8Array> {
    if (this.records.has(hex)) return Promise.reject(new Error('E_KEK_EXISTS'));
    this.records.set(hex, new Uint8Array(32).fill(0x5a));
    const copy = new Uint8Array(32).fill(0x5a);
    this.handedOut.push(copy);
    return Promise.resolve(copy);
  }
  remove(hex: string): Promise<void> {
    this.records.delete(hex);
    return Promise.resolve();
  }
}

function setup(over: Partial<BootDeps> = {}) {
  const opened: { directory: string; dbName: string; kekHex: string }[] = [];
  const reserved: number[] = [];
  const probedDirs: string[] = [];
  const core = new FakeCore();
  const kek = new MemoryKek();
  const deps: BootDeps = {
    instance: INSTANCE,
    probePersistence: () => Promise.resolve('{"mode":"opfs"}'),
    storeExists: (dir) => {
      probedDirs.push(dir);
      return Promise.resolve(false);
    },
    kek,
    openCore: (directory, dbName, kekHex) => {
      opened.push({ directory, dbName, kekHex });
      return Promise.resolve({ core, reserveCapacity: (n) => {
        reserved.push(n);
        return Promise.resolve();
      } });
    },
    ...over,
  };
  return { deps, opened, reserved, probedDirs, core, kek };
}

describe('boot', () => {
  it('pins the store names', () => {
    expect([STORE_DB_NAME, RESERVE_CAPACITY, storeDirectory(HEX)]).toEqual(['dilla.db', 16, `dilla/${HEX}`]);
    expect(OPEN_BACKOFF_MS).toEqual([300, 600, 900, 1200, 1500]);
    expect(WRONG_KEY_TEXT).toBe('file is not a database');
  });

  it('refuses a browser without a persistent store and touches nothing', async () => {
    const t = setup({ probePersistence: () => Promise.resolve('{"mode":"memory","reason":"getDirectory:SecurityError"}') });
    expect(await boot(t.deps)).toEqual({ kind: 'unsupported', reason: 'getDirectory:SecurityError' });
    expect(t.opened).toEqual([]);
    expect(t.kek.records.size).toBe(0);
    const bad = setup({ probePersistence: () => Promise.resolve('not json') });
    expect(await boot(bad.deps)).toEqual({ kind: 'unsupported', reason: 'probe' });
  });

  it('creates a KEK on first run, opens the store with it, reserves capacity and zero-fills the KEK', async () => {
    const t = setup();
    const out = await boot(t.deps);
    expect(out).toEqual({ kind: 'opened', core: t.core, instance: INSTANCE });
    expect(t.probedDirs).toEqual([`dilla/${HEX}`]);
    expect(t.opened).toEqual([{ directory: `dilla/${HEX}`, dbName: 'dilla.db', kekHex: '5a'.repeat(32) }]);
    expect(t.reserved).toEqual([16]);
    expect(t.kek.handedOut).toHaveLength(1);
    expect(t.kek.handedOut[0]).toEqual(new Uint8Array(32));
  });

  it('reuses an existing KEK without asking whether a store exists', async () => {
    const t = setup();
    t.kek.records.set(HEX, new Uint8Array(32).fill(0x77));
    await boot(t.deps);
    expect(t.opened[0]?.kekHex).toBe('77'.repeat(32));
    expect(t.probedDirs).toEqual([]);
    expect(t.kek.handedOut[0]).toEqual(new Uint8Array(32));
  });

  it('reports store-lost when a store exists without its KEK', async () => {
    const t = setup({ storeExists: () => Promise.resolve(true) });
    expect(await boot(t.deps)).toEqual({ kind: 'store-lost' });
    expect(t.kek.records.size).toBe(0);
    expect(t.opened).toEqual([]);
  });

  it('reports store-lost when the KEK does not unwrap, and propagates other KEK failures', async () => {
    const t = setup();
    t.kek.failLoad = new Error('E_KEK_UNWRAP');
    expect(await boot(t.deps)).toEqual({ kind: 'store-lost' });
    const u = setup();
    u.kek.failLoad = new Error('IndexedDB is unavailable');
    await expect(boot(u.deps)).rejects.toThrow('IndexedDB is unavailable');
  });

  it('reports store-lost when the store refuses the key, and zero-fills the KEK', async () => {
    const t = setup({ openCore: () => Promise.reject(new Error('E_STORE_KEY: file is not a database')) });
    t.kek.records.set(HEX, new Uint8Array(32).fill(0x77));
    expect(await boot(t.deps)).toEqual({ kind: 'store-lost' });
    expect(t.kek.handedOut).toHaveLength(1);
    expect(t.kek.handedOut[0]).toEqual(new Uint8Array(32));
    const full = setup({ openCore: () => Promise.reject(new Error('E_STORE_KEY: SELECT count(*) FROM sqlite_schema: file is not a database')) });
    full.kek.records.set(HEX, new Uint8Array(32).fill(0x77));
    expect(await boot(full.deps)).toEqual({ kind: 'store-lost' });
  });

  it('a store that cannot be opened for another reason offers no reset', async () => {
    const unreadable = new Error('E_STORE_KEY: unable to open database file');
    const t = setup({ openCore: () => Promise.reject(unreadable) });
    t.kek.records.set(HEX, new Uint8Array(32).fill(0x77));
    await expect(boot(t.deps)).rejects.toBe(unreadable);
    expect(t.kek.handedOut).toHaveLength(1);
    expect(t.kek.handedOut[0]).toEqual(new Uint8Array(32));
    expect(t.kek.records.get(HEX)).toEqual(new Uint8Array(32).fill(0x77));
    const io = new Error('E_STORE_OPEN: disk I/O error');
    const u = setup({ openCore: () => Promise.reject(io) });
    await expect(boot(u.deps)).rejects.toBe(io);
    expect(u.kek.handedOut[0]).toEqual(new Uint8Array(32));
  });
});

class FakeConfig implements StoreOpenConfigLike {
  static made: FakeConfig[] = [];
  constructor(readonly directory: string, readonly db_name: string, readonly kek_hex: string) {
    FakeConfig.made.push(this);
  }
}

describe('wasmCoreOpener', () => {
  const contention = new DOMException('Access Handles cannot be created', 'NoModificationAllowedError');
  const reservations: number[] = [];
  const handle = new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      if (prop === 'reserve_capacity') {
        reservations.push(args[0] as number);
        return Promise.resolve();
      }
      if (prop === 'identity') return encode([0, null, null, null, '', 0]);
      throw new Error(`stub: ${String(prop)} is not stubbed`);
    },
  }) as unknown as CoreHandle;

  function module(failures: Error[]): CoreWasmModule {
    let call = 0;
    return {
      core_open: () => {
        const failure = failures[call];
        call += 1;
        return failure === undefined ? Promise.resolve(handle) : Promise.reject(failure);
      },
      StoreOpenConfig: FakeConfig,
      is_sah_contention: (err) => err === contention,
      probe_persistence: () => Promise.resolve('{"mode":"opfs"}'),
    };
  }

  it('retries contention on the spike schedule with a fresh config per attempt', async () => {
    FakeConfig.made = [];
    const sleeps: number[] = [];
    const open = wasmCoreOpener(module([contention, contention]), (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
    const store = await open(`dilla/${HEX}`, 'dilla.db', 'aa'.repeat(32));
    expect(FakeConfig.made).toHaveLength(3);
    expect(new Set(FakeConfig.made).size).toBe(3);
    expect(FakeConfig.made[2]).toMatchObject({ directory: `dilla/${HEX}`, db_name: 'dilla.db', kek_hex: 'aa'.repeat(32) });
    expect(sleeps).toEqual([300, 600]);
    await store.reserveCapacity(16);
    expect(reservations).toEqual([16]);
    expect(store.core.identity().phase).toBe(0);
  });

  it('rethrows anything else at once, and contention after six attempts', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const refused = new Error('E_STORE_KEY: wrong key');
    await expect(wasmCoreOpener(module([refused]), sleep)('d', 'dilla.db', 'aa'.repeat(32))).rejects.toBe(refused);
    expect(sleeps).toEqual([]);
    await expect(wasmCoreOpener(module(Array.from({ length: 6 }, () => contention)), sleep)('d', 'dilla.db', 'aa'.repeat(32)))
      .rejects.toBe(contention);
    expect(sleeps).toEqual([300, 600, 900, 1200, 1500]);
  });
});

class FakeDir {
  constructor(private readonly children: Map<string, FakeDir | Error>) {}
  getDirectoryHandle(name: string): Promise<FakeDir> {
    const child = this.children.get(name);
    if (child === undefined) return Promise.reject(new DOMException(name, 'NotFoundError'));
    if (child instanceof Error) return Promise.reject(child);
    return Promise.resolve(child);
  }
}

describe('opfsDirectoryExists', () => {
  const asRoot = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;
  it('walks the path and answers whether it exists', async () => {
    const root = new FakeDir(new Map([['dilla', new FakeDir(new Map([[HEX, new FakeDir(new Map())]]))]]));
    expect(await opfsDirectoryExists(asRoot(root), `dilla/${HEX}`)).toBe(true);
    expect(await opfsDirectoryExists(asRoot(root), `dilla/${'cd'.repeat(16)}`)).toBe(false);
    expect(await opfsDirectoryExists(asRoot(new FakeDir(new Map())), 'dilla/x')).toBe(false);
    const file = new FakeDir(new Map([['dilla', new DOMException('a file', 'TypeMismatchError')]]));
    expect(await opfsDirectoryExists(asRoot(file), 'dilla/x')).toBe(false);
  });

  it('propagates any other failure', async () => {
    const denied = new FakeDir(new Map([['dilla', new DOMException('denied', 'SecurityError')]]));
    await expect(opfsDirectoryExists(denied as unknown as FileSystemDirectoryHandle, 'dilla/x')).rejects.toThrow('denied');
  });
});
