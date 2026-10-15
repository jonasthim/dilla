import { describe, expect, it } from 'vitest';
import type { CommunityAccess, MemberSummary, RoleSummary } from '@dilla/client-core';
import { memberGroups, menuFor } from './members-model.ts';

const id = (n: number) => n.toString(16).padStart(2, '0').repeat(16);
const OWNER = id(1), ME = id(2), BOB = id(3), CAL = id(4), BOT = id(5);
const MOD: RoleSummary = { id: id(10), name: 'mods', color: 0, position: 5, hoist: true, mentionable: false, allow: 0, deny: 0, members: 0 };
const CREW: RoleSummary = { id: id(11), name: 'crew', color: 0, position: 2, hoist: true, mentionable: false, allow: 0, deny: 0, members: 0 };
const QUIET: RoleSummary = { id: id(12), name: 'quiet', color: 0, position: 9, hoist: false, mentionable: false, allow: 0, deny: 0, members: 0 };
const ROLES = [CREW, MOD, QUIET];
const m = (userId: string, username: string, roleIds: string[] = [], kind: 0 | 1 = 0, display = ''): MemberSummary => ({ userId, username, display, kind, roleIds });
const MEMBERS = [m(OWNER, 'olof'), m(ME, 'ada', [CREW.id]), m(BOB, 'bob', [CREW.id, MOD.id]), m(CAL, 'carol', [QUIET.id], 0, 'Åsa'), m(BOT, 'robo', [], 1)];
const EVERYONE = 'ab'.repeat(16);
const access = (over: Partial<CommunityAccess> = {}): CommunityAccess => ({ top: 5, owner: false, manageCommunity: false, manageChannels: false,
  kickMembers: true, banMembers: true, createInvite: false, manageRoles: false, loaded: true, overwritesLoaded: true, everyoneId: EVERYONE, ...over });

describe('memberGroups', () => {
  it('groups by the highest hoisted role, highest first, and the rest last; an unhoisted role does not group', () => {
    const groups = memberGroups(MEMBERS, ROLES, OWNER, ME);
    expect(groups.map(g => [g.id, g.members.map(r => r.userId)])).toEqual([[MOD.id, [BOB]], [CREW.id, [ME]], ['members', [CAL, OWNER, BOT]]]);
  });
  it('sorts names with localeCompare', () => {
    const rest = memberGroups(MEMBERS, ROLES, OWNER, ME).at(-1)!;
    expect(rest.members.map(r => r.name)).toEqual(['Åsa', 'olof', 'robo']);
  });
  it('tags the owner, you and bots', () => {
    const tags = Object.fromEntries(memberGroups(MEMBERS, ROLES, OWNER, ME).flatMap(g => g.members).map(r => [r.userId, r.tags]));
    expect(tags[OWNER]).toEqual(['owner']);
    expect(tags[ME]).toEqual(['you']);
    expect(tags[BOT]).toEqual(['bot']);
    expect(tags[BOB]).toEqual([]);
  });
});

describe('menuFor', () => {
  const ctx = { selfId: ME, ownerId: OWNER, roles: ROLES };
  const bob = MEMBERS[2];
  it('offers message, compare, kick and ban on a lower-ranked member', () => {
    expect(menuFor(m(CAL, 'carol', [CREW.id]), access(), ctx)).toEqual(['message', 'compare', 'kick', 'ban']);
  });
  it('has no message on self, and no kick or ban', () => {
    expect(menuFor(MEMBERS[1], access(), ctx)).toEqual(['compare']);
  });
  it('hides kick and ban on the owner and on a higher-ranked target', () => {
    expect(menuFor(MEMBERS[0], access(), ctx)).toEqual(['message', 'compare']);
    expect(menuFor(bob, access({ top: 2 }), ctx)).toEqual(['message', 'compare']);
    expect(menuFor(bob, access({ top: 5 }), ctx)).toEqual(['message', 'compare']);
  });
  it('follows each permission, and shows neither before permissions load', () => {
    const lower = m(CAL, 'carol');
    expect(menuFor(lower, access({ banMembers: false }), ctx)).toEqual(['message', 'compare', 'kick']);
    expect(menuFor(lower, access({ kickMembers: false }), ctx)).toEqual(['message', 'compare', 'ban']);
    expect(menuFor(lower, access({ loaded: false }), ctx)).toEqual(['message', 'compare']);
    expect(menuFor(lower, undefined, ctx)).toEqual(['message', 'compare']);
  });
});
