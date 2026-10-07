import { describe, expect, it } from 'vitest';
import type { GroupInfo, OutboxRow, TimelineRow } from '../core-port';
import { buildTimeline, channelGroupState, type GroupMembership } from './derive';

const id = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const hex = (b: number): string => b.toString(16).padStart(2, '0').repeat(16);
const OWN_USER = 0x0a;
const OWN_DEVICE = 0x0b;
const PEER_USER = 0x1a;
const PEER_DEVICE = 0x1b;
/** The folded fields of a row nothing folded onto (L-TS-36). */
const PLAIN = { edited: false, reply: null, reactions: [], pinned: false, attachments: [], mention: false, actions: [] };

function row(seq: number, over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    seq: BigInt(seq), epoch: 1n, recvTs: 1_700_000_000n + BigInt(seq), status: 0, reason: '',
    senderUser: id(PEER_USER), senderDevice: id(PEER_DEVICE), senderKind: 0, senderTier: 0,
    msgId: id(0x30 + seq), type: 0, body: `body ${seq}`,
    editedSeq: 0n, reply: null, reactions: [], pinned: false, attachments: [], mention: false, ...over,
  };
}

function outbox(m: number, state: 0 | 1 | 2, over: Partial<OutboxRow> = {}): OutboxRow {
  return { msgId: id(m), state, error: '', created: 1_700_000_100n, body: `draft ${m}`, type: 0, replyTo: null, attachments: [], ...over };
}

function timeline(rows: TimelineRow[], out: OutboxRow[] = [], limit = 100) {
  return buildTimeline({
    channelId: 'c'.repeat(32), group: 'active', rows, outbox: out,
    ownUser: id(OWN_USER), ownDevice: id(OWN_DEVICE), limit,
  });
}

