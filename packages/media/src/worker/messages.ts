import type { DillaBlockOptions, DillaTransformOptions, ToWorker } from '../protocol';

// The worker speaks dilla-media/1 only (interfaces.md c.6). livekit-client posts nothing to a custom manager's
// worker (DEV-12); should one of its E2EE worker messages (init with keyProviderOptions, setKey, ratchetRequest,
// enable, encode, decode, updateCodec, its own { kind: 'setSifTrailer', data } …) ever reach this worker, it does
// not match a dilla-media/1 shape and is ignored: no key, no enable/disable and no trailer comes in that way.

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isSlot = (v: unknown): boolean => v === 0 || v === 1 || v === 2 || v === 3;
const isCodec = (v: unknown): boolean => v === 'opus' || v === 'vp8' || v === 'vp9' || v === 'h264';
const isEncryption = (v: unknown): boolean => v === 0 || v === 1 || v === 2;
const isStream = (v: unknown, method: 'getReader' | 'getWriter'): boolean => isObj(v) && typeof v[method] === 'function';
const stripKeys = (o: Obj, ...keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

export function isTransformOptions(o: unknown): o is DillaTransformOptions {
  return isObj(o) && o.dilla === 1 && (o.side === 'encode' || o.side === 'decode') && o.block === undefined
    && isStr(o.trackId) && isStr(o.participantIdentity) && isSlot(o.slot) && isCodec(o.codec)
    && (o.encryption === undefined || isEncryption(o.encryption));
}

export function isBlockOptions(o: unknown): o is DillaBlockOptions {
  return isObj(o) && o.dilla === 1 && (o.side === 'encode' || o.side === 'decode') && isStr(o.trackId) && o.block === true;
}

const isOptions = (o: unknown): boolean => isTransformOptions(o) || isBlockOptions(o);

/** Returns `m` when it is a well-formed dilla-media/1 message, else null (the worker ignores it). */
export function parseToWorker(m: unknown): ToWorker | null {
  if (!isObj(m)) return null;
  switch (m.kind) {
    case 'init':
      return m.v === 1 && LOG_LEVELS.has(m.logLevel as string) && isStr(m.wasmUrl) ? (m as ToWorker) : null;
    case 'installEpoch':
      return isStr(m.groupId) && typeof m.epoch === 'bigint' && m.baseKey instanceof Uint8Array && isInt(m.selfLeaf)
        && Array.isArray(m.roster) && m.roster.every((r) => isObj(r) && isInt(r.leaf) && isStr(r.deviceId))
        ? (m as ToWorker) : null;
    case 'clearKeys':
      return m as ToWorker;
    case 'setSifTrailer':
      return m.trailer instanceof Uint8Array ? (m as ToWorker) : null;
    case 'attach':
      return isObj(m.data) && isOptions(stripKeys(m.data, 'readable', 'writable')) && isStream(m.data.readable, 'getReader') && isStream(m.data.writable, 'getWriter')
        ? (m as ToWorker) : null;
    case 'retarget':
      return isObj(m.data) && isStr(m.data.previousTrackId) && isOptions(stripKeys(m.data, 'previousTrackId')) ? (m as ToWorker) : null;
    case 'mapTrack':
      return isStr(m.trackId) && isStr(m.participantIdentity) && isSlot(m.slot) && isCodec(m.codec) && isEncryption(m.encryption)
        ? (m as ToWorker) : null;
    case 'detach':
      return isStr(m.trackId) ? (m as ToWorker) : null;
    case 'stats':
      return isInt(m.id) ? (m as ToWorker) : null;
    default:
      return null;
  }
}
