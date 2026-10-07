import type { AccountState, TimelineItem } from '@dilla/client-core';

export const INSTANCE: NonNullable<AccountState['instance']> = {
  id: 'aa'.repeat(16), name: 'dilla.test', registrationMode: 0, passwordSignup: false,
};
export const ME = { id: 'bb'.repeat(16), username: 'ada' };

export function account(over: Partial<AccountState> = {}): AccountState {
  return { phase: 'ready', instance: INSTANCE, user: ME, deviceId: 'cc'.repeat(16), recoveryKey: null, error: null, signIn: null, rootMismatch: false, ...over };
}

/** A readable message from nobody in particular, nothing folded onto it (L-TS-36); tests override what they need. */
export function timelineItem(over: Partial<TimelineItem> = {}): TimelineItem {
  return { key: 's1', state: 'ok', reason: '', senderUser: null, senderDevice: 'dd'.repeat(16), own: false, web: false, bot: false, ts: 0,
    body: '', msgId: null, seq: null, edited: false, reply: null, reactions: [], pinned: false, attachments: [], mention: false, actions: [], ...over };
}
