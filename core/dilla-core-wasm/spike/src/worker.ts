/// <reference lib="webworker" />
import init, {
  is_sah_contention,
  store_open,
  unencrypted_vfs_probe,
  wrong_key_probe,
  StoreOpenConfig,
  type StoreHandle,
} from '../pkg/dilla_core_wasm.js';
import { channelName, elect, type LeaderMessage } from './leader.js';
import { probePersistence } from './probe.js';

/** SQLite upstream's own schedule for this exact contention (gap-14 §5): 6 tries over ~4.5 s. */
const BACKOFF_MS = [300, 600, 900, 1200, 1500] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** A fixed spike KEK. The real device KEK comes from the pairing flow; this is not that. */
const SPIKE_KEK_HEX = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
/** A different 64-hex KEK, used once against the already-written database to prove the SELECT is the
 *  key check and `PRAGMA key` is not (gap-13 §2.2, interfaces §6 task 17). */
const WRONG_KEK_HEX = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';
/** Not 64 hex characters, so `store_open` rejects it before it touches SQLite (`E_STORE_KEK`) and
 *  `is_sah_contention` classifies the rejection as false — a permanent failure, which is the branch
 *  the e2e negative test needs and the only one the spike can provoke on demand. Reached only via
 *  `?badkek=1`; no key material ever crosses the URL. */
const INVALID_KEK_HEX = 'not-a-key';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const order: string[] = [];
let handle: StoreHandle | undefined;

function post(message: Record<string, unknown>): void {
  scope.postMessage({ ...message, order: [...order] });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    scope.setTimeout(resolve, ms);
  });
}

interface Opened {
  handle: StoreHandle;
  attempts: number;
  elapsedMs: number;
}

/**
 * One `store_open` per attempt; the retry lives here, not in Rust, because the attempt count is
 * what the spike has to report. Only contention is retried — `ConfigurationMismatch`,
 * `NotSupported` and `NoCapacity` are permanent (gap-14 §5).
 */
