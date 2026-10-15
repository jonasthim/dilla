// web3.5 C4: who may pin and mention everyone, per channel group (authorityFor), and the worker's push into the core.
import { describe, expect, it, vi } from 'vitest';
import type { GroupInfo, PinRow } from '../core-port';
import type { GatewayEvent } from '../gateway/gateway';
import { Op } from '../gateway/frames';
import { fromHex, toHex } from '../hex';
import type { OverwriteRow, RoleRow } from '../http/routes';
import type { CommunityAccess, PinnedItem } from '../state/types';
import {
  CHANNEL, COMMUNITY, DM_CHANNEL, DM_GROUP, GROUP, LOCK, READY_INFO, STRANGER, USER, applied, strangerRow, textGroup, toReady, world, type World,
} from '../worker/world';
import { authorityFor } from './authority';
import { PERM, channelBitsOf } from './perm';

const id16 = (n: number): Uint8Array => new Uint8Array(16).fill(n);
const hex = (n: number): string => toHex(id16(n));
const VIEW = PERM.viewChannel;
const PIN = PERM.pinMessages;
const ALL = PERM.mentionEveryone;

describe('authorityFor', () => {
  const owner = hex(0x0a);
  const everyoneId = hex(0x40);
  const mod = hex(0x41);
  const [a, b, c] = [hex(0x5c), hex(0x5a), hex(0x5b)];
  const base = {
    owner, everyoneId,
    roles: [{ id: everyoneId, position: 0, allow: VIEW, deny: 0 }, { id: mod, position: 1, allow: PIN | ALL, deny: 0 }],
    members: [{ userId: owner, roleIds: [] }, { userId: a, roleIds: [mod] }, { userId: b, roleIds: [] }, { userId: c, roleIds: [mod] }],
    overwrites: {},
    channels: [{ id: hex(0xc1), kind: 0, mode: 0, textGroupId: hex(0xc2) }],
  };

  it('lists the members whose channel bits hold pin and mention-everyone, sorted, the owner included', () => {
    expect(authorityFor(base)).toEqual(new Map([[hex(0xc2), { pinners: [owner, c, a], broadcasters: [owner, c, a] }]]));
  });

  it('covers only text channels (kind 0, mode 0) that have a group', () => {
    const channels = [
      { id: hex(0xc1), kind: 0, mode: 1, textGroupId: hex(0xc2) }, { id: hex(0xc3), kind: 1, mode: 0, textGroupId: hex(0xc4) },
      { id: hex(0xc5), kind: 0, mode: 0, textGroupId: null }, { id: hex(0xc6), kind: 0, mode: 0, textGroupId: hex(0xc7) },
    ];
    expect([...authorityFor({ ...base, channels }).keys()]).toEqual([hex(0xc7)]);
  });

  it("counts a channel's own overwrites only, never another channel's", () => {
    const deny = { kind: 0 as const, targetId: mod, allow: 0, deny: PIN };
    const other = authorityFor({ ...base, overwrites: { [hex(0xc9)]: [deny] } }).get(hex(0xc2));
    expect(other?.pinners).toEqual([owner, c, a]);
    const own = authorityFor({ ...base, overwrites: { [hex(0xc1)]: [deny, { kind: 1, targetId: b, allow: PIN, deny: 0 }] } }).get(hex(0xc2));
    expect(own).toEqual({ pinners: [owner, b], broadcasters: [owner, c, a] });
  });

  it('drops a member whose role lost the bit, and one who cannot view the channel', () => {
    const roles = [base.roles[0], { id: mod, position: 1, allow: ALL, deny: 0 }];
    expect(authorityFor({ ...base, roles }).get(hex(0xc2))).toEqual({ pinners: [owner], broadcasters: [owner, c, a] });
    const hidden = { [hex(0xc1)]: [{ kind: 0 as const, targetId: everyoneId, allow: 0, deny: VIEW }] };
    expect(authorityFor({ ...base, overwrites: hidden }).get(hex(0xc2))).toEqual({ pinners: [owner], broadcasters: [owner] });
  });
});

