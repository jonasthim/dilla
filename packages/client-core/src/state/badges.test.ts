import { describe, expect, it } from 'vitest';
import type { ActivityRow, TimelineRow } from '../core-port';
import { toHex } from '../hex';
import { NOTICES_MAX, NOTICE_BODY_MAX, appendNotices, buildBadges, mentionsMe, noticeOf, type NoticeDraft } from './badges';

const G1 = new Uint8Array(16).fill(1);
const G2 = new Uint8Array(16).fill(2);
const G3 = new Uint8Array(16).fill(3);
const CH = 'c1'.repeat(16);
const CH2 = 'c2'.repeat(16);
const COMMUNITY = 'c0'.repeat(16);
const USER_HEX = '0a'.repeat(16);
const act = (g: Uint8Array, unread: number, mentions: number): ActivityRow =>
  ({ groupId: g, unread, mentions, lastSeq: BigInt(unread), lastTs: 1_700_000_000n, lastReadSeq: 0n });
const row = (seq: number, body: string): TimelineRow => ({
  seq: BigInt(seq), epoch: 1n, recvTs: 1_700_000_000n + BigInt(seq), status: 0, reason: '', senderUser: new Uint8Array(16).fill(0x5a),
  senderDevice: new Uint8Array(16).fill(0x5b), senderKind: 0, senderTier: 0, msgId: new Uint8Array(16).fill(seq), type: 0, body,
});
const draft = (n: number): NoticeDraft => ({ channelId: CH, communityId: COMMUNITY, kind: 'message', senderUser: null, senderName: 'p', body: `m${n}`, ts: n });

describe('mentionsMe (the L-CORE-24 literal rule)', () => {
  it('matches the readable syntax and nothing else', () => {
    expect(mentionsMe(`hi <@${USER_HEX}>`, USER_HEX)).toBe(true);
    expect(mentionsMe('<@everyone> lunch', USER_HEX)).toBe(true);
    expect(mentionsMe('ping <@here>', USER_HEX)).toBe(true);
    expect(mentionsMe(`<@${USER_HEX.toUpperCase()}>`, USER_HEX)).toBe(false);
    expect(mentionsMe(`<@${USER_HEX}`, USER_HEX)).toBe(false);
    expect(mentionsMe(`@${USER_HEX}`, USER_HEX)).toBe(false);
    expect(mentionsMe('<@Everyone>', USER_HEX)).toBe(false);
    expect(mentionsMe(`<@${'0b'.repeat(16)}>`, USER_HEX)).toBe(false);
  });
});

describe('buildBadges', () => {
  it('keys counts by channel and drops a group bound to no known channel', () => {
    expect(buildBadges([act(G1, 3, 1), act(G2, 5, 2)], new Map([[toHex(G1), CH]]))).toEqual({ [CH]: { unread: 3, mentions: 1 } });
  });

  it('sums two groups of one channel and keeps zero rows', () => {
    const map = new Map([[toHex(G1), CH], [toHex(G2), CH], [toHex(G3), CH2]]);
    expect(buildBadges([act(G1, 1, 0), act(G2, 2, 1), act(G3, 0, 0)], map)).toEqual({
      [CH]: { unread: 3, mentions: 1 }, [CH2]: { unread: 0, mentions: 0 },
    });
  });

  it('is empty without activity', () => {
    expect(buildBadges([], new Map([[toHex(G1), CH]]))).toEqual({});
  });
});

describe('notices', () => {
  it('builds a notice from a stored row', () => {
    expect(noticeOf({ row: row(4, 'hello'), channelId: CH, communityId: COMMUNITY, dm: false, mention: false, senderName: 'Peer' })).toEqual({
      channelId: CH, communityId: COMMUNITY, kind: 'message', senderUser: '5a'.repeat(16), senderName: 'Peer', body: 'hello', ts: 1_700_000_004,
    });
  });

  it('a DM is dm whatever the mention, a mention outside DMs is mention', () => {
    expect(noticeOf({ row: row(1, 'x'), channelId: CH, communityId: null, dm: true, mention: true, senderName: 'p' }).kind).toBe('dm');
    expect(noticeOf({ row: row(1, 'x'), channelId: CH, communityId: COMMUNITY, dm: false, mention: true, senderName: 'p' }).kind).toBe('mention');
  });

  it('cuts the body at 200 code points', () => {
    const long = noticeOf({ row: row(1, '😀'.repeat(250)), channelId: CH, communityId: null, dm: true, mention: false, senderName: 'p' });
    expect(Array.from(long.body)).toHaveLength(NOTICE_BODY_MAX);
    expect(long.body).toBe('😀'.repeat(200));
  });

  it('numbers notices and keeps the newest 32', () => {
    let state = { nextId: 1, items: [] as ReturnType<typeof appendNotices>['items'] };
    state = appendNotices(state, [draft(1), draft(2)]);
    expect(state.nextId).toBe(3);
    expect(state.items.map((n) => n.id)).toEqual([1, 2]);
    expect(appendNotices(state, [])).toEqual(state);
    state = appendNotices(state, Array.from({ length: 38 }, (_, i) => draft(i + 3)));
    expect(state.nextId).toBe(41);
    expect(state.items).toHaveLength(NOTICES_MAX);
    expect(state.items[0]).toMatchObject({ id: 9, body: 'm9' });
    expect(state.items.at(-1)).toMatchObject({ id: 40, body: 'm40' });
  });
});
