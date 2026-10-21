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
  const roles = ctx.roles.filter(r => r.id !== ctx.access?.everyoneId && member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position).map(r => ({ name: r.name, color: r.color }));
  return {
    userId: member.userId, name: memberName(member), username: member.username,
    isOwner: member.userId === ctx.ownerId, isYou: member.userId === ctx.selfId,
    roles, actions: menuFor(member, ctx.access, ctx),
  };
}