async function openWithRetry(directory: string, dbName: string, kekHex: string): Promise<Opened> {
  const started = performance.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // A fresh StoreOpenConfig per attempt. `store_open` takes it **by value**, so wasm-bindgen's glue
    // calls `cfg.__destroy_into_raw()` and nulls the wrapper's pointer on the first call; reusing one
    // config makes attempt 2 throw `Error: null pointer passed to rust`, which `is_sah_contention`
    // classifies as false, so the loop rethrows and the whole retry budget this spike exists to
    // measure becomes dead code. gap-14 §0/§3 says a first failure right after a hand-over is the
    // expected, self-healing case, and task 18 asserts attempt 2 works.
    const cfg = new StoreOpenConfig(directory, dbName, kekHex);
    try {
      const opened = await store_open(cfg);
      return { handle: opened, attempts: attempt, elapsedMs: performance.now() - started };
    } catch (err) {
      if (!is_sah_contention(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(BACKOFF_MS[attempt - 1]);
    }
  }
  throw new Error('unreachable: the loop returns or throws');
}

async function run(instance: string, badKek: boolean): Promise<void> {
  await init();

  order.push('probe');
  const persistence = await probePersistence();
  post({ type: 'probe', ...persistence });

  if (persistence.mode === 'memory') {
    // gap-15 AC-5: install() is never called, so no .opfs-sahpool directory is created.
    order.push('memory-boot');
    post({ type: 'memory-boot' });
    return;
  }

  // Created before `elect` so that both callbacks can use it: the follower sends its call the moment
  // it learns the lock is taken, and the leader answers on the session channel.
  const channel = new BroadcastChannel(channelName(instance));
  channel.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as LeaderMessage;
    post({ type: 'event', name: data.type });
    if (data.type === 'event' && data.name === 'rows') {
      post({ type: 'rows', rows: Number(data.detail) });
    }
  });

  elect(
    instance,
    async (session) => {
      order.push('install');
      const opened = await openWithRetry(
        `dilla/${instance}`,
        'dilla.db',
        badKek ? INVALID_KEK_HEX : SPIKE_KEK_HEX,
      );
      handle = opened.handle;
      // NV-13's exported async method, exercised once so it is never shipped untested.
      await handle.reserve_capacity(16);

      // gap-13 §3: the plain VFS name cannot carry a key. Proving it here keeps the trap from
      // silently coming back if someone "simplifies" the VFS name later.
      order.push('plain-vfs-probe');
      let plainVfsMessage: string;
      try {
        plainVfsMessage = unencrypted_vfs_probe('plain.db', SPIKE_KEK_HEX);
      } catch (err) {
        plainVfsMessage = `unexpected: ${String(err)}`;
      }

      handle.exec('CREATE TABLE IF NOT EXISTS spike_meta (key TEXT PRIMARY KEY, value TEXT);');
      const hadMarker =
        handle.query_scalar_i64("SELECT count(*) FROM spike_meta WHERE key = 'boot_marker'") > 0;
      handle.exec("INSERT OR REPLACE INTO spike_meta (key, value) VALUES ('boot_marker', '1');");

      // gap-13 §2.2: `PRAGMA key` always reports ok, so the SELECT is the key check. This runs AFTER
      // the table and the row exist — on an empty database there is no page to decrypt and a wrong key
      // would pass. interfaces §6 task 17 requires this assertion and nothing in §2.11 could make it.
      order.push('wrong-key-probe');
      let wrongKeyMessage: string;
      try {
        wrongKeyMessage = await wrong_key_probe('dilla.db', WRONG_KEK_HEX);
      } catch (err) {
        wrongKeyMessage = `unexpected: ${String(err)}`;
      }

      order.push('leader-elected');
      session.channel.postMessage({ type: 'leader-elected', instance });
      post({
        type: 'leader-elected',
        attempts: opened.attempts,
        elapsedMs: opened.elapsedMs,
        rows: handle.query_scalar_i64('SELECT count(*) FROM spike_meta'),
        hadMarker,
        capacity: handle.capacity(),
        plainVfsMessage,
        wrongKeyMessage,
      });

      // The other half of the leader contract (spec, "Browser hosting (fixes the SharedWorker
      // flaw)"): followers forward calls over the BroadcastChannel and render from the leader's
      // events. One call and one event is the whole round trip the week-1 spike needs to prove it.
      session.channel.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as LeaderMessage;
        if (data.type === 'call' && data.fn === 'rows' && handle !== undefined) {
          session.channel.postMessage({
            type: 'event',
            name: 'rows',
            detail: handle.query_scalar_i64('SELECT count(*) FROM spike_meta'),
          } satisfies LeaderMessage);
        }
      });

      scope.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type: string };
        if (data.type === 'append' && handle !== undefined) {
          handle.exec(
            `INSERT OR REPLACE INTO spike_meta (key, value) VALUES ('row-${Date.now()}', 'x');`,
          );
          post({ type: 'rows', rows: handle.query_scalar_i64('SELECT count(*) FROM spike_meta') });
        }
        if (data.type === 'resign' && handle !== undefined) {
          // The order below is the contract: connection closed, VFS paused, message posted, lock
          // released. pause_vfs() errors while any file handle is open (gap-11 §9 item 5).
          // `lock-released` is NOT pushed here: `resign()` only resolves the `held` promise, and the
          // browser releases the lock later, when the locks.request callback's promise settles. It is
          // recorded in `elect`'s `onReleased`, which runs from a `.finally()` on that promise.
          order.push('resign-start');
          handle.pause();
          order.push('pause');
          session.channel.postMessage({ type: 'leader-resigned', instance });
          order.push('leader-resigned');
          session.resign();
          post({ type: 'resigned' });
        }
      });
    },
    () => {
      order.push('follower');
      post({ type: 'follower' });
      // A follower opens no store of its own; it asks the leader and renders the answer.
      channel.postMessage({ type: 'call', id: 1, fn: 'rows', args: [] } satisfies LeaderMessage);
    },
    () => {
      // Fired from `.finally()` on navigator.locks.request, i.e. after the browser has actually
      // released the lock — not when `resign()` was called.
      order.push('lock-released');
      post({ type: 'lock-released' });
    },
    (err: unknown) => {
      // The elected-leader path failed. `run()` returned the moment `elect` did, so this is the only
      // place that can see it; without it the rejection is swallowed by the worker and the page sits
      // on an empty role forever. main.ts already renders this branch.
      order.push('leader-failed');
      post({ type: 'error', message: String(err) });
    },
  );
}

scope.addEventListener('message', function bootstrap(event: MessageEvent) {
  const data = event.data as { type: string; instance?: string; badKek?: boolean };
  if (data.type !== 'start' || data.instance === undefined) return;
  scope.removeEventListener('message', bootstrap);
  void run(data.instance, data.badKek === true).catch((err: unknown) => {
    post({ type: 'error', message: String(err) });
  });
});
