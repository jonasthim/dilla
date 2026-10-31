export interface UpdateWatcher {
  realtime?: { state(): { ready: boolean; entry: string | null }; subscribe(listener: () => void): () => void };
  currentEntry: string;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  changed(entry: string): void;
  intervalMs: number;
  voiceIntervalMs?: number;
  /** A live voice call needs the update check even when its tab is hidden. */
  shouldCheck?: () => boolean;
}

export function watchUpdates(options: UpdateWatcher): () => void {
  let active = true;
  let checking = false;
  let announced = false;
  let queued = false;
  const validEntry = (entry: unknown): entry is string => typeof entry === 'string' && entry.length <= 512
    && /^\/assets\/[A-Za-z0-9_./-]+\.js$/.test(entry) && !entry.includes('..');
  const check = async () => {
    if (!active || checking || announced) return;
    checking = true;
    try {
      const response = await options.fetch('/app-version.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const value: unknown = await response.json();
      const entry = typeof value === 'object' && value !== null && 'entry' in value ? value.entry : null;
      if (!validEntry(entry)) return;
      if (active && entry !== options.currentEntry) {
        announced = true;
        options.changed(entry);
      }
    } catch { /* A transient outage is retried on the next tick. */ }
    finally { checking = false; if (queued) { queued = false; void check(); } }
  };
  let ready = options.realtime?.state().ready ?? false;
  let lastHint = options.currentEntry;
  const reconcile = () => { if (checking) queued = true; else void check(); };
  const unsubscribe = options.realtime?.subscribe(() => {
    const state = options.realtime!.state();
    const reconnected = state.ready && !ready;
    ready = state.ready;
    const hint = state.ready && validEntry(state.entry) && state.entry !== lastHint;
    if (hint) lastHint = state.entry!;
    if (reconnected || hint) reconcile();
  });
  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  const onOnline = () => { void check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  const timer = window.setInterval(() => { if (!ready && document.visibilityState === 'visible') void check(); }, options.intervalMs);
  const voiceTimer = window.setInterval(() => { if (!ready && options.shouldCheck?.()) void check(); }, options.voiceIntervalMs ?? Math.min(30_000, options.intervalMs));
  void check();
  return () => {
    active = false;
    unsubscribe?.();
    clearInterval(timer);
    clearInterval(voiceTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}
