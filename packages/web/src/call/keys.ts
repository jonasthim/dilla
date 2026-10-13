// The page’s half of the call key path (decision 3, L-TS-52, L-WEB-50). Each epoch’s base_key reaches the page once,
// as a callKeys push whose buffer the bridge zero-fills as soon as the listener returns; this relay copies it
// synchronously and hands the copy to the media worker’s installEpoch, which transfers it on. Every copy is
// zero-filled on every path: installed (once the install settles, whether it succeeded or not), for another call,
// stale, replaced while held, and on close. No key byte is ever logged, kept in state or put in an error.
// Only types come from @dilla/media here, so this module carries no livekit code.
import type { CallKeys } from '@dilla/client-core';
import type { EpochKeys } from '@dilla/media';

export interface RosterRow { leaf: number; deviceId: string; userId: string }

/** A synchronous copy of one pushed key; `baseKey` is the page’s own 16 bytes, zero-filled after use. */
export interface KeyCopy {
  callId: string;
  groupId: string;
  epoch: bigint;
  baseKey: Uint8Array;
  selfLeaf: number;
  roster: RosterRow[];
}

export interface KeyInstaller { installEpoch(k: EpochKeys): Promise<void> }

export interface KeyRelay {
  /** The onCallKeys listener. It must be subscribed before callJoin is sent, so the join key finds it. */
  readonly listener: (callId: string, keys: CallKeys) => void;
  /** The join epoch’s copy for this call, or null; every other copy held so far is zero-filled. From here on only
   *  keys for `callId` above `epoch` are accepted, and each is installed with minEpoch = `epoch`. */
  takeJoin(callId: string, epoch: bigint): KeyCopy | null;
  /** The media worker is up: a key held since the join answer is installed now, later ones as they arrive. */
  attach(installer: KeyInstaller): void;
  /** RV-3: while paused nothing is installed; only the newest key is held (the worker posts the key of the epoch
   *  that ends a pause just before the phase slice that ends it), and resuming installs it. */
  setPaused(on: boolean): void;
  /** Zero-fills every held copy; nothing is installed afterwards. */
  close(): void;
}

export interface KeyRelayOptions {
  /** The device → { userId, leaf } roster of the join epoch and of each epoch handed to the installer. */
  onRoster?: (roster: ReadonlyMap<string, { userId: string; leaf: number }>, selfLeaf: number) => void;
  /** An install that failed: its error code only (an E_ code), never the key. */
  onInstallError?: (code: string) => void;
  /** Test seam: how the pushed buffer is copied. */
  copy?: (buffer: ArrayBuffer) => Uint8Array;
}

/** Copies kept before the join answer names the call: the join key plus any racing epoch change. */
const MAX_BUFFERED = 4;

const wipe = (copy: KeyCopy | null): void => { copy?.baseKey.fill(0); };

/** The media manager’s EpochKeys for a copy. `baseKey` is the copy itself, which installEpoch zero-fills too. */
export function toEpochKeys(copy: KeyCopy, minEpoch: bigint): EpochKeys {
  return {
    groupId: copy.groupId,
    epoch: copy.epoch,
    minEpoch,
    baseKey: copy.baseKey,
    selfLeaf: copy.selfLeaf,
    roster: copy.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId })),
  };
}

function codeOf(err: unknown): string {
  const m = err instanceof Error ? /^E_[A-Z0-9_]+/.exec(err.message) : null;
  return m?.[0] ?? 'E_NO_EPOCH';
}

export function createKeyRelay(opts: KeyRelayOptions = {}): KeyRelay {
  const copyOf = opts.copy ?? ((b: ArrayBuffer) => new Uint8Array(b.slice(0)));
  let phase: 'buffering' | 'live' | 'closed' = 'buffering';
  let buffered: KeyCopy[] = [];
  let callId: string | null = null;
  let minEpoch = 0n;
  /** The newest epoch handed over (the join’s, then each installed or held one): an older or equal one is stale. */
  let newest = 0n;
  let installer: KeyInstaller | null = null;
  let paused = false;
  /** A key waiting for attach or for the end of a pause. */
  let held: KeyCopy | null = null;

  const report = (copy: KeyCopy): void => {
    if (!opts.onRoster) return;
    const map = new Map<string, { userId: string; leaf: number }>();
    for (const r of copy.roster) map.set(r.deviceId, { userId: r.userId, leaf: r.leaf });
    opts.onRoster(map, copy.selfLeaf);
  };

  const install = (copy: KeyCopy): void => {
    const target = installer;
    if (target === null || phase !== 'live') { wipe(copy); return; }
    report(copy);
    let pending: Promise<void>;
    try {
      pending = target.installEpoch(toEpochKeys(copy, minEpoch));
    } catch (err) {
      wipe(copy);
      opts.onInstallError?.(codeOf(err));
      return;
    }
    pending.then(
      () => wipe(copy),
      (err: unknown) => { wipe(copy); opts.onInstallError?.(codeOf(err)); },
    );
  };

  const offer = (copy: KeyCopy): void => {
    if (installer === null || paused) {
      wipe(held);
      held = copy;
      return;
    }
    install(copy);
  };

  const listener = (pushedCallId: string, keys: CallKeys): void => {
    const source = new Uint8Array(keys.baseKey);
    let epoch: bigint;
    try {
      epoch = BigInt(keys.epoch);
    } catch {
      source.fill(0);
      return;
    }
    // Refused before any copy is made: closed, another call, or an epoch already handed over.
    if (phase === 'closed' || (phase === 'live' && (pushedCallId !== callId || epoch <= newest))) {
      source.fill(0);
      return;
    }
    const copy: KeyCopy = {
      callId: pushedCallId,
      groupId: keys.groupId,
      epoch,
      baseKey: copyOf(keys.baseKey),
      selfLeaf: keys.selfLeaf,
      roster: keys.roster.map((r) => ({ leaf: r.leaf, deviceId: r.deviceId, userId: r.userId })),
    };
    // The session is the only consumer of key bytes: the pushed buffer is zero-filled here too, not only by the bridge.
    source.fill(0);
    if (phase === 'buffering') {
      buffered.push(copy);
      while (buffered.length > MAX_BUFFERED) wipe(buffered.shift() ?? null);
      return;
    }
    newest = epoch;
    offer(copy);
  };

  return {
    listener,
    takeJoin(id, epoch) {
      if (phase !== 'buffering') return null;
      const all = buffered;
      buffered = [];
      const join = all.find((c) => c.callId === id && c.epoch === epoch) ?? null;
      for (const c of all) if (c !== join) wipe(c);
      if (join === null) {
        phase = 'closed';
        return null;
      }
      phase = 'live';
      callId = id;
      minEpoch = epoch;
      newest = epoch;
      report(join);
      return join;
    },
    attach(next) {
      if (phase !== 'live' || installer !== null) return;
      installer = next;
      if (held !== null && !paused) {
        const copy = held;
        held = null;
        install(copy);
      }
    },
    setPaused(on) {
      paused = on;
      if (on || held === null) return;
      const copy = held;
      held = null;
      if (installer === null) { held = copy; return; }
      install(copy);
    },
    close() {
      phase = 'closed';
      installer = null;
      for (const c of buffered) wipe(c);
      buffered = [];
      wipe(held);
      held = null;
    },
  };
}
