import { describe, it, expect, vi } from 'vitest';
import type { ChannelSummary, Notice } from '@dilla/client-core';
import { FakeClient } from './test/fake-client.ts';
import { noticeTitle, shouldNotify, startNotifier, type NotifyContext } from './notify.ts';

const A = 'a1'.repeat(16);
const GEN = 'c3'.repeat(16);
const RAND = 'd4'.repeat(16);
const DM = '9a'.repeat(16);
const ch = (id: string, name: string): ChannelSummary =>
  ({ id, communityId: A, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'active' });
const notice = (over: Partial<Notice> = {}): Notice => ({
  id: 0, channelId: RAND, communityId: A, kind: 'message', senderUser: '28'.repeat(16), senderName: 'bob', body: 'hi', ts: 1_790_000_000, ...over,
});
const dmNotice = (over: Partial<Notice> = {}): Notice => notice({ channelId: DM, communityId: null, kind: 'dm', ...over });
const ctx = (over: Partial<NotifyContext> = {}): NotifyContext => ({ permission: 'granted', settings: {}, visible: true, onScreen: GEN, ...over });

describe('shouldNotify (L-TS-25)', () => {
  const rows: [string, Notice, 0 | 3 | 4, NotifyContext, boolean][] = [
    ['a DM by default', dmNotice(), 3, ctx(), true],
    ['a group DM by default', dmNotice(), 4, ctx(), true],
    ['a plain message by default', notice(), 0, ctx(), false],
    ['a mention by default', notice({ kind: 'mention' }), 0, ctx(), true],
    ['a mention in the channel on screen', notice({ channelId: GEN, kind: 'mention' }), 0, ctx(), false],
    ['a DM on screen', dmNotice(), 3, ctx({ onScreen: DM }), false],
    ['a mention in the channel on screen while the page is hidden', notice({ channelId: GEN, kind: 'mention' }), 0, ctx({ visible: false }), true],
    ['without permission', notice({ kind: 'mention' }), 0, ctx({ permission: 'default' }), false],
    ['when denied', notice({ kind: 'mention' }), 0, ctx({ permission: 'denied' }), false],
    ['without the API', notice({ kind: 'mention' }), 0, ctx({ permission: 'unsupported' }), false],
    ['in a muted channel', notice({ kind: 'mention' }), 0, ctx({ settings: { [`mute.channel.${RAND}`]: '1' } }), false],
    ['in a muted DM', dmNotice(), 3, ctx({ settings: { [`mute.channel.${DM}`]: '1' } }), false],
    ['a message when the default is everything', notice(), 0, ctx({ settings: { 'notify.default': 'everything' } }), true],
    ['a mention when the default is nothing', notice({ kind: 'mention' }), 0, ctx({ settings: { 'notify.default': 'nothing' } }), false],
    ['a DM when the default is nothing', dmNotice(), 3, ctx({ settings: { 'notify.default': 'nothing' } }), false],
    ['a channel set to all under nothing', notice(), 0, ctx({ settings: { 'notify.default': 'nothing', [`notify.channel.${RAND}`]: 'all' } }), true],
    ['a DM set to nothing', dmNotice(), 3, ctx({ settings: { [`notify.channel.${DM}`]: 'nothing' } }), false],
    ['a DM set to mentions', dmNotice(), 3, ctx({ settings: { [`notify.channel.${DM}`]: 'mentions' } }), true],
    ['a plain message in a channel set to mentions', notice(), 0, ctx({ settings: { 'notify.default': 'everything', [`notify.channel.${RAND}`]: 'mentions' } }), false],
  ];
  it.each(rows)('%s', (_, n, kind, c, want) => {
    expect(shouldNotify(n, kind, c)).toBe(want);
  });
});

describe('noticeTitle', () => {
  it('names the channel and server, or the sender of a DM', () => {
    expect(noticeTitle(notice(), { channel: 'random', server: 'Midgard' })).toBe('#random · Midgard');
    expect(noticeTitle(dmNotice({ senderName: 'bob' }), { channel: null, server: null })).toBe('bob');
    expect(noticeTitle(notice(), { channel: null, server: null })).toBe('#d4d4d4d4 · a1a1a1a1');
  });
});

