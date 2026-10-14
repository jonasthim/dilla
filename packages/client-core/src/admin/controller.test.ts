// The admin and moderation commands (web3.4 C3) over the whole worker: the Controller with the routes doubled.
import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../hex';
import type { BanRow, InviteRow, RoleRow } from '../http/routes';
import type { BanSummary, ChannelSummary, CommunityAccess, InviteSummary, RoleSummary } from '../state/types';
import { CHANNEL, COMMUNITY, STRANGER, USER, refusal, world, type World } from '../worker/world';

const CID = toHex(COMMUNITY);
const STRANGER_HEX = toHex(STRANGER);
const toReady = async (w: World): Promise<void> => {
  w.call(1, { m: 'start' });
  await vi.waitFor(() => expect(w.account()?.phase).toBe('ready'));
};
let next = 5000;
/** Sends one command and returns its ret once it has answered. */
async function run(w: World, command: Record<string, unknown>): Promise<unknown> {
  next += 1;
  const id = next;
  w.call(id, command);
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}
/** Whether a slice that satisfies `pred` was posted before the answer of the last command (the double does not follow a
 *  patch, so the list read that comes after it is not what these tests look at). */
function shownBeforeRet<T>(w: World, name: string, pred: (v: T) => boolean): boolean {
  const ret = w.posted.findIndex((m) => m.t === 'ret' && m.id === next);
  return w.posted.slice(0, ret).some((m) => m.t === 'slice' && m.name === name && pred(m.value as T));
}
const id16 = (n: number): Uint8Array => new Uint8Array(16).fill(n);
const channelRow = (n: number, position: number, over: Partial<Awaited<ReturnType<World['routes']['listChannels']>>[number]> = {}) => ({
  id: id16(n), kind: 0, mode: 0, visibility: 0, parentId: null as Uint8Array | null, name: `c${String(n)}`, topic: '', position,
  seq: 1n, textGroupId: null as Uint8Array | null, ...over,
});