describe('buildTimeline', () => {
  it("maps a peer's readable row with its authenticated sender", () => {
    expect(timeline([row(1)])).toEqual({
      channelId: 'c'.repeat(32), group: 'active', hasEarlier: false,
      items: [{
        key: 's1', state: 'ok', reason: '', senderUser: hex(PEER_USER), senderDevice: hex(PEER_DEVICE),
        own: false, web: false, bot: false, ts: 1_700_000_001, body: 'body 1', msgId: hex(0x31), seq: '1', ...PLAIN,
      }],
    });
  });

  it("marks this device's rows as own and a browser-tier sender as web", () => {
    const [item] = timeline([row(2, { senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 })]).items;
    expect(item).toMatchObject({ key: `o${hex(0x32)}`, own: true, web: true, bot: false, seq: '2' });
  });

  it('a sent message keeps its key when it is confirmed', () => {
    const m = 0x45;
    const pending = timeline([], [outbox(m, 1)]).items;
    const stored = timeline([row(12, { msgId: id(m), senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 })]).items;
    expect(pending.map((i) => [i.key, i.state, i.seq])).toEqual([[`o${hex(m)}`, 'pending', null]]);
    expect(stored.map((i) => [i.key, i.state, i.seq])).toEqual([[`o${hex(m)}`, 'ok', '12']]);
    expect(timeline([row(13, { msgId: null, senderDevice: id(OWN_DEVICE) })]).items[0]?.key).toBe('s13');
    expect(timeline([row(14, { msgId: id(m) })]).items[0]?.key).toBe('s14');
  });

  it('marks a bot sender', () => {
    const [item] = timeline([row(3, { senderKind: 1 })]).items;
    expect(item).toMatchObject({ key: 's3', bot: true, web: false, own: false });
  });

  it('shows an unreadable row with its raw reason and never a body', () => {
    const [item] = timeline([row(4, {
      status: 1, reason: 'E_SENDER_MISMATCH', senderUser: null, senderKind: null, senderTier: null,
      msgId: null, type: null, body: 'must not show',
    })]).items;
    expect(item).toEqual({
      key: 's4', state: 'cannot-read', reason: 'E_SENDER_MISMATCH', senderUser: null, senderDevice: hex(PEER_DEVICE),
      own: false, web: false, bot: false, ts: 1_700_000_004, body: '', msgId: null, seq: '4', ...PLAIN,
    });
  });

  it('shows a deleted row without its body', () => {
    const [item] = timeline([row(5, { status: 2, body: 'gone' })]).items;
    expect(item).toMatchObject({ key: 's5', state: 'deleted', reason: '', body: '', seq: '5' });
  });

  it('leaves out stored rows of envelope types other than 0', () => {
    expect(timeline([row(6, { type: 3 }), row(7)]).items.map((i) => i.key)).toEqual(['s7']);
  });

  it('appends the outbox after the stored rows: queued and in flight are pending, failed carries its error', () => {
    const items = timeline([row(8)], [outbox(0x41, 0), outbox(0x42, 1), outbox(0x43, 2, { error: 'E_TOO_LARGE' })]).items;
    expect(items.map((i) => [i.key, i.state, i.reason])).toEqual([
      ['s8', 'ok', ''],
      [`o${hex(0x41)}`, 'pending', ''],
      [`o${hex(0x42)}`, 'pending', ''],
      [`o${hex(0x43)}`, 'failed', 'E_TOO_LARGE'],
    ]);
    expect(items[1]).toEqual({
      key: `o${hex(0x41)}`, state: 'pending', reason: '', senderUser: hex(OWN_USER), senderDevice: hex(OWN_DEVICE),
      own: true, web: true, bot: false, ts: 1_700_000_100, body: 'draft 65', msgId: hex(0x41), seq: null, ...PLAIN,
    });
  });

  it('drops an outbox row whose message is already stored', () => {
    const stored = row(9, { msgId: id(0x44), senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 });
    expect(timeline([stored], [outbox(0x44, 1)]).items.map((i) => [i.key, i.state])).toEqual([[`o${hex(0x44)}`, 'ok']]);
  });

  it('keeps the outbox key of an own upload deleted before it was confirmed', () => {
    const marker = row(10, { status: 2, body: '', msgId: id(0x45), senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 });
    expect(timeline([marker], []).items.map((i) => [i.key, i.state, i.own, i.body])).toEqual([[`o${hex(0x45)}`, 'deleted', true, '']]);
  });

  it('reports earlier rows when the core filled the page', () => {
    expect(timeline([row(10), row(11)], [], 2).hasEarlier).toBe(true);
    expect(timeline([row(10)], [], 2).hasEarlier).toBe(false);
  });

  it('maps the folded view: the edit, the reply, reactions, the pin, attachments and the mention flag', () => {
    const [item] = timeline([row(2, {
      body: 'edited text', editedSeq: 9n, pinned: true, mention: true,
      reply: { replyTo: id(0x31), targetSeq: 1n, targetUser: id(PEER_USER), excerpt: 'body 1', state: 0 },
      reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '🦀', count: 1, mine: false }],
      attachments: [
        { index: 0, size: 1234, mime: 'image/png', w: 640, h: 480, hasThumb: true, name: 'map.png' },
        { index: 1, size: 26_214_401, mime: 'application/pdf', w: null, h: null, hasThumb: false, name: 'a/b‮c.pdf' },
        { index: 2, size: 5, mime: 'image/svg+xml', w: null, h: null, hasThumb: false, name: '' },
      ],
    })]).items;
    expect(item).toMatchObject({
      seq: '2', body: 'edited text', edited: true, pinned: true, mention: true, actions: [],
      reply: { msgId: hex(0x31), state: 'ok', senderUser: hex(PEER_USER), excerpt: 'body 1', seq: '1' },
      reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '🦀', count: 1, mine: false }],
      attachments: [
        { index: 0, size: 1234, mime: 'image/png', name: 'map.png', w: 640, h: 480, thumb: true, kind: 'image', tooLarge: false },
        { index: 1, size: 26_214_401, mime: 'application/pdf', name: 'a_bc.pdf', w: null, h: null, thumb: false, kind: 'file', tooLarge: true },
        { index: 2, size: 5, mime: 'image/svg+xml', name: '', w: null, h: null, thumb: false, kind: 'file', tooLarge: false },
      ],
    });
  });

  it('names the reply state of a target that is not held and of one that was deleted', () => {
    const items = timeline([
      row(3, { reply: { replyTo: id(0x7e), targetSeq: null, targetUser: null, excerpt: '', state: 1 } }),
      row(4, { reply: { replyTo: id(0x31), targetSeq: 1n, targetUser: id(PEER_USER), excerpt: '', state: 2 } }),
    ]).items;
    expect(items.map((i) => i.reply)).toEqual([
      { msgId: hex(0x7e), state: 'missing', senderUser: null, excerpt: '', seq: null },
      { msgId: hex(0x31), state: 'deleted', senderUser: hex(PEER_USER), excerpt: '', seq: '1' },
    ]);
  });

  it('a pending or failed fold in the outbox is an action on its target and never an item of its own', () => {
    const items = timeline([row(2)], [
      outbox(0x50, 0, { type: 1, replyTo: id(0x32), body: 'better' }),
      outbox(0x51, 2, { type: 3, replyTo: id(0x32), body: '👍', error: 'E_NETWORK' }),
      outbox(0x52, 1, { type: 5, replyTo: id(0x7f), body: '' }),
    ]).items;
    expect(items.map((i) => i.key)).toEqual(['s2']);
    expect(items[0]?.actions).toEqual([
      { msgId: hex(0x50), type: 1, state: 'pending', reason: '' },
      { msgId: hex(0x51), type: 3, state: 'failed', reason: 'E_NETWORK' },
    ]);
  });

  it('a queued message shows its files and its reply reference from the outbox', () => {
    const target = row(3, { body: `line one\nline two\r${'é'.repeat(130)}` });
    const items = timeline([target], [outbox(0x53, 0, {
      body: '', replyTo: id(0x33),
      attachments: [
        { blobId: new Uint8Array(32).fill(1), size: 2048, mime: 'image/webp', name: 'shot.webp' },
        { blobId: new Uint8Array(32).fill(2), size: 26_214_401, mime: 'text/plain', name: '' },
      ],
    }), outbox(0x54, 0, { body: 'to nobody', replyTo: id(0x7d) })]).items;
    expect(items[1]).toMatchObject({
      key: `o${hex(0x53)}`, state: 'pending', seq: null, body: '',
      reply: { msgId: hex(0x33), state: 'ok', senderUser: hex(PEER_USER), excerpt: `line one line two ${'é'.repeat(102)}`, seq: '3' },
      attachments: [
        { index: 0, size: 2048, mime: 'image/webp', name: 'shot.webp', w: null, h: null, thumb: false, kind: 'image', tooLarge: false },
        { index: 1, size: 26_214_401, mime: 'text/plain', name: '', w: null, h: null, thumb: false, kind: 'file', tooLarge: true },
      ],
    });
    expect(Array.from(items[1]?.reply?.excerpt ?? '')).toHaveLength(120);
    expect(items[2]?.reply).toEqual({ msgId: hex(0x7d), state: 'missing', senderUser: null, excerpt: '', seq: null });
    expect(JSON.stringify(items)).not.toContain('"blobId"');
  });
});

