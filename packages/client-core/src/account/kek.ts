import { fromHex } from '../hex';

export interface KekStore { load(instanceHex: string): Promise<Uint8Array | null>; create(instanceHex: string): Promise<Uint8Array>; remove(instanceHex: string): Promise<void>; }
export const KEK_DB = 'dilla-device';
export const KEK_DB_VERSION = 1;
export const KEK_STORE = 'kek';

interface RecordV1 { v: 1; wrapKey: CryptoKey; iv: Uint8Array; ct: Uint8Array }
function error(value: unknown): Error { return value instanceof Error ? value : new Error('E_KEK_DB'); }
function openDb(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(KEK_DB, KEK_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEK_STORE)) db.createObjectStore(KEK_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(error(req.error));
  });
}
function inTx<T>(idb: IDBFactory, mode: IDBTransactionMode,
  act: (store: IDBObjectStore, done: (value: T) => void, fail: (err: unknown) => void, tx: IDBTransaction) => void): Promise<T> {
  return openDb(idb).then(async (db) => {
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(KEK_STORE, mode);
        let settled = false;
        const done = (value: T) => { if (!settled) { settled = true; resolve(value); } };
        const fail = (err: unknown) => { if (!settled) { settled = true; reject(error(err)); } };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
        try { act(tx.objectStore(KEK_STORE), done, fail, tx); } catch (err) { fail(err); }
      });
    } finally { db.close(); }
  });
}
function aad(instanceHex: string): Uint8Array<ArrayBuffer> {
  const label = new TextEncoder().encode('dilla kek v1');
  const id = fromHex(instanceHex);
  const out = new Uint8Array(label.length + id.length);
  out.set(label); out.set(id, label.length);
  return out;
}

export function indexedDbKekStore(idb: IDBFactory, subtle: SubtleCrypto,
  getRandomValues: (a: Uint8Array) => Uint8Array): KekStore {
  return {
    async create(instanceHex) {
      const wrapKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const kek = getRandomValues(new Uint8Array(32));
      const iv = getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: aad(instanceHex) },
        wrapKey, new Uint8Array(kek)));
      try {
        return await inTx<Uint8Array>(idb, 'readwrite', (store, done, fail, tx) => {
          const record: RecordV1 = { v: 1, wrapKey, iv, ct };
          const request = store.add(record, instanceHex);
          request.onerror = () => fail(request.error);
          tx.oncomplete = () => done(kek);
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'ConstraintError') throw new Error('E_KEK_EXISTS');
        throw err;
      }
    },
    async load(instanceHex) {
      const record = await inTx<unknown>(idb, 'readonly', (store, done, fail) => {
        const request = store.get(instanceHex);
        request.onsuccess = () => done(request.result);
        request.onerror = () => fail(request.error);
      });
      if (record === undefined) return null;
      if (typeof record !== 'object' || record === null) throw new Error('E_KEK_UNWRAP');
      const r = record as Partial<RecordV1>;
      if (r.v !== 1 || !(r.iv instanceof Uint8Array) || r.iv.length !== 12 ||
        !(r.ct instanceof Uint8Array) || r.ct.length !== 48 || typeof r.wrapKey !== 'object' || r.wrapKey === null) {
        throw new Error('E_KEK_UNWRAP');
      }
      try {
        const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(r.iv), additionalData: aad(instanceHex) },
          r.wrapKey, new Uint8Array(r.ct)));
        if (plain.length !== 32) throw new Error('E_KEK_UNWRAP');
        return plain.slice();
      } catch { throw new Error('E_KEK_UNWRAP'); }
    },
    async remove(instanceHex) {
      await inTx<void>(idb, 'readwrite', (store, done, fail, tx) => {
        const request = store.delete(instanceHex);
        request.onerror = () => fail(request.error);
        tx.oncomplete = () => done();
      });
    },
  };
}
