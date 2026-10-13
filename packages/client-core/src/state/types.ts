// The state slices the worker publishes and the page renders (L-TS-08). Every id is 32 lower-case hex
// characters; every slice value is immutable and replaced whole.
import type { TrustBlock } from '../core-port';
export type { TrustBlock };
export type BootPhase = 'loading' | 'unsupported' | 'other-tab' | 'paused-error' | 'store-lost' | 'needs-signup' | 'signup-keys' | 'registering' | 'ready' | 'revoked' | 'error'
  | 'signin-login' | 'signin-totp' | 'signin-key' | 'enrolling' | 'cleared';
export interface AccountState {
  phase: BootPhase;
  instance: { id: string; name: string; registrationMode: 0 | 1 | 2; passwordSignup: boolean } | null;
  user: { id: string; username: string } | null;
  deviceId: string | null;
  recoveryKey: string[] | null;                 // 13 groups of 4; only while phase is 'signup-keys' or 'registering'
  error: WorkerError | null;                    // the last signup, sign-in or boot error
  signIn: { username: string | null; needsTotp: boolean } | null;   // set during signin-*; null otherwise
  /** BACKUPS-RECOVERY-04: the instance holds a root object this account did not seal (E_ROOT_MISMATCH at ready), so
   *  the recovery key cannot open it until the operator resets it; cleared by a later matching check and by a wipe. */
  rootMismatch: boolean;
  /** The core's trust state for this account's own key, which Privacy does not list as a contact: 'changed' while a
   *  signed list under another key is pending for this user, 'unlisted' while the core refuses an own leaf against the
   *  own signed list (a device this person did not add). null otherwise; re-derived at each trust publish. */
  ownTrust: 'changed' | 'unlisted' | null;
}
/** Page-bound errors have a stable code and no detail. */
export interface WorkerError { code: string; detail: string; status: number; retryAfterMs: number | null; }
export interface ConnectionState { status: 'offline' | 'connecting' | 'online'; generation: string | null;
  reason?: 'version'; }                        // only while idle because the server refused this client's version (gateway close 4006)
export interface CommunitySummary { id: string; name: string; }
export type ChannelGroupState = 'none' | 'joining' | 'active' | 'resync' | 'not-member' | 'unsupported';
export interface ChannelSummary { id: string; communityId: string; kind: 0 | 1 | 2; mode: 0 | 1; name: string; topic: string; parentId: string | null; position: number; group: ChannelGroupState; }
export interface MemberSummary { userId: string; username: string; display: string; kind: 0 | 1; roleIds: string[]; }   // roleIds: hex of member-row element 3, in order
export type TimelineItemState = 'ok' | 'pending' | 'failed' | 'cannot-read' | 'deleted';
export interface ReplyRef { msgId: string; state: 'ok' | 'missing' | 'deleted'; senderUser: string | null; excerpt: string; seq: string | null; }
export interface ReactionSummary { emoji: string; count: number; mine: boolean; }
export interface AttachmentSummary { index: number; size: number; mime: string; name: string; w: number | null; h: number | null;
  thumb: boolean; kind: 'image' | 'audio' | 'video' | 'file'; tooLarge: boolean; }   // kind: attachmentKind (L-TS-58)
