// The roles, overwrite and private-channel commands (web3.5 C3) over the whole worker: the Controller with the routes doubled.
import { describe, expect, it, vi } from 'vitest';
import { toHex } from '../hex';
import type { OverwriteRow, RoleRow } from '../http/routes';
import type { CommunityAccess, OverwriteSummary, RoleSummary } from '../state/types';
import { CHANNEL, COMMUNITY, STRANGER, USER, refusal, toReady, world, type World } from '../worker/world';
import { PERM } from './perm';
import { ROLES_VALIDATORS, privateProblem, type RolesMethod } from './roles';

const CID = toHex(COMMUNITY);
const CH = toHex(CHANNEL);
const id16 = (n: number): Uint8Array => new Uint8Array(16).fill(n);
const EVERYONE = id16(0x40);
const A = id16(0x41);
const B = id16(0x42);
const HEX = { everyone: toHex(EVERYONE), a: toHex(A), b: toHex(B), user: toHex(USER), stranger: toHex(STRANGER) };
const row = (id: Uint8Array, position: number, allow = 0, deny = 0): RoleRow => ({ id, name: `r${String(position)}`, color: 0, position, allow, deny,
  hoist: false, mentionable: false });
let next = 7000;
async function run(w: World, command: Record<string, unknown>): Promise<unknown> {
  next += 1;
  const id = next;
  w.call(id, command);
  await vi.waitFor(() => expect(w.ret(id)).toBeDefined());
  return w.ret(id);
}
/** A ready world whose server has @everyone, a (1) and b (2); the caller owns it unless `owner` is false (then rank `top`). */
async function ready(opts: { owner?: boolean; top?: number; bits?: bigint; roles?: RoleRow[]; overwrites?: OverwriteRow[]; roleIds?: Uint8Array[] } = {}): Promise<World> {
  const w = world();
  w.routes.listRoles.mockResolvedValue(opts.roles ?? [row(EVERYONE, 0, 3), row(A, 1), row(B, 2)]);
  w.routes.listOverwrites.mockResolvedValue(opts.overwrites ?? []);
  if (opts.owner === false) {
    w.routes.listCommunities.mockResolvedValue([{ id: COMMUNITY, name: 'friends', owner: STRANGER, policyVersion: 1n }]);
    w.routes.getPermissions.mockResolvedValue({ bits: opts.bits ?? 0xffffn, top: opts.top ?? 5 });
  }
  w.state.roleIds = opts.roleIds ?? [];
  await toReady(w);
  await vi.waitFor(() => expect(w.last<CommunityAccess>(`permissions:${CID}`)?.everyoneId).toBe(HEX.everyone));
  return w;
}
const ow = (kind: 0 | 1, target: Uint8Array, allow: number, deny: number): OverwriteRow => ({ channelId: CHANNEL, kind, targetId: target, allow, deny });

describe('roles: input checks', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['a blank role name', { m: 'createRole', communityId: CID, name: '  ', color: 0, hoist: false, mentionable: false, allow: 0 }, 'role name is blank'],
    ['a role name over 100 bytes', { m: 'createRole', communityId: CID, name: 'é'.repeat(51), color: 0, hoist: false, mentionable: false, allow: 0 }, 'role name is longer than 100 bytes'],
    ['a colour over 16777215', { m: 'createRole', communityId: CID, name: 'x', color: 16777216, hoist: false, mentionable: false, allow: 0 }, 'color must be an integer 0..16777215'],
    ['a fractional colour', { m: 'createRole', communityId: CID, name: 'x', color: 1.5, hoist: false, mentionable: false, allow: 0 }, 'color must be an integer 0..16777215'],
    ['allow out of range', { m: 'createRole', communityId: CID, name: 'x', color: 0, hoist: false, mentionable: false, allow: -1 }, 'allow must be an integer 0..16777215'],
    ['an update that changes nothing', { m: 'updateRole', communityId: CID, roleId: HEX.a, name: null, color: null, hoist: null, mentionable: null, allow: null }, 'nothing to change'],
    ['an update with a blank name', { m: 'updateRole', communityId: CID, roleId: HEX.a, name: '', color: null, hoist: null, mentionable: null, allow: null }, 'role name is blank'],
    ['a direction that is not up or down', { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'left' }, 'direction must be up or down'],
    ['an overwrite kind of 2', { m: 'setOverwrite', channelId: CH, kind: 2, targetId: HEX.a, allow: 0, deny: 0 }, 'kind must be 0 or 1'],
    ['an overwrite deny out of range', { m: 'setOverwrite', channelId: CH, kind: 0, targetId: HEX.a, allow: 0, deny: 0x1000000 }, 'deny must be an integer 0..16777215'],
    ['an overwrite allow out of range', { m: 'setOverwrite', channelId: CH, kind: 0, targetId: HEX.a, allow: 0.5, deny: 0 }, 'allow must be an integer 0..16777215'],
    ['an overlapping allow and deny', { m: 'setOverwrite', channelId: CH, kind: 0, targetId: HEX.a, allow: 3, deny: 2 }, 'allow and deny overlap'],
    ['private roleIds that are not ids', { m: 'createChannel', communityId: CID, kind: 'text', name: 'x', private: { roleIds: ['nope'] } }, 'roleIds must be at most 100 ids'],
    ['more than 100 private roleIds', { m: 'createChannel', communityId: CID, kind: 'text', name: 'x', private: { roleIds: Array<string>(101).fill(HEX.a) } }, 'roleIds must be at most 100 ids'],
  ];
  it.each(bad)('refuses %s with E_BAD_INPUT and its reason', async (_label, command, reason) => {
    const w = world();
    await toReady(w);
    // The worker hides the reason from the page's ret, so the exact reason is read from the validator itself.
    const problem = command.m === 'createChannel' ? privateProblem(command.private) : ROLES_VALIDATORS[command.m as RolesMethod]?.(command);
    expect(problem).toBe(reason);
    expect(await run(w, command)).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.createRole).not.toHaveBeenCalled();
    expect(w.routes.patchRole).not.toHaveBeenCalled();
    expect(w.routes.putOverwrite).not.toHaveBeenCalled();
  });
  it('refuses a role id that is not hex', async () => {
    const w = world();
    await toReady(w);
    expect(await run(w, { m: 'deleteRole', communityId: CID, roleId: 'nope' })).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(await run(w, { m: 'setOverwrite', channelId: CH, kind: 0, targetId: 'nope', allow: 1, deny: 0 })).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
  });
});