describe('AdminController: input checks', () => {
  const channelId = toHex(CHANNEL);
  const bad: [string, Record<string, unknown>][] = [
    ['blank server name', { m: 'renameCommunity', communityId: CID, name: '   ' }],
    ['too long server name', { m: 'renameCommunity', communityId: CID, name: 'x'.repeat(1000) }],
    ['blank category name', { m: 'createCategory', communityId: CID, name: '' }],
    ['too long category name', { m: 'createCategory', communityId: CID, name: 'x'.repeat(1000) }],
    ['blank channel name', { m: 'updateChannel', channelId, name: ' ', topic: null, parent: 'keep' }],
    ['too long channel name', { m: 'updateChannel', channelId, name: 'x'.repeat(1000), topic: null, parent: 'keep' }],
    ['too long topic', { m: 'updateChannel', channelId, name: null, topic: 'x'.repeat(1025), parent: 'keep' }],
    ['a parent that is not keep, top or an id', { m: 'updateChannel', channelId, name: null, topic: null, parent: 'bogus' }],
    ['an upper-case parent id', { m: 'updateChannel', channelId, name: null, topic: null, parent: 'A'.repeat(32) }],
    ['a direction that is not up or down', { m: 'moveChannel', channelId, direction: 'left' }],
    ['a ban shorter than an hour', { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: 3599 }],
    ['a ban longer than a century', { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: 3_153_600_001 }],
    ['a ban of a fraction of seconds', { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: 7200.5 }],
    ['a ban of NaN seconds', { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: Number.NaN }],
    ['a ban reason over 512 bytes', { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: 'é'.repeat(257), seconds: null }],
    ['a user id that is not hex', { m: 'kickMember', communityId: CID, userId: 'nope' }],
    ['an invite id that is not hex', { m: 'revokeInvite', communityId: CID, inviteId: 'nope' }],
  ];
  it.each(bad)('refuses %s with E_BAD_INPUT before anything is sent', async (_label, command) => {
    const w = world();
    await toReady(w);
    const before = w.routes.kickMember.mock.calls.length + w.routes.putBan.mock.calls.length + w.routes.patchChannel.mock.calls.length
      + w.routes.patchCommunity.mock.calls.length + w.routes.createCategory.mock.calls.length + w.routes.revokeInvite.mock.calls.length;
    expect(await run(w, command)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    const after = w.routes.kickMember.mock.calls.length + w.routes.putBan.mock.calls.length + w.routes.patchChannel.mock.calls.length
      + w.routes.patchCommunity.mock.calls.length + w.routes.createCategory.mock.calls.length + w.routes.revokeInvite.mock.calls.length;
    expect(after).toBe(before);
  });

  it('accepts a permanent ban, an hour, a century and a reason of exactly 512 bytes', async () => {
    const w = world();
    await toReady(w);
    for (const seconds of [null, 3600, 3_153_600_000]) {
      expect(await run(w, { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: 'x'.repeat(512), seconds })).toMatchObject({ ok: true });
    }
  });

  it('refuses an admin command before ready', async () => {
    const w = world();
    expect(await run(w, { m: 'kickMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({ ok: false, error: { code: 'E_NOT_READY' } });
  });
});

describe('AdminController: access', () => {
  it('publishes the permissions and roles of a server after its lists load', async () => {
    const w = world();
    w.routes.listRoles.mockResolvedValue([
      { id: id16(0x31), name: 'mods', color: 0xff0000, position: 5, allow: 0n, deny: 0n, hoist: true, mentionable: false },
    ] satisfies RoleRow[]);
    await toReady(w);
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)).toBeDefined());
    expect(w.last<CommunityAccess>(`permissions:${CID}`)).toEqual({
      top: 2 ** 31, owner: true, manageCommunity: true, manageChannels: true, kickMembers: true, banMembers: true, createInvite: true,
      manageRoles: true,
    });
    expect(w.last<RoleSummary[]>(`roles:${CID}`)).toEqual([
      { id: toHex(id16(0x31)), name: 'mods', color: 0xff0000, position: 5, hoist: true, mentionable: false },
    ]);
  });

  it('reads a non-owner from the resolved bits and rank', async () => {
    const w = world();
    w.routes.listCommunities.mockResolvedValue([{ id: COMMUNITY, name: 'friends', owner: STRANGER, policyVersion: 1n }]);
    w.routes.getPermissions.mockResolvedValue({ bits: (1n << 12n) | 1n, top: 7 });
    await toReady(w);
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)).toBeDefined());
    expect(w.last<CommunityAccess>(`permissions:${CID}`)).toMatchObject({ top: 7, owner: false, kickMembers: true, banMembers: false });
  });

  it('a rejected permissions read leaves the slices absent and selectCommunity still resolves', async () => {
    const w = world();
    w.routes.getPermissions.mockRejectedValue(refusal(500, 'E_INTERNAL'));
    await toReady(w);
    expect(await run(w, { m: 'selectCommunity', communityId: CID })).toMatchObject({ ok: true, value: null });
    await vi.waitFor(() => expect(w.routes.getPermissions).toHaveBeenCalled());
    expect(w.last<CommunityAccess>(`permissions:${CID}`)).toBeUndefined();
    expect(w.last<RoleSummary[]>(`roles:${CID}`)).toBeUndefined();
  });

  it('does not wait for the access read: select answers while it is still pending', async () => {
    const w = world();
    await toReady(w);
    w.routes.getPermissions.mockImplementation(() => new Promise(() => {}));
    expect(await run(w, { m: 'selectCommunity', communityId: CID })).toMatchObject({ ok: true });
  });

  it('does not push the access reads into the ordered call log of the older suites', async () => {
    const w = world();
    await toReady(w);
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)).toBeDefined());
    expect(w.calls.filter((c) => /ermission|oles/.test(c))).toEqual([]);
  });
});