/** A server of `n` members over `roles` roles and `channels` channels; every third channel has overwrites of its own. */
function bigServer(n: number, roles: number, channels: number) {
  const id = (k: number, i: number): string => k.toString(16).padStart(2, '0') + i.toString(16).padStart(30, '0');
  const everyoneId = id(0x40, 0);
  const roleRows = [{ id: everyoneId, position: 0, allow: VIEW, deny: 0 },
    ...Array.from({ length: roles }, (_, r) => ({ id: id(0x41, r), position: 1 + (r % 7), allow: r % 2 === 0 ? PIN : ALL | PIN, deny: r % 5 === 0 ? VIEW : 0 }))];
  const members = Array.from({ length: n }, (_, i) => ({ userId: id(0x50, i), roleIds: [id(0x41, i % roles), id(0x41, (i * 7) % roles)] }));
  const overwrites: Record<string, { kind: 0 | 1; targetId: string; allow: number; deny: number }[]> = {};
  const list = Array.from({ length: channels }, (_, c) => {
    if (c % 3 === 0) {
      overwrites[id(0xc1, c)] = [{ kind: 0, targetId: everyoneId, allow: 0, deny: c % 2 === 0 ? VIEW : 0 },
        { kind: 0, targetId: id(0x41, c % roles), allow: VIEW, deny: PIN }, { kind: 1, targetId: id(0x50, c), allow: VIEW | PIN, deny: ALL }];
    }
    return { id: id(0xc1, c), kind: 0, mode: 0, textGroupId: id(0xc2, c) };
  });
  return { owner: id(0x50, 3), everyoneId, roles: roleRows, members, overwrites, channels: list };
}

describe('authorityFor at scale (C4 fix round 1)', () => {
  it('answers what channelBitsOf answers member by member', () => {
    const s = bigServer(120, 11, 12);
    for (const channel of s.channels) {
      const input = { ...s, overwrites: s.overwrites[channel.id] ?? [] };
      const users = [...new Set([s.owner, ...s.members.map((m) => m.userId)])].sort();
      const pick = (bit: number): string[] => users.filter((u) => ((channelBitsOf(input, u) ?? 0) & bit) !== 0);
      expect(authorityFor(s).get(channel.textGroupId)).toEqual({ pinners: pick(PIN), broadcasters: pick(ALL) });
    }
  });

  // Ten pushes of a server of 50 channels and 1000 members: about 35 ms here; the O(channels × members²) first version
  // took about 2 s.
  it('computes ten views of 50 channels and 1000 members in under 300 ms', () => {
    const s = bigServer(1000, 20, 50);
    const started = performance.now();
    let views = new Map<string, unknown>();
    for (let i = 0; i < 10; i++) views = authorityFor(s);
    expect(performance.now() - started).toBeLessThan(300);
    expect(views.size).toBe(50);
  });
});

// ---- the worker ----

const CID = toHex(COMMUNITY);
const CH = toHex(CHANNEL);
const G = toHex(GROUP);
const EVERYONE = id16(0x40);
const MOD = id16(0x41);
const role = (id: Uint8Array, position: number, allow: number): RoleRow => ({ id, name: `r${String(position)}`, color: 0, position, allow, deny: 0,
  hoist: false, mentionable: false });
const member = (userId: Uint8Array<ArrayBuffer>, roleIds: Uint8Array[]) => ({ userId, username: toHex(userId).slice(0, 4), display: '', kind: 0 as const, nick: '', roleIds });
let next = 8000;
async function run(w: World, command: Record<string, unknown>): Promise<unknown> {
  next += 1;
  const id = next;
  w.call(id, command);
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}
const pushes = (w: World): [string, string[], string[]][] =>
  w.core.authoritySet.mock.calls.map(([g, p, b]) => [toHex(g), p.map(toHex), b.map(toHex)]);
const BOTH = [toHex(USER), toHex(STRANGER)].sort();

/** A ready world: I own the server, the stranger holds MOD (pin and mention everyone), and the core holds the channel's group. */
async function ready(opts: { groups?: GroupInfo[]; now?: () => number } = {}): Promise<World> {
  const w = world(opts.now === undefined ? {} : { now: opts.now });
  w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW | PERM.sendMessages), role(MOD, 1, PIN | ALL)]);
  w.routes.listOverwrites.mockResolvedValue([] as OverwriteRow[]);
  w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [MOD])]);
  w.state.groups = opts.groups ?? [textGroup(2)];
  await toReady(w);
  await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)?.everyoneId).toBe(toHex(EVERYONE)));
  return w;
}

