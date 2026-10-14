// Flow 08: the member list's pure rules. Grouping, tags and the per-member menu are decided here so the pane stays plain.
import { canModerate, topOf, type CommunityAccess, type MemberSummary, type RoleSummary } from '@dilla/client-core';

export type MemberTag = 'owner' | 'you' | 'bot';
export interface MemberRow { userId: string; name: string; tags: MemberTag[] }
/** `role` is null for the group of everyone who holds no hoisted role. */
export interface MemberGroup { id: string; role: RoleSummary | null; members: MemberRow[] }

export const memberName = (m: MemberSummary): string => (m.display !== '' ? m.display : m.username);

/**
 * Groups by each member's highest hoisted role (position, highest first); everyone else goes in the last, role-less
 * group. Names sort with localeCompare. Each row is tagged owner, you or bot.
 */
export function memberGroups(members: readonly MemberSummary[], roles: readonly RoleSummary[], ownerId: string, selfId: string): MemberGroup[] {
  const hoisted = roles.filter(r => r.hoist).sort((a, b) => b.position - a.position);
  const byId = new Map(hoisted.map(r => [r.id, r]));
  const buckets = new Map<string, MemberRow[]>();
  const plain: MemberRow[] = [];
  for (const m of members) {
    let best: RoleSummary | null = null;
    for (const id of m.roleIds) {
      const r = byId.get(id);
      if (r !== undefined && (best === null || r.position > best.position)) best = r;
    }
    const tags: MemberTag[] = [];
    if (m.userId === ownerId) tags.push('owner');
    if (m.userId === selfId) tags.push('you');
    if (m.kind === 1) tags.push('bot');
    const row: MemberRow = { userId: m.userId, name: memberName(m), tags };
    if (best === null) plain.push(row);
    else {
      const list = buckets.get(best.id) ?? [];
      list.push(row);
      buckets.set(best.id, list);
    }
  }
  const byName = (a: MemberRow, b: MemberRow) => a.name.localeCompare(b.name);
  const groups: MemberGroup[] = hoisted.filter(r => buckets.has(r.id))
    .map(r => ({ id: r.id, role: r, members: (buckets.get(r.id) ?? []).sort(byName) }));
  groups.push({ id: 'members', role: null, members: plain.sort(byName) });
  return groups;
}

export type MenuAction = 'message' | 'compare' | 'kick' | 'ban';
export interface MenuContext { selfId: string; ownerId: string; roles: readonly RoleSummary[] }

/**
 * The actions offered for `member`: message (not on self), compare safety numbers, and kick and ban when the loaded
 * permissions allow it and the target ranks below the caller. Advisory only: the instance decides again.
 */
export function menuFor(member: MemberSummary, access: CommunityAccess | undefined, ctx: MenuContext): MenuAction[] {
  const out: MenuAction[] = [];
  if (member.userId !== ctx.selfId) out.push('message');
  out.push('compare');
  if (access !== undefined && access.loaded) {
    const may = canModerate({ me: ctx.selfId, target: member.userId, owner: ctx.ownerId, myTop: access.top, targetTop: topOf(member.roleIds, ctx.roles) });
    if (may && access.kickMembers) out.push('kick');
    if (may && access.banMembers) out.push('ban');
  }
  return out;
}
