interface WorkerReport {
  type: string;
  order?: string[];
  mode?: 'opfs' | 'memory';
  reason?: string;
  attempts?: number;
  elapsedMs?: number;
  rows?: number;
  hadMarker?: boolean;
  capacity?: number;
  plainVfsMessage?: string;
  wrongKeyMessage?: string;
  name?: string;
  message?: string;
}

const params = new URLSearchParams(location.search);
const instance = params.get('instance') ?? 'default';
// The e2e negative test's only lever: it makes the worker open the store with a KEK `store_open`
// rejects on sight, so the elected-leader path fails permanently. No key material crosses the URL.
const badKek = params.get('badkek') === '1';
const visitedKey = `dilla:visited:${instance}`;

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el !== null) el.textContent = value;
}

function banner(message: string): void {
  const el = document.getElementById('banner');
  if (el === null) return;
  el.textContent = message;
  el.hidden = false;
}

const state: Record<string, unknown> = { order: [], instance };
(globalThis as unknown as { __dilla: Record<string, unknown> }).__dilla = state;

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

worker.addEventListener('message', (event: MessageEvent<WorkerReport>) => {
  const report = event.data;
  if (report.order !== undefined) state.order = report.order;

  switch (report.type) {
    case 'probe':
      text('mode', report.mode ?? '');
      text('reason', report.reason ?? '');
      state.mode = report.mode;
      state.reason = report.reason;
      break;
    case 'memory-boot':
      text('role', 'memory');
      // gap-15 AC-7: the copy states the effect, never "you are in a private window" — the same
      // SecurityError fires in a normal Firefox window with site storage blocked.
      banner("Messages in this window won't be saved on this device.");
      break;
    case 'follower':
      text('role', 'follower');
      break;
    case 'leader-elected': {
      text('role', 'leader');
      text('attempts', String(report.attempts ?? ''));
      text('elapsed', String(Math.round(report.elapsedMs ?? 0)));
      text('rows', String(report.rows ?? ''));
      state.attempts = report.attempts;
      state.elapsedMs = report.elapsedMs;
      state.capacity = report.capacity;
      state.plainVfsMessage = report.plainVfsMessage;
      state.wrongKeyMessage = report.wrongKeyMessage;

      // gap-15 AC-6 option (b): engine-independent detection of a cleared store. Chrome incognito
      // reports mode "opfs" and still loses everything, so the probe alone cannot see this.
      const visitedBefore = localStorage.getItem(visitedKey) === '1';
      localStorage.setItem(visitedKey, '1');
      if (visitedBefore && report.hadMarker === false) {
        text('marker', 'cleared');
        banner('Storage was cleared since your last visit.');
      } else {
        text('marker', visitedBefore ? 'kept' : 'first-visit');
      }
      break;
    }
    case 'rows':
      text('rows', String(report.rows ?? ''));
      break;
    case 'resigned':
      text('role', 'resigned');
      break;
    case 'error':
      text('role', 'error');
      state.errorMessage = report.message;
      banner(`Store error: ${report.message ?? 'unknown'}`);
      break;
    default:
      break;
  }
});

document.getElementById('append')?.addEventListener('click', () => {
  worker.postMessage({ type: 'append' });
});
document.getElementById('resign')?.addEventListener('click', () => {
  worker.postMessage({ type: 'resign' });
});

worker.postMessage({ type: 'start', instance, badKek });
