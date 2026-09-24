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

const appendButton = document.getElementById('append') as HTMLButtonElement | null;

/**
 * Ruling J. The control ships `disabled` in the markup and is enabled only when the worker reports
 * `ready`, i.e. the store is open and no request is in flight. `mode` is rendered from the
 * persistence probe, which happens much earlier — an append clicked in between used to be posted to
 * a worker that had no listener for it yet, and was simply lost (CI run 35969515418: `rows` stuck at
 * 1 after the click). Disabling it again while a request is in flight is what serialises the
 * requests; the worker queues anything that still slips through.
 */
let inFlight = 0;

function setAppendEnabled(enabled: boolean): void {
  if (appendButton !== null) appendButton.disabled = !enabled;
  state.appendEnabled = enabled;
}

// The markup already carries `disabled`, so the control is inert before this module even runs; this
// makes the same fact true of the exposed state, and keeps the page correct if the attribute is ever
// dropped from index.html.
setAppendEnabled(false);

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
    case 'ready':
      // The store is open and idle: appending is now something the worker can actually do.
      setAppendEnabled(true);
      break;
    case 'rows':
      // The follower's answer from the leader over the BroadcastChannel; it opened no store of its
      // own, so this must not enable its control.
      text('rows', String(report.rows ?? ''));
      break;
    case 'append-done':
      // Re-read from the store by the worker after the write, never counted up here.
      text('rows', String(report.rows ?? ''));
      inFlight -= 1;
      if (inFlight <= 0) {
        inFlight = 0;
        setAppendEnabled(true);
      }
      break;
    case 'resigned':
      text('role', 'resigned');
      // The connection is closed and the VFS paused: there is nothing left to append to.
      setAppendEnabled(false);
      break;
    case 'error':
      text('role', 'error');
      state.errorMessage = report.message;
      setAppendEnabled(false);
      banner(`Store error: ${report.message ?? 'unknown'}`);
      break;
    default:
      break;
  }
});

appendButton?.addEventListener('click', () => {
  inFlight += 1;
  setAppendEnabled(false);
  worker.postMessage({ type: 'append' });
});
document.getElementById('resign')?.addEventListener('click', () => {
  worker.postMessage({ type: 'resign' });
});

worker.postMessage({ type: 'start', instance, badKek });