describe('roles: access reads', () => {
  it('publishes the roles with bits and counts and the overwrites keyed by channel', async () => {
    const w = await ready({ roles: [row(EVERYONE, 0, 3, 4), row(A, 1, 8)], overwrites: [ow(0, EVERYONE, 0, 1), ow(1, USER, 1, 0)], roleIds: [A] });
    await vi.waitFor(() => expect(w.last<RoleSummary[]>(`roles:${CID}`)?.find((r) => r.id === HEX.a)?.members).toBe(1));
    expect(w.last<RoleSummary[]>(`roles:${CID}`)).toEqual([
      { id: HEX.everyone, name: 'r0', color: 0, position: 0, hoist: false, mentionable: false, allow: 3, deny: 4, members: 1 },
      { id: HEX.a, name: 'r1', color: 0, position: 1, hoist: false, mentionable: false, allow: 8, deny: 0, members: 1 },
    ]);
    expect(w.last<Record<string, OverwriteSummary[]>>(`overwrites:${CID}`)).toEqual({
      [CH]: [{ kind: 0, targetId: HEX.everyone, allow: 0, deny: 1 }, { kind: 1, targetId: HEX.user, allow: 1, deny: 0 }],
    });
  });
  it('republishes the counts when the member list changes', async () => {
    const w = await ready();
    expect(w.last<RoleSummary[]>(`roles:${CID}`)?.find((r) => r.id === HEX.a)?.members).toBe(0);
    w.state.roleIds = [A];
    await run(w, { m: 'kickMember', communityId: CID, userId: HEX.stranger });
    await vi.waitFor(() => expect(w.last<RoleSummary[]>(`roles:${CID}`)?.find((r) => r.id === HEX.a)?.members).toBe(1));
  });
  it('clears the overwrites when the server is dropped', async () => {
    const w = await ready({ overwrites: [ow(0, EVERYONE, 0, 1)] });
    await run(w, { m: 'leaveCommunity', communityId: CID });
    expect(w.last(`overwrites:${CID}`)).toEqual({});
  });
});

