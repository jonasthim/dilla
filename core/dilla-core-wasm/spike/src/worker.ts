/// <reference lib="webworker" />
import init, {
  abi_version,
  core_open,
  is_sah_contention,
  store_open,
  store_mls_probe,
  unencrypted_vfs_probe,
  wrong_key_probe,
  StoreOpenConfig,
  type StoreHandle,
  type CoreHandle,
} from '../pkg/dilla_core_wasm.js';
import { channelName, elect, type LeaderMessage, type LeaderSession } from './leader.js';
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
let resigned = false;

/** The commands the page can send once the store is open. */
type MlsOp = 'create' | 'load' | 'hold' | 'release' | 'pause' | 'resume';
type Command = { type: 'append' } | { type: 'resign' } | { type: 'mls'; id: number; op: MlsOp };

/**
 * Ruling J. `append` used to be handled by a listener installed *inside* the elected-leader callback,
 * i.e. only after `store_open`, `reserve_capacity` and both probes had finished. The page rendered
 * `mode` from the probe long before that, so a click in the window between the two was delivered to a
 * worker with no listener for it and was dropped on the floor — CI run 35969515418 failed exactly
 * there, with `rows` still reading 1. The listener is now installed once, at module scope, and a
 * command that arrives early waits here instead of vanishing. `main.ts` also keeps the control
 * disabled until `ready`, so the two halves are belt and braces: the queue makes an early command
 * late rather than lost, and the disabled control means there is normally nothing to queue.
 */
const pending: Command[] = [];
let ready = false;
let leaderSession: LeaderSession | undefined;
let instanceName = '';
let bootstrapped = false;
/**
 * Appends within the same millisecond would otherwise collide on `row-<Date.now()>` and be swallowed
 * by `INSERT OR REPLACE`, leaving the row count unchanged for a write that did happen.
 */
let appendSeq = 0;

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
 * Runs one command against the open store. `exec` and `query_scalar_i64` are synchronous, so the
 * worker's own event loop is what serialises commands: one runs to completion — write *and* the
 * re-read of the row count — before the next message is taken off the queue. The count is read back
 * after every append rather than incremented in the page, so what the page renders is what the store
 * holds.
 */
function runCommand(command: Command): void {
  if (handle === undefined || leaderSession === undefined) return;
  if (command.type === 'append') {
    appendSeq += 1;
    handle.exec(
      `INSERT OR REPLACE INTO spike_meta (key, value) VALUES ('row-${Date.now()}-${appendSeq}', 'x');`,
    );
    post({ type: 'append-done', rows: handle.query_scalar_i64('SELECT count(*) FROM spike_meta') });
    return;
  }
  if (command.type === 'mls') {
    const { id, op } = command;
    if (!['create', 'load', 'hold', 'release', 'pause', 'resume'].includes(op)) {
      post({ type: 'mls-result', id, ok: false, error: `E_SPIKE_OP: unknown op ${op}` });
      return;
    }
    if (op === 'resume') {
      ready = false;
      void handle.resume().then(
        () => post({ type: 'mls-result', id, ok: true, value: 'resumed' }),
        (err: unknown) => post({ type: 'mls-result', id, ok: false, error: (err as Error).message }),
      ).finally(() => {
        if (!resigned) ready = true;
        drain();
      });
      return;
    }
    try {
      const value = op === 'pause' ? (handle.pause(), 'paused') : store_mls_probe(handle, op);
      post({ type: 'mls-result', id, ok: true, value });
    } catch (err) {
      post({ type: 'mls-result', id, ok: false, error: (err as Error).message });
    }
    return;
  }
  // The order below is the contract: connection closed, VFS paused, message posted, lock released.
  // pause_vfs() errors while any file handle is open (gap-11 §9 item 5). `lock-released` is NOT
  // pushed here: `resign()` only resolves the `held` promise, and the browser releases the lock
  // later, when the locks.request callback's promise settles. It is recorded in `elect`'s
  // `onReleased`, which runs from a `.finally()` on that promise.
  ready = false; // the store is about to close: no further command may run against it
  resigned = true;
  order.push('resign-start');
  handle.pause();
  order.push('pause');
  leaderSession.channel.postMessage({ type: 'leader-resigned', instance: instanceName });
  order.push('leader-resigned');
  leaderSession.resign();
  post({ type: 'resigned' });
}

