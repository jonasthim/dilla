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
  private pending = 0;
  constructor(private readonly idb: FakeIdb, readonly mode: IDBTransactionMode) {}
  objectStore(name: string): { get(key: string): FakeRequest; put(value: unknown, key: string): FakeRequest } {
    const records = this.idb.stores.get(name);
    if (records === undefined) throw new DOMException(`no object store ${name}`, 'NotFoundError');
    return {
      get: (key: string) => this.run(() => records.get(key)),
      put: (value: unknown, key: string) => {
        if (this.mode !== 'readwrite') throw new DOMException('the transaction is read-only', 'ReadOnlyError');
        return this.run(() => { records.set(key, structuredClone(value)); return key; });
      },
    };
  }
  private run(op: () => unknown): FakeRequest {
    const request = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      request.result = op();
      request.onsuccess?.({ target: request });
      this.pending -= 1;
      if (this.pending === 0) queueMicrotask(() => this.oncomplete?.({ target: this }));
    });
    return request;
  }
}

/** One in-memory IndexedDB. `failOpen` makes every open fail; `hang` makes it never answer. */
export class FakeIdb {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly opened: { name: string; version: number }[] = [];
  failOpen = false;
  hang = false;
  private version = 0;
  open(name: string, version: number): FakeRequest {
    const request = new FakeRequest();
    queueMicrotask(() => {
      this.opened.push({ name, version });
      if (this.hang) return;
      if (this.failOpen) {
        request.error = new DOMException('the open failed', 'UnknownError');
        request.onerror?.({ target: request });
        return;
      }
      let upgrading = false;
      request.result = {
        objectStoreNames: { contains: (n: string) => this.stores.has(n) },
        createObjectStore: (n: string) => {
          if (!upgrading) throw new DOMException('not in a version change', 'InvalidStateError');
          this.stores.set(n, new Map());
          return {};
        },
        transaction: (_n: string, mode: IDBTransactionMode = 'readonly') => new FakeTransaction(this, mode),
        close: () => {},
      };
      if (version > this.version) {
        this.version = version;
        upgrading = true;
        request.onupgradeneeded?.({ target: request });
        upgrading = false;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }
  get factory(): IDBFactory {
    return this as unknown as IDBFactory;
  }
}