class Note {
  static permission: NotificationPermission = 'granted';
  static made: Note[] = [];
  onclick: ((ev: Event) => unknown) | null = null;
  closed = false;
  constructor(readonly title: string, readonly options: NotificationOptions) { Note.made.push(this); }
  close(): void { this.closed = true; }
}

function harness(over: { visible?: boolean; onScreen?: string | null } = {}) {
  Note.made = [];
  Note.permission = 'granted';
  const fake = new FakeClient();
  fake.set('communities', [{ id: A, name: 'Midgard' }]);
  fake.set(`channels:${A}`, [ch(GEN, 'general'), ch(RAND, 'random')]);
  fake.set('dms', [{ id: DM, kind: 3, members: [], name: 'bob', group: 'active' }]);
  fake.set('settings', {});
  const focus = vi.fn();
  const open = vi.fn();
  const start = () => startNotifier({
    client: fake, Notification: Note, visible: () => over.visible ?? true, onScreen: () => over.onScreen ?? GEN, focus, open,
  });
  return { fake, focus, open, start };
}

describe('startNotifier', () => {
  it('never replays what the first slice held, then shows each new item once', () => {
    const h = harness();
    const old = [0, 1, 2].map(id => notice({ id, kind: 'mention' }));
    h.fake.set('notices', { nextId: 3, items: old });
    const stop = h.start();
    expect(Note.made).toEqual([]);
    h.fake.set('notices', { nextId: 4, items: [...old, notice({ id: 3, kind: 'mention', body: 'look' })] });
    expect(Note.made.map(n => [n.title, n.options])).toEqual([['#random · Midgard', { body: 'look', tag: `dilla:${RAND}`, silent: false }]]);
    expect('icon' in Note.made[0].options).toBe(false);
    h.fake.set('notices', { nextId: 4, items: [...old, notice({ id: 3, kind: 'mention', body: 'look' })] });
    expect(Note.made).toHaveLength(1);
    stop();
    h.fake.set('notices', { nextId: 5, items: [notice({ id: 4, kind: 'mention' })] });
    expect(Note.made).toHaveLength(1);
  });
  it('starts counting at the first slice that arrives after it started', () => {
    const h = harness();
    const stop = h.start();
    h.fake.set('notices', { nextId: 0, items: [] });
    h.fake.set('notices', { nextId: 1, items: [dmNotice({ id: 0, body: 'yo' })] });
    expect(Note.made.map(n => [n.title, n.options.tag])).toEqual([['bob', `dilla:${DM}`]]);
    stop();
  });
  it('applies the rules to each item', () => {
    const h = harness();
    h.fake.set('notices', { nextId: 0, items: [] });
    const stop = h.start();
    h.fake.set('notices', { nextId: 3, items: [notice({ id: 0 }), notice({ id: 1, kind: 'mention', body: 'm' }), notice({ id: 2, channelId: GEN, kind: 'mention' })] });
    expect(Note.made.map(n => n.options.body)).toEqual(['m']);
    stop();
  });
  it('focuses the tab, opens the channel and closes on click', () => {
    const h = harness();
    h.fake.set('notices', { nextId: 0, items: [] });
    const stop = h.start();
    const n = notice({ id: 0, kind: 'mention' });
    h.fake.set('notices', { nextId: 1, items: [n] });
    Note.made[0].onclick?.(new Event('click'));
    expect(h.focus).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith(n);
    expect(Note.made[0].closed).toBe(true);
    stop();
  });
  it('shows nothing without permission, and survives a constructor that throws', () => {
    const h = harness();
    Note.permission = 'default';
    h.fake.set('notices', { nextId: 0, items: [] });
    const stop = h.start();
    h.fake.set('notices', { nextId: 1, items: [notice({ id: 0, kind: 'mention' })] });
    expect(Note.made).toEqual([]);
    stop();
    class Broken {
      static permission: NotificationPermission = 'granted';
      onclick: ((ev: Event) => unknown) | null = null;
      constructor() { throw new TypeError('no notifications here'); }
      close(): void {}
    }
    const again = startNotifier({ client: h.fake, Notification: Broken, visible: () => true, onScreen: () => null, focus: h.focus, open: h.open });
    expect(() => h.fake.set('notices', { nextId: 2, items: [notice({ id: 1, kind: 'mention' })] })).not.toThrow();
    again();
  });
});