function drain(): void {
  while (ready && pending.length > 0) {
    runCommand(pending.shift() as Command);
  }
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

      // Everything the store needs is in place: the connection is open, capacity is reserved, both
      // probes have run and the boot marker is written. Only now is the page allowed to send
      // commands, and only now does anything queued while that was happening get to run.
      leaderSession = session;
      ready = true;
      post({ type: 'ready' });
      drain();
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

// ---- core mode (web-1 task 7): the page drives CoreHandle with `?core=1` and never posts `start`.

const CORE_INSTANCE_ID = new Uint8Array(16).fill(0x77);
const CORE_USER_ID = new Uint8Array(16).fill(0x66);
const CORE_GROUP_ID = new Uint8Array(16).fill(0x33);
const CORE_COMMUNITY_ID = new Uint8Array(16).fill(0x44);
const CORE_CHANNEL_ID = new Uint8Array(16).fill(0x55);
/** protocol/vectors/identity.json `credential_identity.fields.umk_pub`: a real Ed25519 public key. */
const CORE_EXTERNAL_SENDER_PUB = fromHex('db995fe25169d141cab9bbba92baa01f9f2e1ece7df4cb2ac05190f37fcc1f9d');
const CORE_NONCE = new Uint8Array(32).fill(0x22);
const CORE_NOW = 1_760_000_000n;
/** A fabricated 200 body of POST /v1/groups/{id}/message: [seq 1, franking_tag 32 × 0x99, recv_ts 1760000000]. */
const CORE_CONFIRM = Uint8Array.of(0x83, 0x01, 0x58, 0x20, ...new Array<number>(32).fill(0x99), 0x1a, 0x68, 0xe7, 0x78, 0x00);

let core: CoreHandle | undefined;
let wasmReady: Promise<unknown> | undefined;
/** Ops run one at a time, in arrival order. */
let coreQueue: Promise<void> = Promise.resolve();

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The message `f` throws, or 'no error' — which no assertion of the spec accepts. */
function thrown(f: () => unknown): string {
  try {
    f();
    return 'no error';
  } catch (err) {
    return errorMessage(err);
  }
}

function need(): CoreHandle {
  if (core === undefined) throw new Error('E_SPIKE_NO_CORE: run open first');
  return core;
}

/** send_prepare answers [msg_id b16]: 0x81 0x50 and 16 bytes. */
function msgIdOf(prepared: Uint8Array): Uint8Array {
  if (prepared.length !== 18 || prepared[0] !== 0x81 || prepared[1] !== 0x50) {
    throw new Error(`E_SPIKE_SHAPE: send_prepare answered ${toHex(prepared)}`);
  }
  return prepared.slice(2);
}

/** core_open with the same contention schedule as openWithRetry: a reload's predecessor may still hold the handles. */
async function openCore(instance: string): Promise<{ handle: CoreHandle; attempts: number }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const cfg = new StoreOpenConfig(`dilla/${instance}`, 'dilla.db', SPIKE_KEK_HEX);
    try {
      return { handle: await core_open(cfg), attempts: attempt };
    } catch (err) {
      if (!is_sah_contention(err) || attempt === MAX_ATTEMPTS) throw err;
      await sleep(BACKOFF_MS[attempt - 1]);
    }
  }
  throw new Error('unreachable: the loop returns or throws');
}

