import { describe, expect, it } from 'vitest';
import { fromHex } from '../hex';
import { indexedDbKekStore, KEK_DB, KEK_DB_VERSION, KEK_STORE } from './kek';

const HEX = 'ab'.repeat(16);
const OTHER = 'cd'.repeat(16);
const subtle = globalThis.crypto.subtle;
const random = (a: Uint8Array): Uint8Array => globalThis.crypto.getRandomValues(a);

type Handler = ((event: unknown) => void) | null;

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  private open = 0;
  private failed = false;
  constructor(private readonly idb: FakeIdb, readonly mode: string) {}
  objectStore(name: string): FakeObjectStore {
    const records = this.idb.stores.get(name);
    if (records === undefined) throw new DOMException(`no object store ${name}`, 'NotFoundError');
    return new FakeObjectStore(this, records);
  }
  /** Runs one request on a later microtask; the transaction completes after its last request. */
  run(op: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.open += 1;
    queueMicrotask(() => {
      try {
        request.result = op();
        request.onsuccess?.({ target: request });
      } catch (err) {
        request.error = err instanceof DOMException ? err : new DOMException(String(err), 'UnknownError');
        this.failed = true;
        this.error = request.error;
        request.onerror?.({ target: request });
        this.onerror?.({ target: this });
        this.onabort?.({ target: this });
      }
      this.open -= 1;
      if (this.open === 0 && !this.failed) queueMicrotask(() => this.oncomplete?.({ target: this }));
    });
    return request;
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction, private readonly records: Map<string, unknown>) {}
  get(key: string): FakeRequest {
    return this.tx.run(() => this.records.get(key));
  }
  add(value: unknown, key: string): FakeRequest {
    this.writable();
    return this.tx.run(() => {
      if (this.records.has(key)) throw new DOMException('Key already exists in the object store.', 'ConstraintError');
      this.records.set(key, value);
      return key;
    });
  }
  delete(key: string): FakeRequest {
    this.writable();
    return this.tx.run(() => {
      this.records.delete(key);
      return undefined;
    });
  }
  private writable(): void {
    if (this.tx.mode !== 'readwrite') throw new DOMException('the transaction is read-only', 'ReadOnlyError');
  }
}

class FakeDatabase {
  closed = false;
  readonly objectStoreNames = { contains: (name: string): boolean => this.idb.stores.has(name) };
  constructor(private readonly idb: FakeIdb, private readonly upgrading: () => boolean) {}
  createObjectStore(name: string): object {
    if (!this.upgrading()) throw new DOMException('not in a version change', 'InvalidStateError');
    this.idb.stores.set(name, new Map());
    return {};
  }
  transaction(_name: string, mode = 'readonly'): FakeTransaction {
    if (this.closed) throw new DOMException('the database is closed', 'InvalidStateError');
    return new FakeTransaction(this.idb, mode);
  }
  close(): void {
    this.closed = true;
  }
}

/** The IndexedDB subset kek.ts uses (one database), with the real API's asynchrony. */
class FakeIdb {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly opens: { name: string; version: number }[] = [];
  readonly databases: FakeDatabase[] = [];
  private version = 0;
  open(name: string, version: number): FakeRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.opens.push({ name, version });
      let upgrading = false;
      const db = new FakeDatabase(this, () => upgrading);
      this.databases.push(db);
      request.result = db;
      if (version > this.version) {
        const oldVersion = this.version;
        this.version = version;
        upgrading = true;
        request.onupgradeneeded?.({ target: request, oldVersion, newVersion: version });
        upgrading = false;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}

interface StoredRecord { v: number; wrapKey: CryptoKey; iv: Uint8Array; ct: Uint8Array }

function setup() {
  const idb = new FakeIdb();
  const store = indexedDbKekStore(idb as unknown as IDBFactory, subtle, random);
  const records = () => {
    const r = idb.stores.get(KEK_STORE);
    if (r === undefined) throw new Error('no kek store');
    return r;
  };
  const stored = (key: string): StoredRecord => {
    const rec = records().get(key) as StoredRecord | undefined;
    if (rec === undefined) throw new Error(`no record under ${key}`);
    return rec;
  };
  return { idb, store, records, stored };
}

function aad(hex: string): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode('dilla kek v1');
  const out = new Uint8Array(label.length + 16);
  out.set(label);
  out.set(fromHex(hex), label.length);
  return out;
}

describe('indexedDbKekStore', () => {
  it('names the database, its version and its store', () => {
    expect([KEK_DB, KEK_DB_VERSION, KEK_STORE]).toEqual(['dilla-device', 1, 'kek']);
  });

  it('creates a 32-byte KEK, stores it wrapped, and loads it back', async () => {
    const { idb, store, stored } = setup();
    const kek = await store.create(HEX);
    expect(kek).toHaveLength(32);
    expect(kek.some((b) => b !== 0)).toBe(true);
    expect(idb.opens[0]).toEqual({ name: 'dilla-device', version: 1 });
    const rec = stored(HEX);
    expect(rec.v).toBe(1);
    expect(rec.iv).toHaveLength(12);
    expect(rec.ct).toHaveLength(48);
    expect(await store.load(HEX)).toEqual(kek);
    expect(idb.databases.length).toBeGreaterThanOrEqual(2);
    expect(idb.databases.every((db) => db.closed)).toBe(true);
  });

  it('wraps with a non-extractable AES-GCM-256 key', async () => {
    const { store, stored } = setup();
    await store.create(HEX);
    const key = stored(HEX).wrapKey;
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
    await expect(subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('binds the wrapped KEK to its instance id', async () => {
    const { store, stored, records } = setup();
    const kek = await store.create(HEX);
    const rec = stored(HEX);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv), additionalData: aad(HEX) },
      rec.wrapKey, new Uint8Array(rec.ct)));
    expect(plain).toEqual(kek);
    await expect(subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv), additionalData: aad(OTHER) },
      rec.wrapKey, new Uint8Array(rec.ct))).rejects.toThrow();
    records().set(OTHER, rec);
    await expect(store.load(OTHER)).rejects.toThrow('E_KEK_UNWRAP');
  });

  it('returns null for a missing record and refuses to create over an existing one', async () => {
    const { store, stored } = setup();
    expect(await store.load(HEX)).toBeNull();
    await store.create(HEX);
    const before = stored(HEX).ct.slice();
    await expect(store.create(HEX)).rejects.toThrow('E_KEK_EXISTS');
    expect(stored(HEX).ct).toEqual(before);
  });

  it('refuses a tampered or malformed record', async () => {
    const { store, stored, records } = setup();
    await store.create(HEX);
    const rec = stored(HEX);
    rec.ct[0] = (rec.ct[0] ?? 0) ^ 1;
    await expect(store.load(HEX)).rejects.toThrow('E_KEK_UNWRAP');
    rec.ct[0] = (rec.ct[0] ?? 0) ^ 1;
    records().set(HEX, { ...rec, v: 2 });
    await expect(store.load(HEX)).rejects.toThrow('E_KEK_UNWRAP');
    records().set(HEX, { ...rec, iv: new Uint8Array(11) });
    await expect(store.load(HEX)).rejects.toThrow('E_KEK_UNWRAP');
  });

  it('removes a record', async () => {
    const { store } = setup();
    await store.create(HEX);
    await store.remove(HEX);
    expect(await store.load(HEX)).toBeNull();
    expect(await store.create(HEX)).toHaveLength(32);
  });
});