describe('AdminController: moderation', () => {
  it('kick sends the kick, then reads the members and the permissions again', async () => {
    const w = world();
    await toReady(w);
    await vi.waitFor(() => expect(w.routes.getPermissions).toHaveBeenCalled());
    const members = w.routes.listMembers.mock.calls.length;
    const perms = w.routes.getPermissions.mock.calls.length;
    expect(await run(w, { m: 'kickMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({ ok: true, value: null });
    expect(w.routes.kickMember).toHaveBeenCalledWith(COMMUNITY, STRANGER);
    expect(w.routes.listMembers.mock.calls.length).toBe(members + 1);
    expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1);
    const kick = w.routes.kickMember.mock.invocationCallOrder[0];
    expect(w.routes.listMembers.mock.invocationCallOrder.at(-1)).toBeGreaterThan(kick);
    expect(w.routes.getPermissions.mock.invocationCallOrder.at(-1)).toBeGreaterThan(kick);
  });

  it('a 403 on kick reads the permissions again and the page still gets the refusal', async () => {
    const w = world();
    await toReady(w);
    await vi.waitFor(() => expect(w.routes.getPermissions).toHaveBeenCalled());
    const perms = w.routes.getPermissions.mock.calls.length;
    w.routes.kickMember.mockRejectedValueOnce(refusal(403, 'E_FORBIDDEN'));
    expect(await run(w, { m: 'kickMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({
      ok: false, error: { code: 'E_FORBIDDEN', status: 403 },
    });
    await vi.waitFor(() => expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1));
  });

  it('a 404 on kick (a retried first attempt that went through) surfaces and still reads the members', async () => {
    const w = world();
    await toReady(w);
    const members = w.routes.listMembers.mock.calls.length;
    w.routes.kickMember.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    expect(await run(w, { m: 'kickMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({
      ok: false, error: { code: 'E_NOT_FOUND', status: 404 },
    });
    await vi.waitFor(() => expect(w.routes.listMembers.mock.calls.length).toBe(members + 1));
  });

  it('a ban of 86400 seconds expires floor(now/1000)+86400; a permanent one sends null', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: 'spam', seconds: 86_400 })).toMatchObject({ ok: true });
    expect(w.routes.putBan).toHaveBeenLastCalledWith(COMMUNITY, STRANGER, { reason: 'spam', expires: 1_700_000_000n + 86_400n });
    expect(await run(w, { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: null })).toMatchObject({ ok: true });
    expect(w.routes.putBan).toHaveBeenLastCalledWith(COMMUNITY, STRANGER, { reason: '', expires: null });
  });

  it('a ban reads the members and the permissions again', async () => {
    const w = world();
    await toReady(w);
    const members = w.routes.listMembers.mock.calls.length;
    const perms = w.routes.getPermissions.mock.calls.length;
    await run(w, { m: 'banMember', communityId: CID, userId: STRANGER_HEX, reason: '', seconds: null });
    expect(w.routes.listMembers.mock.calls.length).toBe(members + 1);
    expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1);
  });

  it('unban treats a 404 as done and reads the bans again', async () => {
    const w = world();
    await toReady(w);
    w.routes.deleteBan.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    const bans = w.routes.listBans.mock.calls.length;
    expect(await run(w, { m: 'unbanMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({ ok: true, value: null });
    expect(w.routes.deleteBan).toHaveBeenCalledWith(COMMUNITY, STRANGER);
    expect(w.routes.listBans.mock.calls.length).toBe(bans + 1);
  });

  it('unban lets any other refusal through', async () => {
    const w = world();
    await toReady(w);
    w.routes.deleteBan.mockRejectedValueOnce(refusal(403, 'E_FORBIDDEN'));
    expect(await run(w, { m: 'unbanMember', communityId: CID, userId: STRANGER_HEX })).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
  });

  it('revokeInvite treats a 404 as done and reads the invites again', async () => {
    const w = world();
    await toReady(w);
    w.routes.revokeInvite.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    const invites = w.routes.listInvites.mock.calls.length;
    const inviteId = toHex(id16(0x71));
    expect(await run(w, { m: 'revokeInvite', communityId: CID, inviteId })).toMatchObject({ ok: true, value: null });
    expect(w.routes.revokeInvite).toHaveBeenCalledWith(id16(0x71));
    expect(w.routes.listInvites.mock.calls.length).toBe(invites + 1);
  });

  it('transferOwnership reads the members and the permissions again', async () => {
    const w = world();
    await toReady(w);
    const members = w.routes.listMembers.mock.calls.length;
    const perms = w.routes.getPermissions.mock.calls.length;
    expect(await run(w, { m: 'transferOwnership', communityId: CID, userId: STRANGER_HEX })).toMatchObject({ ok: true, value: null });
    expect(w.routes.transferOwnership).toHaveBeenCalledWith(COMMUNITY, STRANGER);
    expect(w.routes.listMembers.mock.calls.length).toBe(members + 1);
    expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1);
  });

  it('loadBans publishes each ban with the display name, else the username, else empty', async () => {
    const w = world();
    await toReady(w);
    w.routes.listBans.mockResolvedValue([
      { userId: id16(1), reason: 'spam', byUser: USER, created: 1_699_000_000n, expires: 1_701_000_000n, username: 'one', display: 'One' },
      { userId: id16(2), reason: '', byUser: USER, created: 1_699_000_001n, expires: null, username: 'two', display: '' },
      { userId: id16(3), reason: '', byUser: USER, created: 1_699_000_002n, expires: null, username: '', display: '' },
    ] satisfies BanRow[]);
    expect(await run(w, { m: 'loadBans', communityId: CID })).toMatchObject({ ok: true, value: null });
    expect(w.last<BanSummary[]>(`bans:${CID}`)).toEqual([
      { userId: toHex(id16(1)), name: 'One', reason: 'spam', byUser: toHex(USER), created: 1_699_000_000, expires: 1_701_000_000 },
      { userId: toHex(id16(2)), name: 'two', reason: '', byUser: toHex(USER), created: 1_699_000_001, expires: null },
      { userId: toHex(id16(3)), name: '', reason: '', byUser: toHex(USER), created: 1_699_000_002, expires: null },
    ]);
  });

  it('loadInvites keeps only invites that are not revoked, not expired and not used up', async () => {
    const w = world();
    await toReady(w);
    const now = 1_700_000_000n;
    const row = (n: number, over: Partial<InviteRow>): InviteRow => ({
      id: id16(n), communityId: COMMUNITY, createdBy: USER, maxUses: 5, uses: 1, created: now - 100n, expires: now + 100n, revokedAt: null, ...over,
    });
    w.routes.listInvites.mockResolvedValue([
      row(1, {}), row(2, { revokedAt: now - 5n }), row(3, { expires: now }), row(4, { expires: now - 1n }),
      row(5, { uses: 5 }), row(6, { uses: 6 }), row(7, { uses: 4 }),
    ]);
    expect(await run(w, { m: 'loadInvites', communityId: CID })).toMatchObject({ ok: true, value: null });
    expect(w.last<InviteSummary[]>(`invites:${CID}`)?.map((i) => i.id)).toEqual([toHex(id16(1)), toHex(id16(7))]);
    expect(w.last<InviteSummary[]>(`invites:${CID}`)?.[0]).toEqual({
      id: toHex(id16(1)), createdBy: toHex(USER), maxUses: 5, uses: 1, created: 1_699_999_900, expires: 1_700_000_100,
    });
  });
});