function group(target: number, state: 0 | 1 | 2 | 3 | 4, kind = 0): GroupInfo {
  return {
    groupId: id(0x60 + state + kind * 8), kind, communityId: id(0x70), targetId: id(target), state,
    epoch: 1n, nextSeq: 1n, proposalsPending: 0, pendingCommit: false,
  };
}
const channel = (over: Partial<{ kind: number; mode: number }> = {}) => ({ id: id(0x50), kind: 0, mode: 0, ...over });
const known = (over: { refusedChannel?: boolean; notMember?: string[]; resyncing?: string[] } = {}): GroupMembership => ({
  refusedChannel: over.refusedChannel ?? false, notMember: new Set(over.notMember ?? []), resyncing: new Set(over.resyncing ?? []),
});
const NONE = known();
const REFUSED = known({ refusedChannel: true });

describe('channelGroupState', () => {
  it('calls a voice channel, a category and a readable channel unsupported', () => {
    expect(channelGroupState(channel({ kind: 1 }), [group(0x50, 2)], NONE)).toBe('unsupported');
    expect(channelGroupState(channel({ kind: 2 }), [], NONE)).toBe('unsupported');
    expect(channelGroupState(channel({ mode: 1 }), [group(0x50, 2)], NONE)).toBe('unsupported');
  });

  it('maps the local text group state', () => {
    expect(channelGroupState(channel(), [], NONE)).toBe('none');
    const cases = [[0, 'joining'], [1, 'joining'], [2, 'active'], [3, 'resync'], [4, 'not-member']] as const;
    for (const [state, want] of cases) expect(channelGroupState(channel(), [group(0x50, state)], NONE)).toBe(want);
  });

  it("ignores another channel's group and a call group of this channel", () => {
    expect(channelGroupState(channel(), [group(0x51, 2), group(0x50, 2, 1)], NONE)).toBe('none');
  });

  it('prefers a live group over a gone one', () => {
    expect(channelGroupState(channel(), [group(0x50, 4), group(0x50, 2)], NONE)).toBe('active');
  });

  it('reports not-member after a refused open unless a group is joining or active', () => {
    expect(channelGroupState(channel(), [], REFUSED)).toBe('not-member');
    expect(channelGroupState(channel(), [group(0x50, 3)], REFUSED)).toBe('not-member');
    expect(channelGroupState(channel(), [group(0x50, 1)], REFUSED)).toBe('joining');
    expect(channelGroupState(channel(), [group(0x50, 2)], REFUSED)).toBe('active');
  });

  it("follows what onMembership reported for the channel's own group", () => {
    // group(0x50, s) has the id id(0x60 + s), so its hex is hex(0x60 + s).
    expect(channelGroupState(channel(), [group(0x50, 2)], known({ resyncing: [hex(0x62)] }))).toBe('resync');
    expect(channelGroupState(channel(), [group(0x50, 3)], known({ resyncing: [hex(0x63)] }))).toBe('resync');
    expect(channelGroupState(channel(), [group(0x50, 3)], known({ notMember: [hex(0x63)] }))).toBe('not-member');
    // Another group's report changes nothing.
    expect(channelGroupState(channel(), [group(0x50, 3)], known({ notMember: [hex(0x62)] }))).toBe('resync');
    expect(channelGroupState(channel(), [group(0x50, 2)], known({ resyncing: [hex(0x63)] }))).toBe('active');
  });

  it('reports not-member for an active row whose resync was refused (a kicked device keeps its row in state 2)', () => {
    expect(channelGroupState(channel(), [group(0x50, 2)], known({ notMember: [hex(0x62)] }))).toBe('not-member');
    // Another group's report changes nothing.
    expect(channelGroupState(channel(), [group(0x50, 2)], known({ notMember: [hex(0x63)] }))).toBe('active');
  });
});