describe('roles: role commands', () => {
  it('createRole picks the lowest free position below my top', async () => {
    const w = await ready({ owner: false, top: 5, roles: [row(EVERYONE, 0), row(A, 1), row(B, 3)] });
    const r = await run(w, { m: 'createRole', communityId: CID, name: 'mods', color: 7, hoist: true, mentionable: false, allow: 3 });
    expect(r).toMatchObject({ ok: true, value: { roleId: toHex(id16(0x91)) } });
    expect(w.routes.createRole).toHaveBeenCalledWith(COMMUNITY, { name: 'mods', color: 7, position: 2, allow: 3, deny: 0, hoist: true, mentionable: false });
  });
  it('createRole with no room below my top is refused without a request', async () => {
    const w = await ready({ owner: false, top: 2, roles: [row(EVERYONE, 0), row(A, 1)] });
    const r = await run(w, { m: 'createRole', communityId: CID, name: 'mods', color: 0, hoist: false, mentionable: false, allow: 0 });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.createRole).not.toHaveBeenCalled();
  });
  it('updateRole sends only the changed fields', async () => {
    const w = await ready();
    await run(w, { m: 'updateRole', communityId: CID, roleId: HEX.a, name: 'new', color: null, hoist: true, mentionable: null, allow: 9 });
    expect(w.routes.patchRole).toHaveBeenCalledWith(A, { name: 'new', hoist: true, allow: 9 });
  });
  it('moveRole up on [a1, b2] patches a to 2, then b to 1', async () => {
    const w = await ready({ owner: false, top: 9 });
    expect(await run(w, { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'up' })).toMatchObject({ ok: true, value: null });
    expect(w.routes.patchRole.mock.calls).toEqual([[A, { position: 2 }], [B, { position: 1 }]]);
  });
  it('moveRole up past my top sends nothing', async () => {
    const w = await ready({ owner: false, top: 2 });
    expect(await run(w, { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'up' })).toMatchObject({ ok: true, value: null });
    expect(w.routes.patchRole).not.toHaveBeenCalled();
  });
  it('moveRole never trades with @everyone', async () => {
    const w = await ready();
    await run(w, { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'down' });
    expect(w.routes.patchRole).not.toHaveBeenCalled();
  });
  it('moveRole on equal positions steps only the mover past its neighbour', async () => {
    const w = await ready({ roles: [row(EVERYONE, 0), row(A, 2), row(B, 2)] });
    await run(w, { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'up' });
    expect(w.routes.patchRole.mock.calls).toEqual([[A, { position: 3 }]]);
  });
  it('moveRole reads the roles again and rethrows on a 409', async () => {
    const w = await ready({ owner: false, top: 9 });
    w.routes.patchRole.mockRejectedValueOnce(refusal(409, 'E_CONFLICT'));
    const reads = w.routes.listRoles.mock.calls.length;
    expect(await run(w, { m: 'moveRole', communityId: CID, roleId: HEX.a, direction: 'up' })).toMatchObject({ ok: false });
    expect(w.routes.listRoles.mock.calls.length).toBe(reads + 1);
  });
  it('deleteRole treats a 404 as done', async () => {
    const w = await ready();
    w.routes.deleteRole.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    expect(await run(w, { m: 'deleteRole', communityId: CID, roleId: HEX.a })).toMatchObject({ ok: true, value: null });
  });
  it('grantRole reads the members and the access before the ret', async () => {
    const w = await ready();
    const members = w.routes.listMembers.mock.calls.length;
    const perms = w.routes.getPermissions.mock.calls.length;
    await run(w, { m: 'grantRole', communityId: CID, userId: HEX.stranger, roleId: HEX.a });
    expect(w.routes.grantRole).toHaveBeenCalledWith(COMMUNITY, STRANGER, A);
    // Both reads were made by the time the ret was posted (the run resolves on the ret).
    expect(w.routes.listMembers.mock.calls.length).toBe(members + 1);
    expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1);
    const ret = w.posted.findIndex((m) => m.t === 'ret' && m.id === next);
    expect(w.posted.slice(ret + 1).filter((m) => m.t === 'slice' && m.name === `roles:${CID}`)).toEqual([]);
  });
  it('revokeRole treats a 404 as done', async () => {
    const w = await ready();
    w.routes.revokeRole.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    expect(await run(w, { m: 'revokeRole', communityId: CID, userId: HEX.stranger, roleId: HEX.a })).toMatchObject({ ok: true, value: null });
  });
});

