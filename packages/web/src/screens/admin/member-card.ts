// Flow 08/14: one member's profile card, built from the slices. Pure, so the pane and (MP7) the mentions and message
// authors build the same card.
import type { CommunityAccess, MemberSummary, RoleSummary } from '@dilla/client-core';
import { memberName, menuFor, type MenuAction } from './members-model.ts';

export interface MemberCardContext { selfId: string; ownerId: string; roles: readonly RoleSummary[]; access: CommunityAccess | undefined }
export interface MemberCardData {
  userId: string;
  name: string;
  username: string;
  isOwner: boolean;
  isYou: boolean;
  /** The member's roles, highest position first; `color` is 0 for a role with none. */
  roles: { name: string; color: number }[];
  /** The permission-gated actions, in the card's order. */
  actions: MenuAction[];
}

export function memberCardData(member: MemberSummary, ctx: MemberCardContext): MemberCardData {
  const roles = ctx.roles.filter(r => r.position !== 0 &&member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position).map(r => ({ name: r.name, color: r.color }));
  return {
    userId: member.userId, name: memberName(member), username: member.username,
    isOwner: member.userId === ctx.ownerId, isYou: member.userId === ctx.selfId,
    roles, actions: menuFor(member, ctx.access, ctx),
  };
}

export interface DmCardContext { selfId: string; /** The DM's name, shown when no shared server lists the person. */ fallbackName: string }

/** A DM peer's card (EOD E3): no server context, so no roles, owner, kick or ban; just message and compare. */
export function dmCardData(userId: string, member: MemberSummary | undefined, ctx: DmCardContext): MemberCardData {
  const isYou = userId === ctx.selfId;
  return {
    userId, name: member === undefined ? ctx.fallbackName : memberName(member), username: member?.username ?? '',
    isOwner: false, isYou, roles: [], actions: isYou ? [] : ['message', 'compare'],
  };
}
