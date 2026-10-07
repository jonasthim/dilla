// The conversation tests of web-2b (task 9): a shell open on #general of Midgard (or the DM with bob), its members
// with roles, row builders over task 7's timelineItem(), and recorders for the page's blob: URLs.
import { act, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentSummary, ChannelSummary, MemberSummary, ReplyRef, TimelineItem, TimelineState } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { Shell } from '../screens/Shell.tsx';
import { FakeClient } from './fake-client.ts';
import { account, ME, timelineItem } from './fixtures.ts';

export const A = 'a1'.repeat(16);
export const GEN = 'c3'.repeat(16);
export const DM = '9a'.repeat(16);
export const PEER = '28'.repeat(16);
export const PEER_DEV = '29'.repeat(16);
export const MOD = '5c'.repeat(16);
export const ROLE = '7e'.repeat(16);
export const OTHER_ROLE = '7f'.repeat(16);
export const STRANGER = 'ee'.repeat(16);
export const P1 = '0b'.repeat(16);
export const P2 = '0c'.repeat(16);
export const O1 = '0a'.repeat(16);
export const O2 = '0d'.repeat(16);
export const NOW = Math.floor(Date.now() / 1000);

export const CHANNEL: ChannelSummary = { id: GEN, communityId: A, kind: 0, mode: 0, name: 'general', topic: '', parentId: null, position: 0, group: 'active' };
// roleIds on MemberSummary (L-TS-36, published by task 7; ruled: web-e2e 6).
export const MEMBERS: MemberSummary[] = [
  { userId: ME.id, username: 'ada', display: 'Ada L', kind: 0, roleIds: [ROLE] },
  { userId: PEER, username: 'bob', display: '', kind: 0, roleIds: [] },
  { userId: MOD, username: 'mo', display: 'Mo', kind: 0, roleIds: [OTHER_ROLE] },
];

export function peerRow(msgId: string, seq: string, body: string, over: Partial<TimelineItem> = {}): TimelineItem {
  return timelineItem({ key: `s${seq}`, msgId, seq, body, senderUser: PEER, senderDevice: PEER_DEV, ts: NOW, ...over });
}
export function ownRow(msgId: string, seq: string | null, body: string, over: Partial<TimelineItem> = {}): TimelineItem {
  return timelineItem({ key: `o${msgId}`, msgId, seq, body, senderUser: ME.id, senderDevice: 'cc'.repeat(16), own: true, web: true, ts: NOW, ...over });
}
export function reply(over: Partial<ReplyRef> = {}): ReplyRef {
  return { msgId: P1, state: 'ok', senderUser: PEER, excerpt: 'the original', seq: '1', ...over };
}
export function image(over: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return { index: 0, size: 1234, mime: 'image/png', name: 'map.png', w: 640, h: 480, thumb: true, kind: 'image', tooLarge: false, ...over };
}
export function file(over: Partial<AttachmentSummary> = {}): AttachmentSummary {
  return { index: 0, size: 70_000, mime: 'application/octet-stream', name: 'data.bin', w: null, h: null, thumb: false, kind: 'file', tooLarge: false, ...over };
}
export function timeline(items: TimelineItem[], channelId = GEN): TimelineState {
  return { channelId, group: 'active', items, hasEarlier: false };
}

export interface Opened { fake: FakeClient; user: ReturnType<typeof userEvent.setup>; view: ReturnType<typeof render>; }

/** The shell on /c/<A>/<GEN> (or /dm/<DM>) holding `items`; `handler` answers calls from the first render on. */
export function renderConversation(opts: { items?: TimelineItem[]; handler?: FakeClient['handler']; before?(fake: FakeClient): void; dm?: boolean } = {}): Opened {
  const target = opts.dm === true ? DM : GEN;
  window.history.replaceState(null, '', opts.dm === true ? `/dm/${DM}` : `/c/${A}/${GEN}`);
  const fake = new FakeClient();
  if (opts.handler !== undefined) fake.handler = opts.handler;
  fake.set('account', account());
  fake.set('connection', { status: 'online', generation: '7' });
  fake.set('communities', [{ id: A, name: 'Midgard' }]);
  fake.set(`channels:${A}`, [CHANNEL]);
  fake.set(`members:${A}`, MEMBERS);
  fake.set('dms', [{ id: DM, kind: 3, members: [ME.id, PEER], name: 'bob', group: 'active' }]);
  opts.before?.(fake);
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Shell /></CoreProvider></div>);
  act(() => fake.set(`timeline:${target}`, timeline(opts.items ?? [], target)));
  return { fake, user, view };
}

/** A message row by its msg id (DOM contract `data-msg-id`). */
export function rowOf(msgId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`.d-message-row[data-msg-id="${msgId}"]`);
  if (row === null) throw new Error(`no row carries data-msg-id=${msgId}`);
  return row;
}

/** jsdom has neither URL.createObjectURL nor revokeObjectURL: recorders that mint blob:test/1, blob:test/2, … */
export function stubBlobUrls(): { created: string[]; revoked: string[]; restore(): void } {
  const created: string[] = [];
  const revoked: string[] = [];
  const saved = { create: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'), revoke: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL') };
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => { const u = `blob:test/${created.length + 1}`; created.push(u); return u; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: (u: string) => { revoked.push(u); } });
  return {
    created, revoked,
    restore() {
      for (const [name, d] of [['createObjectURL', saved.create], ['revokeObjectURL', saved.revoke]] as const) {
        if (d === undefined) delete (URL as unknown as Record<string, unknown>)[name];
        else Object.defineProperty(URL, name, d);
      }
    },
  };
}
