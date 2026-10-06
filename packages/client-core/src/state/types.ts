// The state slices the worker publishes and the page renders (L-TS-08). Every id is 32 lower-case hex
// characters; every slice value is immutable and replaced whole.
export type BootPhase = 'loading' | 'unsupported' | 'other-tab' | 'store-lost' | 'needs-signup' | 'signup-keys' | 'registering' | 'ready' | 'revoked' | 'error';
export interface AccountState {
  phase: BootPhase;
  instance: { id: string; name: string; registrationMode: 0 | 1 | 2; passwordSignup: boolean } | null;
  user: { id: string; username: string } | null;
  deviceId: string | null;
  recoveryKey: string[] | null;                 // 13 groups of 4; only while phase is 'signup-keys' or 'registering'
  error: WorkerError | null;                    // the last signup or boot error
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
export interface MemberSummary { userId: string; username: string; display: string; kind: 0 | 1; }
export type TimelineItemState = 'ok' | 'pending' | 'failed' | 'cannot-read' | 'deleted';
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
}
export interface TimelineState { channelId: string; group: ChannelGroupState; items: TimelineItem[]; hasEarlier: boolean; }
export type SliceName = 'account' | 'connection' | 'communities' | `channels:${string}` | `members:${string}` | `timeline:${string}`;
export interface SliceTypes { account: AccountState; connection: ConnectionState; communities: CommunitySummary[];
  [k: `channels:${string}`]: ChannelSummary[]; [k: `members:${string}`]: MemberSummary[]; [k: `timeline:${string}`]: TimelineState; }
export const TIMELINE_PAGE = 100;