async function runCore(op: string, instance: string): Promise<Record<string, unknown>> {
  switch (op) {
    case 'open': {
      wasmReady ??= init();
      await wasmReady;
      const persistence = await probePersistence();
      if (persistence.mode !== 'opfs') throw new Error(`E_SPIKE_PROBE: ${persistence.reason}`);
      const opened = await openCore(instance);
      core = opened.handle;
      await core.reserve_capacity(16);
      return { abi: abi_version(), attempts: opened.attempts, phase: core.identity()[1] };
    }
    case 'signup': {
      const c = need();
      const recoveryKey = c.signup_begin(CORE_INSTANCE_ID);
      const request = c.signup_request('spike-invite', 'facade', 'Facade', null);
      const complete = c.signup_complete(CORE_USER_ID, 'facade', CORE_NOW);
      c.device_list_published();
      const keyPackages = c.key_packages(2, true);
      return {
        recoveryKey,
        requestHead: toHex(request.subarray(0, 1)),
        completeHead: toHex(complete.subarray(0, 2)),
        keyPackagesHead: toHex(keyPackages.subarray(0, 2)),
        beginAgain: thrown(() => c.signup_begin(CORE_INSTANCE_ID)),
      };
    }
    case 'group': {
      const c = need();
      const create = c.group_create(CORE_GROUP_ID, CORE_COMMUNITY_ID, CORE_CHANNEL_ID, 1n, CORE_EXTERNAL_SENDER_PUB);
      c.group_registered(CORE_GROUP_ID, 1n);
      const first = msgIdOf(c.send_prepare(CORE_GROUP_ID, 'hello from the facade', CORE_NOW));
      c.send_encrypt(first);
      const confirm = c.send_confirm(first, CORE_CONFIRM);
      const second = msgIdOf(c.send_prepare(CORE_GROUP_ID, 'still queued', CORE_NOW));
      const encrypted = c.send_encrypt(second);
      return {
        createHead: toHex(create.subarray(0, 18)),
        confirm: toHex(confirm),
        encryptHead: toHex(encrypted.subarray(0, 18)),
      };
    }
    case 'snapshot': {
      const c = need();
      return {
        identity: toHex(c.identity()),
        groups: toHex(c.groups()),
        timeline: toHex(c.timeline(CORE_GROUP_ID, 0n, 200)),
        outbox: toHex(c.outbox(CORE_GROUP_ID)),
        deviceList: toHex(c.device_list_body()),
        sealed: toHex(c.sealed_objects()),
        session: toHex(c.session_sign(CORE_NONCE, 0)),
        cursor: toHex(c.cursor_body(CORE_GROUP_ID)),
      };
    }
    case 'identity':
      return { hex: toHex(need().identity()) };
    case 'pause':
      need().pause();
      return {};
    case 'resume':
      await need().resume();
      return {};
    case 'resend-queued': {
      const c = need();
      const outbox = c.outbox(CORE_GROUP_ID);
      if (outbox.length < 19 || outbox[0] !== 0x81 || outbox[1] !== 0x85 || outbox[2] !== 0x50) {
        throw new Error(`E_SPIKE_SHAPE: outbox answered ${toHex(outbox)}`);
      }
      const msgId = outbox.slice(3, 19);
      c.send_requeue(msgId);
      return { encryptHead: toHex(c.send_encrypt(msgId).subarray(0, 18)) };
    }
    case 'errors': {
      const c = need();
      const keyPackagesBeforeIdentity = thrown(() => c.key_packages(1, false));
      const sessionBeforeIdentity = thrown(() => c.session_sign(CORE_NONCE, 0));
      const shortInstance = thrown(() => c.signup_begin(new Uint8Array(15)));
      c.signup_begin(CORE_INSTANCE_ID);
      const phaseAfterBegin = c.identity()[1];
      const beginTwice = thrown(() => c.signup_begin(CORE_INSTANCE_ID));
      const shortNonce = thrown(() => c.session_sign(new Uint8Array(31), 0));
      const purposeOutOfRange = thrown(() => c.session_sign(CORE_NONCE, 256));
      const shortGroup = thrown(() => c.group_registered(new Uint8Array(15), 1n));
      c.signup_reset();
      return {
        keyPackagesBeforeIdentity, sessionBeforeIdentity, shortInstance, phaseAfterBegin,
        beginTwice, shortNonce, purposeOutOfRange, shortGroup, phaseAfterReset: c.identity()[1],
      };
    }
    default:
      throw new Error(`E_SPIKE_OP: unknown core op ${op}`);
  }
}

// One listener for the worker's whole life. Removing it after `start` — which is what this used to
// do — is what left the append click with nowhere to land until the leader callback installed a
// second one (ruling J).
scope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type: string; instance?: string; badKek?: boolean; id?: number; op?: string };
  if (data.type === 'core') {
    const { id, op, instance } = event.data as { id: number; op: string; instance: string };
    coreQueue = coreQueue.then(async () => {
      try {
        scope.postMessage({ type: 'core-result', id, ok: true, value: await runCore(op, instance) });
      } catch (err) {
        scope.postMessage({ type: 'core-result', id, ok: false, error: errorMessage(err) });
      }
    });
    return;
  }
  if (data.type === 'start') {
    if (bootstrapped || data.instance === undefined) return;
    bootstrapped = true;
    instanceName = data.instance;
    void run(data.instance, data.badKek === true).catch((err: unknown) => {
      post({ type: 'error', message: String(err) });
    });
    return;
  }
  if (data.type === 'append' || data.type === 'resign') {
    pending.push({ type: data.type });
    drain();
  }
  if (data.type === 'mls' && typeof data.id === 'number' && typeof data.op === 'string') {
    pending.push({ type: 'mls', id: data.id, op: data.op as MlsOp });
    drain();
  }
});