export interface PendingAction { msgId: string; type: 1 | 2 | 3 | 4 | 5 | 6; state: 'pending' | 'failed'; reason: string; }   // msgId: the fold row's OWN outbox msg id (retrySend/discardSend take it); the target is the item it hangs on
export interface TimelineItem {
  key: string;                                  // 'o<msg id hex>' for an outbox row and for a stored row of this device whose msgId is
                                                // known (so a sent message keeps its key when it is confirmed and is not re-announced);
                                                // 's<seq>' for every other stored row
  state: TimelineItemState;
  reason: string;                               // the raw code for 'cannot-read' and 'failed', else ''
  senderUser: string | null; senderDevice: string | null;
  own: boolean; web: boolean; bot: boolean;
  ts: number;                                   // unix seconds
  body: string;
  msgId: string | null;
  seq: string | null;                           // the stored seq as decimal; null for an outbox item
  edited: boolean;                              // the core folded an edit onto it (edited_seq > 0)
  reply: ReplyRef | null;                       // the message it answers, as the core resolved it (an outbox item: from the stored rows)
  reactions: ReactionSummary[];                 // the core's per-user counts, in the core's order
  pinned: boolean;
  attachments: AttachmentSummary[];             // what the envelope names; never a key, a nonce or a blob id
  mention: boolean;                             // the core's flag, set once at apply (L-CORE-35)
  actions: PendingAction[];                     // pending or failed folds of the own outbox aimed at this message
}
export interface PinnedItem { msgId: string; seq: string; senderUser: string | null; excerpt: string; pinnedBy: string; pinnedSeq: string; ts: number; }   // ts: the target's recv_ts, unix seconds
export interface TrayItem { id: string; name: string; size: number; mime: string; image: boolean;
  phase: 'reading' | 'preparing' | 'uploading' | 'ready' | 'failed'; reason: string; }
export interface TimelineState { channelId: string; group: ChannelGroupState; items: TimelineItem[]; hasEarlier: boolean; }
export interface DmSummary { id: string; kind: 3 | 4; members: string[]; name: string; group: ChannelGroupState; }
export interface DeviceSummary { id: string; tier: 0 | 1; signerTier: 0 | 1; lastSeen: number; revokedAt: number | null; listed: boolean; own: boolean; }
/**
 * L-TS-40's trust row. Ruling (c) of 2026-10-13 adds two worker-derived Privacy states, present only while they hold:
 * `unlisted` (one of the contact's leaves failed its signed list, or Flow 05's "history pending": the list read has not
 * completed, which shares the unlisted copy and its no-Verify rule) and `removedIn` (channels whose validated Remove of the
 * changed leaf cleared that group's send block while the key stays changed and unverified).
 */
export interface TrustSummary { userId: string; name: string; shared: boolean; umk: string; firstSeen: number; verified: boolean; changedUmk: string | null;
  unlisted?: true; removedIn?: string[]; blocked?: TrustBlock }
/**
 * Fix wave C1 (ABI 8): `blocked` is the core's stored verdict of the contact's leaves still in an active group, present only
 * while one holds. `verified` is true only while nothing is blocked. 'E_UMK_CHANGED' reads as a changed key (also when
 * `changedUmk` is null: a leaf under another key that no validated list presents); any other code reads as unlisted.
 *
 * `sendBlocks`: channel id (hex) → the code the core refuses a send with in that channel's group (send_block_code), only for
 * blocked channels, and `own` when only own-user leaves hold it (send_block_own). The composer pauses on it and says why
 * (W-01, R1): the own account's copy for an own block, else the changed-key copy for a changed contact of the conversation
 * (with or without a key to compare), else privacy.leafFailed.
 */
export interface SendBlock { code: TrustBlock; own: boolean }
export type SendBlocksState = Record<string, SendBlock>;
export interface SearchState { requestId: number; hits: { channelId: string; communityId: string | null; seq: string; snippet: string; rank: string }[];
  cursor: { token: string } | null }
export interface DiagnosticsState { connection: 'online' | 'offline' | 'connecting'; generation: string | null; instance: string;
  devices: number; errors: { code: string; at: number }[] }
export interface TypingState { userId: string; name: string; expiresAt: number }
export interface BadgeState { unread: number; mentions: number; }
export interface Notice { id: number; channelId: string; communityId: string | null; kind: 'message' | 'mention' | 'dm'; senderUser: string | null; senderName: string; body: string; ts: number; }
export interface NoticesState { nextId: number; items: Notice[]; }      // items ≤ 32, oldest first; ids increase for the worker's life
// ---- web-3: calls, voice presence and rings (L-TS-51). A call's media key is never in a slice or a command result: it
// reaches the page only as a `callKeys` push (L-TS-52).
export type IceServerTuple = [urls: string[], username: string, credential: string];
export interface CallKeys { groupId: string; epoch: string; baseKey: ArrayBuffer; selfLeaf: number;
  roster: { leaf: number; deviceId: string; userId: string }[] }
