// The messages between the page and the core worker (L-TS-09).
import type { CallKeys, CallStatsReport, SliceName, WorkerError } from '../state/types';

export type Command =
  | { m: 'start' }
  | { m: 'signupBegin' }
  | { m: 'signupSubmit'; invite: string; username: string; display: string; password: string | null; recoveryKeyAcknowledged: true }
  | { m: 'signupReset' }
  | { m: 'resetDevice' }
  | { m: 'joinCommunity'; invite: string }
  // v0.1.0-web3.1, ready only. Names are checked as the instance checks them: 1..255 UTF-8 bytes for a server, 1..100 for a
  // channel, no control character, not blank. createChannel adds a top-level channel the server cannot read.
  | { m: 'createCommunity'; name: string }                                              // → { communityId }; listed before the ret
  | { m: 'createChannel'; communityId: string; kind: 'text' | 'voice'; name: string }   // → { channelId }; listed before the ret
  | { m: 'createInvite'; communityId: string; maxUses: number; ttlSeconds: number }     // → InviteCreatedResult
  | { m: 'selectCommunity'; communityId: string }
  // Ready only → null: GET /v1/communities again; the communities slice is published before the answer (the page looks for
  // a server whose create answer was lost, with the socket still up).
  | { m: 'refreshCommunities' }
  | { m: 'openChannel'; channelId: string }
  | { m: 'closeChannel'; channelId: string }
  | { m: 'loadEarlier'; channelId: string }
  | { m: 'send'; channelId: string; text: string; replyTo?: string | null; attachments?: readonly string[] }   // → { msgId }
  | { m: 'retrySend'; msgId: string }
  | { m: 'discardSend'; msgId: string }
  | { m: 'signInBegin' }                                         // needs-signup → signin-login
  // The key is entered first and travels with the command that registers (coordinator ruling on concern 3): the login
  // is sent only once the key is held, and its assertion is spent seconds later.
  | { m: 'signInLogin'; username: string; password: string; recoveryKey: string }   // signin-login → signin-totp | ready
  | { m: 'signInTotp'; code: string; recoveryKey: string }      // signin-totp → ready
  | { m: 'signInKey'; recoveryKey: string }                      // signin-key (a registered enrolment) → ready
  | { m: 'signInCancel' }                                        // signin-* → needs-signup
  | { m: 'refreshDevices' }                                      // ready: GET /v1/devices + own list → slice devices
  | { m: 'revokeDevice'; deviceId: string; recoveryKey: string | null } // ready: another device; the key is required for a listed device, ignored (null) for an unlisted live row
  | { m: 'signOutRevoke'; recoveryKey: string }                  // ready: this device → store wiped → cleared
  | { m: 'forgetBrowser' }                                       // ready (and revoked, pre-flight ruling d): sessions deleted, store wiped → cleared
  | { m: 'markRead'; channelId: string }                         // ready
  | { m: 'setSetting'; key: string; value: string | null }       // ready; null deletes; key must match L-TS-25, value its allowed set
  | { m: 'openDm'; userId: string }                              // ready → { channelId }
  | { m: 'editMessage'; channelId: string; msgId: string; text: string }                  // ready → null (type 1)
  | { m: 'deleteMessage'; channelId: string; msgId: string }                              // ready → null (type 2)
  | { m: 'react'; channelId: string; msgId: string; emoji: string; on: boolean }          // ready → null (type 3, or 4 when off)
  | { m: 'pin'; channelId: string; msgId: string; on: boolean }                           // ready → null (type 5, or 6 when off)
  | { m: 'loadPins'; channelId: string }                                                  // ready → null; slice pins:<channel>
  | { m: 'closePins'; channelId: string }                                                 // ready → null
  | { m: 'attachFiles'; channelId: string; files: readonly File[] }                       // ready → { trayIds }; slice tray:<channel>
  | { m: 'discardAttachment'; channelId: string; trayId: string }                         // ready → null
  | { m: 'openAttachment'; channelId: string; seq: string; index: number; thumb: boolean } // ready → { blob, name, mime }
  | { m: 'refreshTrust' } // ready: bounded signed-list refresh
  | { m: 'verifyContact'; userId: string; umk: string }
  // ready → string: the digits for exactly `umk` (64 lowercase hex), the key the dialog will hand to verifyContact
  // (changedUmk ?? umk); E_DEVICE_LIST_STALE when it is no longer the core's comparison key. Without `umk` (until the page
  // sends it) the worker binds the core's current comparison key.
  | { m: 'safetyNumber'; userId: string; umk: string }
  | { m: 'search'; scope: 'channel' | 'community' | 'all'; id: string | null; query: string;
    cursor: { token: string } | null }
  | { m: 'typing'; channelId: string; on: boolean }
  | { m: 'voiceSelf'; callId: string; flags: number }
  // web-3 (L-TS-50). The page never sends callJoin directly: startPageCall (L-WEB-50) sends it after subscribing to
  // onCallKeys. "Answer" is callJoin with the DM's channel id. vdec: '' or up to three of vp8, h264, vp9, no repeats.
  | { m: 'callJoin'; channelId: string; vdec: string }                                   // → CallJoinResult (no key bytes)
  // 'lost' (WB client I3): the page's room ended on its own (its connection gave up, or the room closed); the worker
  // leaves as for 'user' and ends in phase removed with E_DISCONNECTED rather than a silent idle.
  | { m: 'callLeave'; reason: 'user' | 'pagehide' | 'switch' | 'lost' }                  // → null
  | { m: 'callShare'; on: boolean }                                                      // → null
  | { m: 'callRefresh' }                                                                 // → { token, iceServers }
  | { m: 'callStats'; report: CallStatsReport }                                          // → null
  | { m: 'loadVoice'; communityId: string | null; channelId: string | null }            // exactly one id → null
  | { m: 'callDecline'; callId: string; ringTs: number }                                 // ringTs: op 53's expires_ts → null
  | { m: 'resign'; nonce: string };
