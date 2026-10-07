import { describe, expect, it } from 'vitest';
import type { GroupInfo, OutboxRow, TimelineRow } from '../core-port';
import { buildTimeline, channelGroupState, type GroupMembership } from './derive';

const id = (b: number): Uint8Array => new Uint8Array(16).fill(b);
const hex = (b: number): string => b.toString(16).padStart(2, '0').repeat(16);
const OWN_USER = 0x0a;
const OWN_DEVICE = 0x0b;
const PEER_USER = 0x1a;
const PEER_DEVICE = 0x1b;

function row(seq: number, over: Partial<TimelineRow> = {}): TimelineRow {
  return {
    seq: BigInt(seq), epoch: 1n, recvTs: 1_700_000_000n + BigInt(seq), status: 0, reason: '',
    senderUser: id(PEER_USER), senderDevice: id(PEER_DEVICE), senderKind: 0, senderTier: 0,
    msgId: id(0x30 + seq), type: 0, body: `body ${seq}`,
    editedSeq: 0n, reply: null, reactions: [], pinned: false, attachments: [], mention: false, ...over,
  };
}

function outbox(m: number, state: 0 | 1 | 2, over: Partial<OutboxRow> = {}): OutboxRow {
  return { msgId: id(m), state, error: '', created: 1_700_000_100n, body: `draft ${m}`, ...over };
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
        own: false, web: false, bot: false, ts: 1_700_000_001, body: 'body 1', msgId: hex(0x31),
      }],
    });
  });

  it("marks this device's rows as own and a browser-tier sender as web", () => {
    const [item] = timeline([row(2, { senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 })]).items;
    expect(item).toMatchObject({ key: `o${hex(0x32)}`, own: true, web: true, bot: false });
  });

  it('a sent message keeps its key when it is confirmed', () => {
    const m = 0x45;
    const pending = timeline([], [outbox(m, 1)]).items;
    const stored = timeline([row(12, { msgId: id(m), senderUser: id(OWN_USER), senderDevice: id(OWN_DEVICE), senderTier: 1 })]).items;
    expect(pending.map((i) => [i.key, i.state])).toEqual([[`o${hex(m)}`, 'pending']]);
    expect(stored.map((i) => [i.key, i.state])).toEqual([[`o${hex(m)}`, 'ok']]);
    // An own row whose message id is unknown, and a peer's row, keep the seq key.
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
      own: false, web: false, bot: false, ts: 1_700_000_004, body: '', msgId: null,
    });
  });

  it('shows a deleted row without its body', () => {
    const [item] = timeline([row(5, { status: 2, body: 'gone' })]).items;
    expect(item).toMatchObject({ key: 's5', state: 'deleted', reason: '', body: '' });
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
      own: true, web: true, bot: false, ts: 1_700_000_100, body: 'draft 65', msgId: hex(0x41),
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

  it('reports earlier rows when the core filled the page, counting rows it did not show', () => {
    expect(timeline([row(10), row(11)], [], 2).hasEarlier).toBe(true);
    expect(timeline([row(10, { type: 4 }), row(11)], [], 2).hasEarlier).toBe(true);
    expect(timeline([row(10)], [], 2).hasEarlier).toBe(false);
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