// No key bytes in a command result: the join epoch's CallKeys arrive as a `callKeys` push posted
// immediately before this result's `ret` (same port, FIFO), carrying `epoch` below.
export interface CallJoinResult { callId: string; groupId: string; livekitUrl: string; token: string;
  iceServers: IceServerTuple[]; caps: [number, number, number]; epoch: string }
export type CallStatsReport = [candidateType: number, relayProtocol: number | null, rttMs: number,
  fractionLostPermille: number, decryptFailures: number, framesEncrypted: number];
// 'paused' (RV-3, Jonas): a mid-call identity change (E_UMK_CHANGED); still in the group and the room, no keys sent or installed.
export type CallPhase = 'idle' | 'joining' | 'in' | 'paused' | 'leaving' | 'blocked' | 'removed' | 'failed';
export interface CallState { phase: CallPhase; channelId: string | null; callId: string | null; epoch: string | null;
  code: string | null; error: WorkerError | null; roster: { userId: string; deviceId: string; leaf: number }[];
  outgoing: { ringing: string[]; declined: string[] } | null;    // user names; DM calls this device opened
  // Ruling I2 (2026-10-13): the 32-hex user id of the changed contact while the phase is paused (RV-3) or after an
  // E_UMK_CHANGED join refusal (the first by user_id when several changed); null otherwise. Fills {name} in
  // voice.paused and voice.blockedChanged, also when a refused join left `roster` empty.
  changedUser: string | null }
export interface VoiceParticipant { userId: string; deviceId: string; name: string; flags: number; own: boolean; web: boolean; bot: boolean }
export interface VoiceCall { callId: string; participants: VoiceParticipant[] }
export type VoiceState = Record<string, VoiceCall>;   // channel id (hex) → its live call
export interface Ring { callId: string; channelId: string; callerUser: string; callerName: string;
  ringTs: number;               // op 53's expires_ts as received (seconds); callDecline echoes it
  expiresAt: number;            // ms, min(expires_ts*1000, receivedAt + 30_000)
  busy: boolean;                // this device is in another call: no sound, no notification
  quiet: boolean }              // the DM is muted (mute.channel.<id>): no sound, no notification
export type RingsState = Ring[];
/** The initial values of the three web-3 slices (L-TS-51). */
export const CALL_IDLE: CallState = { phase: 'idle', channelId: null, callId: null, epoch: null, code: null, error: null, roster: [], outgoing: null,
  changedUser: null };
export const VOICE_EMPTY: VoiceState = {};
export const RINGS_EMPTY: RingsState = [];
export type SliceName = 'account' | 'connection' | 'communities' | `channels:${string}` | `members:${string}` | `timeline:${string}`
  | 'dms' | 'devices' | 'badges' | 'notices' | 'settings' | 'trust' | 'sendBlocks' | 'search' | 'diagnostics'
  | `typing:${string}` | `pins:${string}` | `tray:${string}` | 'call' | 'voice' | 'rings';
export interface SliceTypes { account: AccountState; connection: ConnectionState; communities: CommunitySummary[];
  [k: `channels:${string}`]: ChannelSummary[]; [k: `members:${string}`]: MemberSummary[]; [k: `timeline:${string}`]: TimelineState;
  [k: `pins:${string}`]: PinnedItem[]; [k: `tray:${string}`]: TrayItem[];
  [k: `typing:${string}`]: TypingState[];
  dms: DmSummary[]; devices: DeviceSummary[]; badges: Record<string, BadgeState>; notices: NoticesState; settings: Record<string, string>;
  trust: TrustSummary[]; sendBlocks: SendBlocksState; search: SearchState; diagnostics: DiagnosticsState;
  call: CallState; voice: VoiceState; rings: RingsState }
export const TIMELINE_PAGE = 100;
