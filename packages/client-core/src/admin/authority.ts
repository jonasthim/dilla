// Wave 2a (web3.5 C4): who may pin and who may mention everyone in each text channel's group, as the host-served roles,
// members and overwrites say. The worker hands it to the core's authority_set, which then counts only those pins and
// broadcast mentions. The view is advisory and the host's claim: it changes which pins and mentions this device counts,
// never which messages it shows.
import type { OverwriteSummary } from '../state/types';
import { PERM, channelBitsFrom, indexOverwrites, resolveUser, type PermMember, type PermRole, type ResolvedUser } from './perm';

/** The sorted 32-hex user ids allowed `pin_messages` (bit 3) and `mention_everyone` (bit 18) in one group's channel. */
export interface AuthorityView { pinners: string[]; broadcasters: string[] }

export interface AuthorityInput {
  owner: string;
  everyoneId: string;
  roles: readonly PermRole[];
  /** The whole member list of the server: a user absent from it is not a member and is allowed nothing. */
  members: readonly PermMember[];
  /** channel id (hex) → that channel's overwrites (the `overwrites:` slice). */
  overwrites: Readonly<Record<string, readonly OverwriteSummary[]>>;
  /** One entry per group: a channel bound to two groups appears twice. */
  channels: readonly { id: string; kind: number; mode: number; textGroupId: string | null }[];
}

/** group hex → its view, for every text channel (kind 0, mode 0) with a group. Each user's community bits are resolved
 *  once; a channel with no overwrites of its own takes that base view; any other applies only its own overwrites. */
export function authorityFor(s: AuthorityInput): Map<string, AuthorityView> {
  const held = new Map<string, readonly string[]>();
  for (const m of s.members) if (!held.has(m.userId)) held.set(m.userId, m.roleIds);   // the first row counts, as channelBitsOf's find
  if (!held.has(s.owner)) held.set(s.owner, []);
  const roles = [...s.roles];
  const users = [...held.keys()].sort().map((userId) =>
    resolveUser({ owner: s.owner, everyoneId: s.everyoneId, roles, held: held.get(userId) ?? [] }, userId));
  const viewOf = (bitsOf: (u: ResolvedUser) => number): AuthorityView => {
    const view: AuthorityView = { pinners: [], broadcasters: [] };
    for (const u of users) {
      const bits = bitsOf(u);
      if ((bits & PERM.pinMessages) !== 0) view.pinners.push(u.userId);
      if ((bits & PERM.mentionEveryone) !== 0) view.broadcasters.push(u.userId);
    }
    return view;
  };
  let base: AuthorityView | null = null;
  const out = new Map<string, AuthorityView>();
  for (const channel of s.channels) {
    if (channel.kind !== 0 || channel.mode !== 0 || channel.textGroupId === null) continue;
    // Only this channel's own overwrites count for it.
    const own = Object.prototype.hasOwnProperty.call(s.overwrites, channel.id) ? s.overwrites[channel.id] : [];
    if (own.length === 0) {
      base ??= viewOf((u) => u.base);
      out.set(channel.textGroupId, { pinners: base.pinners.slice(), broadcasters: base.broadcasters.slice() });
      continue;
    }
    const index = indexOverwrites(own);
    out.set(channel.textGroupId, viewOf((u) => channelBitsFrom(u, index)));
  }
  return out;
}