describe('the worker pushes the role view into the core', () => {
  it('sends each group its view once, and a demotion sends it again without the demoted member', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(pushes(w)).toEqual([[G, BOTH, BOTH]]));
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [])]);
    await run(w, { m: 'revokeRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    expect(pushes(w)).toEqual([[G, BOTH, BOTH], [G, [toHex(USER)], [toHex(USER)]]]);
  });

  it('sends nothing again while the inputs are unchanged', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    await run(w, { m: 'selectCommunity', communityId: CID });
    await run(w, { m: 'setOverwrite', channelId: CH, kind: 0, targetId: toHex(MOD), allow: 0, deny: 0 });
    expect(w.core.authoritySet).toHaveBeenCalledTimes(1);
  });

  it('never sends a view for a DM group', async () => {
    const dm: GroupInfo = { ...textGroup(2), groupId: DM_GROUP, communityId: null, targetId: DM_CHANNEL };
    const w = world();
    w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW), role(MOD, 1, PIN | ALL)]);
    w.state.dms = [{ channelId: DM_CHANNEL, kind: 3, members: [USER, STRANGER] }];
    w.state.groups = [dm, textGroup(2)];
    await toReady(w);
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalled());
    w.sync.deps!.onGroupChanged(DM_GROUP, applied(2));
    await run(w, { m: 'selectCommunity', communityId: CID });
    expect(pushes(w).map(([g]) => g)).toEqual([G]);
  });

  it('sends nothing while the member list is not loaded, nor while the overwrites are not', async () => {
    const w = world();
    w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW), role(MOD, 1, PIN | ALL)]);
    w.routes.listMembers.mockRejectedValue(new Error('offline'));
    await toReady(w);
    // A channel this device created is known though no member list has loaded; the core holds its group.
    const created = await run(w, { m: 'createChannel', communityId: CID, kind: 'text', name: 'new' }) as { value: { channelId: string } };
    const NEW_GROUP = id16(0xc9);
    const newGroup: GroupInfo = { ...textGroup(2), groupId: NEW_GROUP, targetId: fromHex(created.value.channelId) };
    w.state.groups = [textGroup(2), newGroup];
    await run(w, { m: 'grantRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    expect(w.last<CommunityAccess>(`permissions:${CID}`)).toMatchObject({ loaded: true, overwritesLoaded: true });
    expect(w.core.authoritySet).not.toHaveBeenCalled();
    // The overwrites cannot be read any more, then the members load: still nothing.
    w.routes.listOverwrites.mockRejectedValue(new Error('offline'));
    await run(w, { m: 'setOverwrite', channelId: created.value.channelId, kind: 0, targetId: toHex(MOD), allow: PIN, deny: 0 });
    expect(w.last<CommunityAccess>(`permissions:${CID}`)?.overwritesLoaded).toBe(false);
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [MOD])]);
    await run(w, { m: 'selectCommunity', communityId: CID });
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)?.overwritesLoaded).toBe(false));
    expect(w.core.authoritySet).not.toHaveBeenCalled();
    w.routes.listOverwrites.mockResolvedValue([]);
    await run(w, { m: 'selectCommunity', communityId: CID });
    await vi.waitFor(() => expect(pushes(w)).toEqual([[G, BOTH, BOTH], [toHex(NEW_GROUP), BOTH, BOTH]]));
  });

  it('republishes the open pins view, the open timeline and the badges after a change', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    w.state.rows = [strangerRow(1)];
    await run(w, { m: 'openChannel', channelId: CH });
    await run(w, { m: 'loadPins', channelId: CH });
    expect(w.last<PinnedItem[]>(`pins:${CH}`)).toEqual([]);
    // What the core folds after the new view: the pin of the member who may still pin.
    // (Slices are posted only when they change: the core's refold changes the pins, the timeline row and the mentions.)
    const pin: PinRow = { targetSeq: 1n, msgId: id16(0x31), pinnedSeq: 2n, byUser: USER, author: STRANGER, excerpt: 'kept', targetTs: 1n };
    w.core.authoritySet.mockImplementation(() => {
      w.state.pins = [pin];
      w.state.rows = [{ ...strangerRow(1), pinned: true }];
      w.state.activity = [{ groupId: GROUP, unread: 1, mentions: 1, lastSeq: 1n, lastTs: 1n, lastReadSeq: 0n }];
    });
    const slices = (name: string): number => w.posted.filter((m) => m.t === 'slice' && m.name === name).length;
    const [timelines, badges] = [slices(`timeline:${CH}`), slices('badges')];
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [])]);
    await run(w, { m: 'revokeRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    expect(w.core.authoritySet).toHaveBeenCalledTimes(2);
    expect(w.last<PinnedItem[]>(`pins:${CH}`)?.map((p) => p.excerpt)).toEqual(['kept']);
    expect(slices(`timeline:${CH}`)).toBeGreaterThan(timelines);
    expect(slices('badges')).toBeGreaterThan(badges);
  });

  it('tries again at the next load when the core throws', async () => {
    const w = world();
    w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW), role(MOD, 1, PIN | ALL)]);
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [MOD])]);
    w.core.authoritySet.mockImplementation(() => { throw new Error('E_CORE_STORE'); });
    w.state.groups = [textGroup(2)];
    await toReady(w);
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalled());
    const failed = w.core.authoritySet.mock.calls.length;
    w.core.authoritySet.mockImplementation(() => {});
    await run(w, { m: 'selectCommunity', communityId: CID });
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(failed + 1));
    await run(w, { m: 'selectCommunity', communityId: CID });
    expect(w.core.authoritySet).toHaveBeenCalledTimes(failed + 1);
    expect(pushes(w).at(-1)).toEqual([G, BOTH, BOTH]);
  });

  it('sends the view once again after the core is attached again (a tab hand-back)', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await run(w, { m: 'selectCommunity', communityId: CID });
    expect(w.core.authoritySet).toHaveBeenCalledTimes(1);
    let release: () => void = () => {};
    const granted = new Promise<void>((resolve) => {
      void w.locks.request(LOCK, {}, () => { resolve(); return new Promise<void>((done) => { release = done; }); });
    });
    await run(w, { m: 'resign', nonce: 'aa'.repeat(16) });
    await granted;
    release();
    await vi.waitFor(() => expect(w.account()?.phase).toBe('ready'));
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(2));
    expect(pushes(w)[1]).toEqual([G, BOTH, BOTH]);
  });

  it('sends the view once again when the group comes back to active (not-member, resync, joining)', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    w.sync.deps!.onMembership(GROUP, 'not-member');
    expect(w.core.authoritySet).toHaveBeenCalledTimes(1);
    w.sync.deps!.onMembership(GROUP, 'member');
    expect(w.core.authoritySet).toHaveBeenCalledTimes(2);
    w.sync.deps!.onMembership(GROUP, 'resyncing');
    w.state.groups = [textGroup(3)];
    w.sync.deps!.onGroupChanged(GROUP, applied(3));
    w.state.groups = [textGroup(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.core.authoritySet).toHaveBeenCalledTimes(3);
    w.state.groups = [textGroup(1)];
    w.sync.deps!.onGroupChanged(GROUP, applied(1));
    w.state.groups = [textGroup(2)];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.core.authoritySet).toHaveBeenCalledTimes(4);
    // An apply that stays active sends nothing.
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    expect(w.core.authoritySet).toHaveBeenCalledTimes(4);
    expect(new Set(pushes(w).map((p) => JSON.stringify(p)))).toEqual(new Set([JSON.stringify([G, BOTH, BOTH])]));
  });

  it('forgets a dropped server: its groups are sent again when it is listed again', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    w.routes.listCommunities.mockResolvedValueOnce([]);
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)?.loaded).toBe(false));
    w.gateway.emit({ type: 'ready', info: READY_INFO });
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(2));
    expect(pushes(w)[1]).toEqual([G, BOTH, BOTH]);
  });
});

