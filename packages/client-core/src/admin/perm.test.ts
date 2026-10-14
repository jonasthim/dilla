import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERM_ALL } from '../http/routes';
import {
  COMMUNITY_BITS, PERM, PERM_BY_KEY, PERM_GROUPS, channelBitsOf, isPrivate, resolveChannel, resolveCommunity,
  type PermKey, type PermOverwrite,
} from './perm';

interface Vector {
  name: string; owner: string; everyone: string; user: string; community: number; channel: number;
  roles: { id: string; position: number; allow: number; deny: number }[]; held: string[];
  overwrites: { kind: 0 | 1; target: string; allow: number; deny: number }[];
}
const file = JSON.parse(readFileSync(new URL('../../../../protocol/vectors/permissions.json', import.meta.url), 'utf8')) as
  { bits: Record<string, number>; cases: Vector[] };

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const NAMES: Record<string, string> = { manage_community: 'manageCommunity', screen_share: 'screenShare' };

describe('PERM', () => {
  it('pins all 24 values of internal/api/perm.go', () => {
    expect(PERM).toEqual({
      viewChannel: 1, sendMessages: 2, manageMessages: 4, pinMessages: 8, attachFiles: 16, addReactions: 32, readHistory: 64,
      connect: 128, speak: 256, video: 512, screenShare: 1024, createInvite: 2048, kickMembers: 4096, banMembers: 8192,
      manageChannels: 16384, manageRoles: 32768, manageCommunity: 65536, viewAuditLog: 131072, mentionEveryone: 262144,
      bypassSlowmode: 524288, administrator: 1048576, muteMembers: 2097152, moveMembers: 4194304, manageNicknames: 8388608,
    });
  });
  it('equals the bits map of the vector file', () => {
    const fromFile = Object.fromEntries(Object.entries(file.bits).map(([k, v]) => [NAMES[k] ?? camel(k), v]));
    expect(fromFile).toEqual(PERM);
  });
  it('COMMUNITY_BITS is the seven community-scoped bits', () => {
    expect(COMMUNITY_BITS).toBe(4096 | 8192 | 65536 | 32768 | 131072 | 1048576 | 8388608);
  });
  it('PERM_GROUPS covers all 24 keys exactly once, and PERM_BY_KEY holds 24 distinct bits', () => {
    const keys = PERM_GROUPS.flatMap((g) => g.keys);
    expect(keys).toHaveLength(24);
    expect(new Set(keys)).toEqual(new Set(Object.keys(PERM_BY_KEY) as PermKey[]));
    expect(new Set(Object.values(PERM_BY_KEY)).size).toBe(24);
    expect(Object.values(PERM_BY_KEY).reduce((a, b) => a | b, 0)).toBe(PERM_ALL);
  });
});

describe('the resolver against protocol/vectors/permissions.json', () => {
  it('has cases', () => {
    expect(file.cases.length).toBeGreaterThan(0);
  });
  for (const c of file.cases) {
    const input = { owner: c.owner, everyoneId: c.everyone, held: c.held,
      roles: c.roles.map((r) => ({ id: r.id, position: r.position, allow: r.allow, deny: r.deny })) };
    const overwrites: PermOverwrite[] = c.overwrites.map((o) => ({ kind: o.kind, targetId: o.target, allow: o.allow, deny: o.deny }));
    it(`${c.name}: community`, () => {
      expect(resolveCommunity(input, c.user)).toBe(c.community);
    });
    it(`${c.name}: channel`, () => {
      expect(resolveChannel(input, overwrites, c.user)).toBe(c.channel);
    });
  }
});

describe('channelBitsOf', () => {
  const s = { owner: 'aa', everyoneId: 'ee', roles: [{ id: 'ee', position: 0, allow: 3, deny: 0 }], members: [{ userId: 'bb', roleIds: [] }],
    overwrites: [] as PermOverwrite[] };
  it('is null for a non-member and everything for the owner', () => {
    expect(channelBitsOf(s, 'cc')).toBeNull();
    expect(channelBitsOf(s, 'aa')).toBe(PERM_ALL);
  });
  it('resolves a member through the overwrites', () => {
    expect(channelBitsOf(s, 'bb')).toBe(3);
    expect(channelBitsOf({ ...s, overwrites: [{ kind: 0, targetId: 'ee', allow: 0, deny: 1 }] }, 'bb')).toBe(0);
  });
});

describe('isPrivate', () => {
  it('is true for an @everyone deny of view only', () => {
    expect(isPrivate([{ kind: 0, targetId: 'ee', allow: 0, deny: PERM.viewChannel }], 'ee')).toBe(true);
    expect(isPrivate([{ kind: 0, targetId: 'ee', allow: 0, deny: PERM.sendMessages }], 'ee')).toBe(false);
    expect(isPrivate([{ kind: 0, targetId: 'rr', allow: 0, deny: PERM.viewChannel }], 'ee')).toBe(false);
    expect(isPrivate([{ kind: 1, targetId: 'ee', allow: 0, deny: PERM.viewChannel }], 'ee')).toBe(false);
  });
});