describe('roles: overwrites and private channels', () => {
  it('setOverwrite puts the pair', async () => {
    const w = await ready();
    await run(w, { m: 'setOverwrite', channelId: CH, kind: 1, targetId: HEX.stranger, allow: 2, deny: 4 });
    expect(w.routes.putOverwrite).toHaveBeenCalledWith(CHANNEL, 1, STRANGER, { allow: 2, deny: 4 });
  });
  it('setOverwrite 0/0 sends DELETE, and a 404 resolves null', async () => {
    const w = await ready();
    w.routes.deleteOverwrite.mockRejectedValueOnce(refusal(404, 'E_NOT_FOUND'));
    expect(await run(w, { m: 'setOverwrite', channelId: CH, kind: 0, targetId: HEX.a, allow: 0, deny: 0 })).toMatchObject({ ok: true, value: null });
    expect(w.routes.deleteOverwrite).toHaveBeenCalledWith(CHANNEL, 0, A);
    expect(w.routes.putOverwrite).not.toHaveBeenCalled();
  });
  it('a 403 on setOverwrite reads the access again', async () => {
    const w = await ready();
    w.routes.putOverwrite.mockRejectedValueOnce(refusal(403, 'E_FORBIDDEN'));
    const perms = w.routes.getPermissions.mock.calls.length;
    const r = await run(w, { m: 'setOverwrite', channelId: CH, kind: 0, targetId: HEX.a, allow: 1, deny: 0 });
    expect(r).toMatchObject({ ok: false });
    expect(w.routes.getPermissions.mock.calls.length).toBe(perms + 1);
  });
  it('setChannelPrivate(true) keeps the other deny bits of @everyone', async () => {
    const w = await ready({ overwrites: [ow(0, EVERYONE, 0, 2)] });
    await run(w, { m: 'setChannelPrivate', channelId: CH, private: true });
    expect(w.routes.putOverwrite).toHaveBeenCalledWith(CHANNEL, 0, EVERYONE, { allow: 0, deny: 3 });
  });
  it('setChannelPrivate(true) as a non-owner with no allowing overwrite loses the channel: refused, no request', async () => {
    const w = await ready({ owner: false, top: 5, bits: 0xffn, overwrites: [ow(0, EVERYONE, 0, 2)] });
    const r = await run(w, { m: 'setChannelPrivate', channelId: CH, private: true });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_BAD_INPUT' } });
    expect(w.routes.putOverwrite).not.toHaveBeenCalled();
  });
  it('setChannelPrivate(true) as a non-owner holding a role the channel allows is let through', async () => {
    const w = await ready({ owner: false, top: 5, bits: 0xffn, roleIds: [A], overwrites: [ow(0, A, PERM.viewChannel, 0)] });
    await run(w, { m: 'setChannelPrivate', channelId: CH, private: true });
    expect(w.routes.putOverwrite).toHaveBeenCalledWith(CHANNEL, 0, EVERYONE, { allow: 0, deny: 1 });
  });
  it('setChannelPrivate(true) as an administrator is let through', async () => {
    const w = await ready({ owner: false, top: 5, bits: BigInt(PERM.administrator) });
    await run(w, { m: 'setChannelPrivate', channelId: CH, private: true });
    expect(w.routes.putOverwrite).toHaveBeenCalled();
  });
  it('setChannelPrivate(false) on deny 1 sends DELETE', async () => {
    const w = await ready({ overwrites: [ow(0, EVERYONE, 0, 1)] });
    await run(w, { m: 'setChannelPrivate', channelId: CH, private: false });
    expect(w.routes.deleteOverwrite).toHaveBeenCalledWith(CHANNEL, 0, EVERYONE);
  });
  it('setChannelPrivate(false) keeps the other bits, and sends nothing with no @everyone entry', async () => {
    const w = await ready({ overwrites: [ow(0, EVERYONE, 4, 3)] });
    await run(w, { m: 'setChannelPrivate', channelId: CH, private: false });
    expect(w.routes.putOverwrite).toHaveBeenCalledWith(CHANNEL, 0, EVERYONE, { allow: 4, deny: 2 });
    const none = await ready();
    await run(none, { m: 'setChannelPrivate', channelId: CH, private: false });
    expect(none.routes.putOverwrite).not.toHaveBeenCalled();
    expect(none.routes.deleteOverwrite).not.toHaveBeenCalled();
  });
  it('a private create by a non-owner adds her own entry; by the owner it does not', async () => {
    const m = await ready({ owner: false, top: 5, bits: 0xffn | BigInt(PERM.manageChannels) });
    await run(m, { m: 'createChannel', communityId: CID, kind: 'text', name: 'secret', private: { roleIds: [HEX.a] } });
    expect(m.routes.createChannel.mock.calls[0]?.[1].overwrites).toEqual([
      { kind: 0, targetId: EVERYONE, allow: 0, deny: PERM.viewChannel },
      { kind: 0, targetId: A, allow: PERM.viewChannel, deny: 0 },
      { kind: 1, targetId: USER, allow: PERM.viewChannel, deny: 0 },
    ]);
    const o = await ready();
    await run(o, { m: 'createChannel', communityId: CID, kind: 'text', name: 'secret', private: { roleIds: [] } });
    expect(o.routes.createChannel.mock.calls[0]?.[1].overwrites).toEqual([{ kind: 0, targetId: EVERYONE, allow: 0, deny: PERM.viewChannel }]);
  });
  it('a create without private sends no overwrites', async () => {
    const w = await ready();
    await run(w, { m: 'createChannel', communityId: CID, kind: 'text', name: 'open' });
    expect(w.routes.createChannel.mock.calls[0]?.[1].overwrites).toBeUndefined();
  });
});
