/** The browser actions the page triggers, behind one object so tests can replace them. */
export const browser = {
  reload(): void { window.location.reload(); },
  print(): void { window.print(); },
  /** StorageManager.persist() is exposed on Window only, so the page asks, not the worker (L-TS-09). */
  persistStorage(): Promise<boolean> { return navigator.storage?.persist?.() ?? Promise.resolve(false); },
};
