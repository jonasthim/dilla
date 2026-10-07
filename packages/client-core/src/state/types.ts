// The state slices the worker publishes and the page renders (L-TS-08). Every id is 32 lower-case hex
// characters; every slice value is immutable and replaced whole.
export type BootPhase = 'loading' | 'unsupported' | 'other-tab' | 'store-lost' | 'needs-signup' | 'signup-keys' | 'registering' | 'ready' | 'revoked' | 'error'
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
}
/** The one error shape that crosses the worker boundary (ret errors and AccountState.error). For a
 *  DillaHttpError, code and detail are the server's error-array elements 0 and 1 passed through
 *  verbatim, status its HTTP status (0 for a network failure) and retryAfterMs its wait; for every
 *  other error status is 0 and retryAfterMs null. The page switches on code and status, never on detail. */
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
  thumb: boolean; kind: 'image' | 'file'; tooLarge: boolean; }
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
export interface BadgeState { unread: number; mentions: number; }
export interface Notice { id: number; channelId: string; communityId: string | null; kind: 'message' | 'mention' | 'dm'; senderUser: string | null; senderName: string; body: string; ts: number; }
export interface NoticesState { nextId: number; items: Notice[]; }      // items ≤ 32, oldest first; ids increase for the worker's life
export type SliceName = 'account' | 'connection' | 'communities' | `channels:${string}` | `members:${string}` | `timeline:${string}`
  | 'dms' | 'devices' | 'badges' | 'notices' | 'settings' | `pins:${string}` | `tray:${string}`;
export interface SliceTypes { account: AccountState; connection: ConnectionState; communities: CommunitySummary[];
  [k: `channels:${string}`]: ChannelSummary[]; [k: `members:${string}`]: MemberSummary[]; [k: `timeline:${string}`]: TimelineState;
  [k: `pins:${string}`]: PinnedItem[]; [k: `tray:${string}`]: TrayItem[];
  dms: DmSummary[]; devices: DeviceSummary[]; badges: Record<string, BadgeState>; notices: NoticesState; settings: Record<string, string>; }
export const TIMELINE_PAGE = 100;