describe('AdminController: server and channel edits', () => {
  it('renameCommunity patches the name and the list shows it before the answer', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'renameCommunity', communityId: CID, name: 'valhalla' })).toMatchObject({ ok: true, value: null });
    expect(w.routes.patchCommunity).toHaveBeenCalledWith(COMMUNITY, { name: 'valhalla' });
    expect(shownBeforeRet<{ id: string; name: string }[]>(w, 'communities', (l) => l.find((c) => c.id === CID)?.name === 'valhalla')).toBe(true);
  });

  it('deleteCommunity drops the server before it answers and leaves no removal notice', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'deleteCommunity', communityId: CID })).toMatchObject({ ok: true, value: null });
    expect(w.routes.deleteCommunity).toHaveBeenCalledWith(COMMUNITY);
    const ret = w.posted.findIndex((m) => m.t === 'ret' && m.id === next);
    const dropped = w.posted.findIndex((m) => m.t === 'slice' && m.name === 'communities' && !(m.value as { id: string }[]).some((c) => c.id === CID));
    expect(dropped).toBeGreaterThan(-1);
    expect(dropped).toBeLessThan(ret);
    const emptied = w.posted.findIndex((m) => m.t === 'slice' && m.name === `channels:${CID}` && (m.value as unknown[]).length === 0);
    expect(emptied).toBeGreaterThan(-1);
    expect(emptied).toBeLessThan(ret);
    expect(w.posted.some((m) => m.t === 'slice' && m.name === 'removals' && (m.value as unknown[]).length > 0)).toBe(false);
  });

  it('leaveCommunity drops the server the same way', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'leaveCommunity', communityId: CID })).toMatchObject({ ok: true, value: null });
    expect(w.routes.leaveCommunity).toHaveBeenCalledWith(COMMUNITY);
    expect(w.last<{ id: string }[]>('communities')?.some((c) => c.id === CID)).toBe(false);
    expect(w.last<unknown[]>(`members:${CID}`)).toEqual([]);
    expect(w.posted.some((m) => m.t === 'slice' && m.name === 'removals' && (m.value as unknown[]).length > 0)).toBe(false);
  });

  it('dropping a server clears its permissions, roles, bans and invites', async () => {
    const w = world();
    await toReady(w);
    await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)).toBeDefined());
    await run(w, { m: 'loadBans', communityId: CID });
    await run(w, { m: 'loadInvites', communityId: CID });
    await run(w, { m: 'leaveCommunity', communityId: CID });
    expect(w.last<unknown[]>(`bans:${CID}`)).toEqual([]);
    expect(w.last<unknown[]>(`invites:${CID}`)).toEqual([]);
    expect(w.last<unknown[]>(`roles:${CID}`)).toEqual([]);
    expect(w.last<CommunityAccess>(`permissions:${CID}`)).toEqual({
      top: 0, owner: false, manageCommunity: false, manageChannels: false, kickMembers: false, banMembers: false, createInvite: false,
      manageRoles: false,
    });
  });

  it('moveChannel up on the last of three swaps positions with its neighbour and patches only those two', async () => {
    const w = world();
    w.routes.listChannels.mockResolvedValue([channelRow(0xa1, 0), channelRow(0xb1, 1), channelRow(0xc1, 2)]);
    await toReady(w);
    expect(await run(w, { m: 'moveChannel', channelId: toHex(id16(0xc1)), direction: 'up' })).toMatchObject({ ok: true, value: null });
    expect(w.routes.patchChannel.mock.calls).toEqual([[id16(0xc1), { position: 1 }], [id16(0xb1), { position: 2 }]]);
    expect(shownBeforeRet<ChannelSummary[]>(w, `channels:${CID}`,
      (l) => JSON.stringify(l.map((c) => [c.id.slice(0, 2), c.position])) === JSON.stringify([['a1', 0], ['b1', 2], ['c1', 1]]))).toBe(true);
  });

  it('moveChannel down swaps with the next one', async () => {
    const w = world();
    w.routes.listChannels.mockResolvedValue([channelRow(0xa1, 0), channelRow(0xb1, 1), channelRow(0xc1, 2)]);
    await toReady(w);
    await run(w, { m: 'moveChannel', channelId: toHex(id16(0xa1)), direction: 'down' });
    expect(w.routes.patchChannel.mock.calls).toEqual([[id16(0xa1), { position: 1 }], [id16(0xb1), { position: 0 }]]);
  });

  it('moveChannel up on the first channel, and down on the last, send nothing', async () => {
    const w = world();
    w.routes.listChannels.mockResolvedValue([channelRow(0xa1, 0), channelRow(0xb1, 1), channelRow(0xc1, 2)]);
    await toReady(w);
    expect(await run(w, { m: 'moveChannel', channelId: toHex(id16(0xa1)), direction: 'up' })).toMatchObject({ ok: true, value: null });
    expect(await run(w, { m: 'moveChannel', channelId: toHex(id16(0xc1)), direction: 'down' })).toMatchObject({ ok: true, value: null });
    expect(w.routes.patchChannel).not.toHaveBeenCalled();
  });

  it('moveChannel stays inside the channel\'s own category', async () => {
    const w = world();
    const cat = id16(0xd1);
    w.routes.listChannels.mockResolvedValue([
      channelRow(0xa1, 0), channelRow(0xd1, 1, { kind: 2 }), channelRow(0xb1, 2, { parentId: cat }), channelRow(0xc1, 3, { parentId: cat }),
    ]);
    await toReady(w);
    await run(w, { m: 'moveChannel', channelId: toHex(id16(0xb1)), direction: 'up' });
    expect(w.routes.patchChannel).not.toHaveBeenCalled();
    await run(w, { m: 'moveChannel', channelId: toHex(id16(0xc1)), direction: 'up' });
    expect(w.routes.patchChannel.mock.calls).toEqual([[id16(0xc1), { position: 2 }], [id16(0xb1), { position: 3 }]]);
  });

  it('moveChannel refuses a channel it does not know', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'moveChannel', channelId: toHex(id16(0x99)), direction: 'up' })).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
  });

  it('updateChannel sends only what changed: the name, the topic and a parent of keep, top or an id', async () => {
    const w = world();
    await toReady(w);
    const channelId = toHex(CHANNEL);
    await run(w, { m: 'updateChannel', channelId, name: 'lobby', topic: null, parent: 'keep' });
    expect(w.routes.patchChannel).toHaveBeenLastCalledWith(CHANNEL, { name: 'lobby' });
    await run(w, { m: 'updateChannel', channelId, name: null, topic: '', parent: 'top' });
    expect(w.routes.patchChannel).toHaveBeenLastCalledWith(CHANNEL, { topic: '', parent: 'top' });
    await run(w, { m: 'updateChannel', channelId, name: null, topic: 'hello', parent: toHex(id16(0xd1)) });
    expect(w.routes.patchChannel).toHaveBeenLastCalledWith(CHANNEL, { topic: 'hello', parent: id16(0xd1) });
  });

  it('updateChannel shows the new name at once', async () => {
    const w = world();
    await toReady(w);
    await run(w, { m: 'updateChannel', channelId: toHex(CHANNEL), name: 'lobby', topic: 'hi', parent: 'keep' });
    expect(shownBeforeRet<ChannelSummary[]>(w, `channels:${CID}`,
      (l) => l.some((c) => c.id === toHex(CHANNEL) && c.name === 'lobby' && c.topic === 'hi'))).toBe(true);
  });

  it('deleteChannel deletes it and drops it from the list before it answers', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'deleteChannel', channelId: toHex(CHANNEL) })).toMatchObject({ ok: true, value: null });
    expect(w.routes.deleteChannel).toHaveBeenCalledWith(CHANNEL);
    expect(shownBeforeRet<ChannelSummary[]>(w, `channels:${CID}`, (l) => !l.some((c) => c.id === toHex(CHANNEL)))).toBe(true);
  });

  it('createCategory answers the new id and lists it after the last channel', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'createCategory', communityId: CID, name: 'voice' })).toEqual({
      t: 'ret', id: next, ok: true, value: { channelId: toHex(id16(0x90)) },
    });
    expect(w.routes.createCategory).toHaveBeenCalledWith(COMMUNITY, { name: 'voice', position: 1 });
    expect(shownBeforeRet<ChannelSummary[]>(w, `channels:${CID}`,
      (l) => l.some((c) => c.id === toHex(id16(0x90)) && c.kind === 2 && c.name === 'voice' && c.position === 1))).toBe(true);
  });

  it('a 403 on a channel edit reads the permissions of its server again', async () => {
    const w = world();
    await toReady(w);
    await vi.waitFor(() => expect(w.routes.getPermissions).toHaveBeenCalled());
    const perms = w.routes.getPermissions.mock.calls.length;
    w.routes.deleteChannel.mockRejectedValueOnce(refusal(403, 'E_FORBIDDEN'));
    expect(await run(w, { m: 'deleteChannel', channelId: toHex(CHANNEL) })).toMatchObject({ ok: false, error: { code: 'E_FORBIDDEN' } });
    await vi.waitFor(() => expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1));
  });
});
