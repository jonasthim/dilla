export interface UpdateWatcher {
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
  const check = async () => {
    if (!active || checking || announced) return;
    checking = true;
    try {
      const response = await options.fetch('/app-version.json', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const value: unknown = await response.json();
      const entry = typeof value === 'object' && value !== null && 'entry' in value ? value.entry : null;
      if (typeof entry !== 'string' || !/^\/assets\/[A-Za-z0-9_./-]+\.js$/.test(entry)) return;
      if (active && entry !== options.currentEntry) {
        announced = true;
        options.changed(entry);
      }
    } catch { /* A transient outage is retried on the next tick. */ }
    finally { checking = false; }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  const onOnline = () => { void check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, options.intervalMs);
  const voiceTimer = window.setInterval(() => { if (options.shouldCheck?.()) void check(); }, options.voiceIntervalMs ?? Math.min(3_000, options.intervalMs));
  void check();
  return () => {
    active = false;
    clearInterval(timer);
    clearInterval(voiceTimer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
  };
}