export type ToWorker = { t: 'call'; id: number; command: Command };
export type FromWorker =
  | { t: 'ret'; id: number; ok: true; value: unknown }
  | { t: 'ret'; id: number; ok: false; error: WorkerError }
  | { t: 'slice'; name: SliceName; rev: number; value: unknown }
  | { t: 'released'; instance: string; nonce: string }
  // L-TS-52: posted with [keys.baseKey] transferred, only to the page that owns the call; never a ret, never a slice.
  | { t: 'callKeys'; callId: string; keys: CallKeys };
/** Not part of ToWorker. Honoured only by a worker started with { testHooks: true }, which only
 *  packages/client-core/harness/worker.ts does; src/worker/entry.ts (what createCoreWorker() loads) passes false. */
export type TestHook = { t: 'test'; op: 'gateway-stop' | 'gateway-start' | 'pause-fail-once' };
export const LOCK_PREFIX = 'dilla-core:';        // + instance id hex
const HEX_ID = /^[0-9a-f]{32}$/;

function exactNotice(v: unknown, kind: 'released' | 'takeover', instance: string, nonce: string): boolean {
  if (!isRecord(v) || !HEX_ID.test(instance) || !HEX_ID.test(nonce)) return false;
  const keys = Object.keys(v);
  return keys.length === 3 && keys.includes('t') && keys.includes('instance') && keys.includes('nonce')
    && v.t === kind && v.instance === instance && v.nonce === nonce;
}
export const isReleaseNotice = (v: unknown, instance: string, nonce: string): boolean => exactNotice(v, 'released', instance, nonce);
export const isTakeoverNotice = (v: unknown, instance: string, nonce: string): boolean => exactNotice(v, 'takeover', instance, nonce);

function isRecord(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null;
}

/** A call envelope: t 'call', a non-negative safe integer id and a command object with a string m. The
 *  command's own fields are checked by the controller. */
export function isToWorker(data: unknown): data is ToWorker {
  if (!isRecord(data) || data.t !== 'call') return false;
  const { id, command } = data;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 && isRecord(command) && typeof command.m === 'string';
}

export function isTestHook(data: unknown): data is TestHook {
  return isRecord(data) && data.t === 'test' && (data.op === 'gateway-stop' || data.op === 'gateway-start' || data.op === 'pause-fail-once');
}
