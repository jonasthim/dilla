import { describe, expect, it } from 'vitest';
import type { MemberSummary, RoleSummary } from '@dilla/client-core';
import { memberCardData } from './member-card.ts';

const EVERYONE: RoleSummary = { id: 'ab'.repeat(16), name: '@everyone', color: 0, position: 0, hoist: false, mentionable: false, allow: 0, deny: 0, members: 0 };
const MOD: RoleSummary = { id: 'cd'.repeat(16), name: 'mods', color: 0x3498db, position: 5, hoist: true, mentionable: false, allow: 0, deny: 0, members: 0 };
const member: MemberSummary = { userId: '01'.repeat(16), username: 'bob', display: '', kind: 0, roleIds: [EVERYONE.id, MOD.id] };

describe('memberCardData', () => {
  it('leaves @everyone out of the role chips by its position, before the permissions have loaded', () => {
    const ctx = { selfId: 'x', ownerId: 'y', roles: [EVERYONE, MOD], access: undefined };
    expect(memberCardData(member, ctx).roles).toEqual([{ name: 'mods', color: 0x3498db }]);
  });

  it('carries the status message and the bio, and leaves them empty when the member has none', () => {
    const ctx = { selfId: 'x', ownerId: 'y', roles: [EVERYONE], access: undefined };
    expect(memberCardData({ ...member, statusMsg: 'on a call', bio: 'one\ntwo' }, ctx)).toMatchObject({ status: 'on a call', bio: 'one\ntwo' });
    expect(memberCardData(member, ctx)).toMatchObject({ status: '', bio: '' });
  });
});