describe('the push is made once per change, cheaply (C4 fix round 1)', () => {
  const THIRD = new Uint8Array(16).fill(0x5e);

  it('one op 54 that changes a role and grants it sends each changed group exactly one view', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    // MOD loses mention-everyone, and a third member is given MOD, in one burst of op 54.
    w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW | PERM.sendMessages), role(MOD, 1, PIN)]);
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [MOD]), member(THIRD, [MOD])]);
    const changed: GatewayEvent = { type: 'frame', frame: { op: Op.communityChanged, n: 0n, groupId: null, payload: [COMMUNITY] } };
    w.gateway.emit(changed);
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    expect(pushes(w)).toEqual([[G, BOTH, BOTH], [G, [toHex(USER), toHex(STRANGER), toHex(THIRD)].sort(), [toHex(USER)]]]);
  });

  it('a member read that a later one overtook neither publishes nor pushes', async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    let release: () => void = () => {};
    w.routes.listMembers.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { resolve([member(USER, []), member(STRANGER, [MOD])]); };
    }));
    next += 1;
    const slow = next;
    w.call(slow, { m: 'grantRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    await vi.waitFor(() => expect(w.routes.listMembers.mock.calls.length).toBeGreaterThan(0));
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [])]);
    await run(w, { m: 'revokeRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    expect(pushes(w).at(-1)).toEqual([G, [toHex(USER)], [toHex(USER)]]);
    release();
    await vi.waitFor(() => expect(w.ret(slow)).toBeDefined());
    expect(w.last<{ userId: string; roleIds: string[] }[]>(`members:${CID}`)?.find((m) => m.userId === toHex(STRANGER))?.roleIds).toEqual([]);
    expect(w.core.authoritySet).toHaveBeenCalledTimes(2);
  });

  it('a push that throws never ends a member read owed after it', async () => {
    let clock = 1_700_000_000_000;
    // Every read of this clock is ten seconds on, so the owed read is never paced (MEMBER_REREAD_MIN_MS is 5 s).
    const w = await ready({ now: () => (clock += 10_000) });
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    await run(w, { m: 'openChannel', channelId: CH });
    vi.spyOn(w.controller as unknown as { pushAuthority: () => void }, 'pushAuthority').mockImplementation(() => { throw new Error('boom'); });
    const before = w.routes.listMembers.mock.calls.length;
    let release: () => void = () => {};
    w.routes.listMembers.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => { resolve([member(USER, []), member(STRANGER, [MOD])]); };
    }));
    w.state.rows = [{ ...strangerRow(1), senderUser: id16(0x71) }];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    await vi.waitFor(() => expect(w.routes.listMembers.mock.calls.length).toBe(before + 1));
    w.state.rows = [{ ...strangerRow(1), senderUser: id16(0x71) }, { ...strangerRow(2), senderUser: id16(0x72) }];
    w.sync.deps!.onGroupChanged(GROUP, applied(2));
    release();
    await vi.waitFor(() => expect(w.routes.listMembers.mock.calls.length).toBe(before + 2));
  });

  it("publishes a server's channels once for a push that changes two of its groups", async () => {
    const CH2 = id16(0x66);
    const G2 = id16(0x67);
    const w = world();
    w.routes.listRoles.mockResolvedValue([role(EVERYONE, 0, VIEW), role(MOD, 1, PIN | ALL)]);
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [MOD])]);
    w.state.newChannels.push({ communityId: COMMUNITY, row: { id: CH2, kind: 0, mode: 0, visibility: 0, parentId: null, name: 'two', topic: '',
      position: 1, seq: 0n, textGroupId: G2 } });
    w.state.groups = [textGroup(2), { ...textGroup(2), groupId: G2, targetId: CH2 }];
    await toReady(w);
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(2));
    const publish = vi.spyOn(w.controller as unknown as { publishChannels: (c: string) => void }, 'publishChannels');
    w.routes.listMembers.mockResolvedValue([member(USER, []), member(STRANGER, [])]);
    await run(w, { m: 'revokeRole', communityId: CID, userId: toHex(STRANGER), roleId: toHex(MOD) });
    expect(w.core.authoritySet).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a membership report's role-view step reads no group list of its own", async () => {
    const w = await ready();
    await vi.waitFor(() => expect(w.core.authoritySet).toHaveBeenCalledTimes(1));
    // The report's other steps are stubbed, so what is left is the role view's step, handed touchGroup's list.
    const parts = w.controller as unknown as { touchGroup: () => GroupInfo[]; stopTypingIfUnviewable: () => void };
    vi.spyOn(parts, 'touchGroup').mockImplementation(() => [textGroup(2)]);
    vi.spyOn(parts, 'stopTypingIfUnviewable').mockImplementation(() => {});
    const groups = vi.spyOn(w.core, 'groups');
    w.sync.deps!.onMembership(GROUP, 'not-member');
    expect(groups).not.toHaveBeenCalled();
  });
});
