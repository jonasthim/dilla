// Wave 2a (flow 09): roles, grants, channel overwrites and private channels. Every client gate is advisory: the instance
// decides each request, and a refusal reaches the page with its own code. A 403 means the access the page holds is stale,
// so it is read again; the re-reads of a successful write are awaited, so the page sees the new slices when its call
// resolves.
import type { Id } from '../core-port';
import { fromHex, toHex } from '../hex';
import { DillaHttpError } from '../http/errors';
import { OVERWRITES_PER_CREATE_MAX, PERM_ALL, ROLE_COLOR_MAX, ROLE_NAME_MAX_BYTES } from '../http/routes';
import type { NewOverwrite, OverwriteRow, RoleRow, Routes } from '../http/routes';
import type { CommunityAccess, OverwriteSummary, RoleSummary, SliceName, SliceTypes } from '../state/types';
import type { Command } from '../worker/protocol';
import { PERM } from './perm';

export type RolesRoutes = Pick<Routes, 'createRole' | 'patchRole' | 'deleteRole' | 'grantRole' | 'revokeRole' | 'putOverwrite'
  | 'deleteOverwrite'>;

export interface RolesDeps {
  routes: RolesRoutes;
  me(): { userId: Id } | null;
  get<K extends SliceName>(name: K): SliceTypes[K] | undefined;
  publish<K extends SliceName>(name: K, value: SliceTypes[K]): void;
  listed(communityId: string): boolean;
  /** The server a known channel belongs to. */
  communityOf(channelId: string): string | null;
  /** Reads the member list of a server again; rejects when the read does. */
  reloadMembers(communityId: string): Promise<void>;
  /** The admin controller's access read (permissions, roles, overwrites); never rejects. */
  loadAccess(communityId: string): Promise<void>;
  /** The worker's own refusal (its code reaches the page as E_BAD_INPUT and the like). */
  refusal(code: string, detail: string, reason?: string): Error;
}

type RolesCommand = Extract<Command, { m: 'createRole' | 'updateRole' | 'moveRole' | 'deleteRole' | 'grantRole' | 'revokeRole'
  | 'setOverwrite' | 'setChannelPrivate' }>;
export type RolesMethod = RolesCommand['m'];

/** The highest position the instance stores for a role. */
const ROLE_POSITION_MAX = 2 ** 31 - 1;
const ID = /^[0-9a-f]{32}$/;
const UTF8 = new TextEncoder();

const bitsProblem = (field: string, v: unknown): string | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= PERM_ALL ? null : `${field} must be an integer 0..${String(PERM_ALL)}`;
const colorProblem = (v: unknown): string | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= ROLE_COLOR_MAX ? null : `color must be an integer 0..${String(ROLE_COLOR_MAX)}`;
function roleNameProblem(v: unknown): string | null {
  if (typeof v !== 'string' || v.trim() === '') return 'role name is blank';
  return UTF8.encode(v).length > ROLE_NAME_MAX_BYTES ? `role name is longer than ${String(ROLE_NAME_MAX_BYTES)} bytes` : null;
}

/** The synchronous input checks of the roles commands: an E_BAD_INPUT reason, or null. Ids are checked by the worker. */
export const ROLES_VALIDATORS: Record<RolesMethod, ((c: Record<string, unknown>) => string | null) | undefined> = {
  createRole: (c) => roleNameProblem(c.name) ?? colorProblem(c.color) ?? bitsProblem('allow', c.allow),
  updateRole: (c) => {
    if (c.name !== null) { const p = roleNameProblem(c.name); if (p !== null) return p; }
    if (c.color !== null) { const p = colorProblem(c.color); if (p !== null) return p; }
    if (c.allow !== null) { const p = bitsProblem('allow', c.allow); if (p !== null) return p; }
    if (c.name === null && c.color === null && c.hoist === null && c.mentionable === null && c.allow === null) return 'nothing to change';
    return null;
  },
  moveRole: (c) => (c.direction === 'up' || c.direction === 'down' ? null : 'direction must be up or down'),
  deleteRole: undefined,
  grantRole: undefined,
  revokeRole: undefined,
  setOverwrite: (c) => {
    if (c.kind !== 0 && c.kind !== 1) return 'kind must be 0 or 1';
    const p = bitsProblem('allow', c.allow) ?? bitsProblem('deny', c.deny);
    if (p !== null) return p;
    return ((c.allow as number) & (c.deny as number)) !== 0 ? 'allow and deny overlap' : null;
  },
  setChannelPrivate: undefined,
};

/** Roles a private create can open the channel to: the @everyone entry and, for a member who is neither owner nor
 *  administrator, her own entry take two of the instance's overwrites per create. */
const PRIVATE_ROLES_MAX = OVERWRITES_PER_CREATE_MAX - 2;
const ANNOUNCE_ROLES_REASON = `an announcement channel can be opened to at most ${String(PRIVATE_ROLES_MAX)} roles`;
const ANNOUNCE_HELD_ROLE_REASON = 'tick a role you hold, or you could not post in this channel';
const PRIVATE_ROLES_REASON = `a private channel can be opened to at most ${String(PRIVATE_ROLES_MAX)} roles`;

/** The `private` field of createChannel: `{ roleIds }` of 32-hex ids, at most one fewer than the instance's cap (the
 *  owner's create has no self entry; a member's is checked again with it); a reason or null. */
export function privateProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'roleIds must be an array of ids';
  const { roleIds } = v as { roleIds?: unknown };
  if (!Array.isArray(roleIds) || !roleIds.every((r) => typeof r === 'string' && ID.test(r))) return 'roleIds must be an array of ids';
  return roleIds.length > OVERWRITES_PER_CREATE_MAX - 1 ? PRIVATE_ROLES_REASON : null;
}

/** Whether the caller may create an announcement channel: the instance asks for manage_channels for the channel and
 *  manage_roles for the overwrites it carries. */
export const canCreateAnnouncement = (access: CommunityAccess): boolean => access.manageChannels && access.manageRoles;

/** The `announce` field of createChannel: `{ roleIds }` of 32-hex ids, at most the cap less @everyone's entry (the creator's
 *  own entry is checked again when it is added); a reason or null. */
export function announceProblem(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return 'roleIds must be an array of ids';
  const { roleIds } = v as { roleIds?: unknown };
  if (!Array.isArray(roleIds) || !roleIds.every((r) => typeof r === 'string' && ID.test(r))) return 'roleIds must be an array of ids';
  return roleIds.length > OVERWRITES_PER_CREATE_MAX - 1 ? ANNOUNCE_ROLES_REASON : null;
}

const statusOf = (e: unknown): number | null => (e instanceof DillaHttpError ? e.status : null);
function byPositionThenId(a: RoleRow, b: RoleRow): number {
  const x = toHex(a.id);
  const y = toHex(b.id);
  return a.position - b.position || (x < y ? -1 : x > y ? 1 : 0);
}

export class RolesController {
  /** The last role rows and raw permission bits read per community; no slice carries the raw bits. */
  private readonly rows = new Map<string, RoleRow[]>();
  private readonly bits = new Map<string, bigint>();

  constructor(private readonly deps: RolesDeps) {}

  // ---- reads (called by the admin controller's access read) ----

  /** The access read landed: keep the rows and bits, publish the roles with their counts and the overwrites by channel.
   *  `overwrites` is null when that read failed (the slice stays as it was). */
  accessRead(communityId: string, roles: RoleRow[], bits: bigint, overwrites: OverwriteRow[] | null): void {
    this.rows.set(communityId, roles);
    this.bits.set(communityId, bits);
    this.publishRoles(communityId);
    if (overwrites === null) return;
    const byChannel: Record<string, OverwriteSummary[]> = {};
    for (const o of overwrites) {
      (byChannel[toHex(o.channelId)] ??= []).push({ kind: o.kind, targetId: toHex(o.targetId), allow: o.allow, deny: o.deny });
    }
    this.deps.publish(`overwrites:${communityId}`, byChannel);
  }

  /** The member list changed: the role counts are published again. */
  membersChanged(communityId: string): void {
    if (this.rows.has(communityId)) this.publishRoles(communityId);
  }

  /** A dropped server: nothing is kept. */
  forget(communityId: string): void {
    this.rows.delete(communityId);
    this.bits.delete(communityId);
  }

  private publishRoles(communityId: string): void {
    const rows = this.rows.get(communityId);
    if (rows === undefined) return;
    const members = this.deps.get(`members:${communityId}`) ?? [];
    this.deps.publish(`roles:${communityId}`, rows.map((r): RoleSummary => {
      const id = toHex(r.id);
      const count = r.position === 0 ? members.length : members.filter((m) => m.roleIds.includes(id)).length;
      return { id, name: r.name, color: r.color, position: r.position, hoist: r.hoist, mentionable: r.mentionable, allow: r.allow,
        deny: r.deny, members: count };
    }));
  }

  // ---- roles ----

  async createRole(communityId: string, name: string, color: number, hoist: boolean, mentionable: boolean, allow: number): Promise<{ roleId: string }> {
    this.requireListed(communityId);
    const { rows, owner, top } = await this.access(communityId);
    const used = new Set(rows.map((r) => r.position));
    let position = 1;
    while (used.has(position)) position += 1;
    // The lowest free position below my top; the owner's bound is the largest position the instance stores.
    if (position > (owner ? ROLE_POSITION_MAX : top - 1)) throw this.deps.refusal('E_BAD_INPUT', 'no room below your highest role');
    const created = await this.guarded(communityId, () => this.deps.routes.createRole(fromHex(communityId),
      { name, color, position, allow, deny: 0, hoist, mentionable }));
    await this.deps.loadAccess(communityId);
    return { roleId: toHex(created.roleId) };
  }

  async updateRole(communityId: string, roleId: string, name: string | null, color: number | null, hoist: boolean | null,
    mentionable: boolean | null, allow: number | null): Promise<null> {
    this.requireListed(communityId);
    const patch: { name?: string; color?: number; allow?: number; hoist?: boolean; mentionable?: boolean } = {};
    if (name !== null) patch.name = name;
    if (color !== null) patch.color = color;
    if (hoist !== null) patch.hoist = hoist;
    if (mentionable !== null) patch.mentionable = mentionable;
    if (allow !== null) patch.allow = allow;
    await this.guarded(communityId, () => this.deps.routes.patchRole(fromHex(roleId), patch));
    await this.deps.loadAccess(communityId);
    return null;
  }

  /** Moves a role one step. The neighbour is the next role up or down (never @everyone) and must be below my top unless I
   *  own the server. With different positions the two trade; with equal positions only the mover steps past the neighbour. */
  async moveRole(communityId: string, roleId: string, direction: 'up' | 'down'): Promise<null> {
    this.requireListed(communityId);
    const { rows, owner, top } = await this.access(communityId);
    const sorted = rows.slice().sort(byPositionThenId);
    const at = sorted.findIndex((r) => toHex(r.id) === roleId);
    if (at < 0) throw this.deps.refusal('E_BAD_INPUT', 'unknown role');
    const mover = sorted[at];
    const other = sorted[direction === 'up' ? at + 1 : at - 1] as RoleRow | undefined;
    if (mover.position === 0 || other === undefined || other.position === 0) return null;
    if (!owner && other.position >= top) return null;
    const changes: { id: Uint8Array; position: number }[] = [];
    if (mover.position !== other.position) {
      changes.push({ id: mover.id, position: other.position }, { id: other.id, position: mover.position });
    } else {
      const to = direction === 'up' ? other.position + 1 : Math.max(1, other.position - 1);
      if (to > ROLE_POSITION_MAX || (!owner && to >= top)) return null;
      changes.push({ id: mover.id, position: to });
    }
    try {
      for (const change of changes) await this.deps.routes.patchRole(change.id, { position: change.position });
    } catch (e) {
      // Any refusal (a 403, a 409 when the positions moved meanwhile, or a partial swap) reads the access once, as
      // `guarded` would: what the instance holds decides, not the rows the page had.
      await this.deps.loadAccess(communityId);
      throw e;
    }
    await this.deps.loadAccess(communityId);
    return null;
  }

  /** A 404 is a retried request whose first attempt went through: the role is gone, and the command succeeds. */
  async deleteRole(communityId: string, roleId: string): Promise<null> {
    this.requireListed(communityId);
    try {
      await this.guarded(communityId, () => this.deps.routes.deleteRole(fromHex(roleId)));
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
    // Members held the role: their rows lose it with the role.
    await this.afterMembers(communityId);
    return null;
  }

  async grantRole(communityId: string, userId: string, roleId: string): Promise<null> {
    this.requireListed(communityId);
    await this.guarded(communityId, () => this.deps.routes.grantRole(fromHex(communityId), fromHex(userId), fromHex(roleId)));
    await this.afterMembers(communityId);
    return null;
  }

  /** A 404 means the role was not held any more (a retried request): the command succeeds. */
  async revokeRole(communityId: string, userId: string, roleId: string): Promise<null> {
    this.requireListed(communityId);
    try {
      await this.guarded(communityId, () => this.deps.routes.revokeRole(fromHex(communityId), fromHex(userId), fromHex(roleId)));
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
    await this.afterMembers(communityId);
    return null;
  }

  // ---- overwrites and private channels ----

  /** Both bits 0 removes the entry (a 404 is already gone); otherwise the entry is put. */
  async setOverwrite(channelId: string, kind: 0 | 1, targetId: string, allow: number, deny: number): Promise<null> {
    const communityId = this.communityOfChannel(channelId);
    await this.writeOverwrite(communityId, channelId, kind, targetId, allow, deny);
    await this.deps.loadAccess(communityId);
    return null;
  }

  async setChannelPrivate(channelId: string, makePrivate: boolean): Promise<null> {
    const communityId = this.communityOfChannel(channelId);
    // Never act on stale or missing overwrites: read them now, and refuse when they cannot be read.
    await this.deps.loadAccess(communityId);
    if (this.deps.get(`permissions:${communityId}`)?.overwritesLoaded !== true) {
      throw this.deps.refusal('E_BAD_INPUT', 'the channel permissions could not be read');
    }
    const { everyoneId, owner } = await this.access(communityId);
    const entries = this.deps.get(`overwrites:${communityId}`)?.[channelId] ?? [];
    const everyone = entries.find((o) => o.kind === 0 && o.targetId === everyoneId);
    if (makePrivate) {
      if (!owner && !this.administrator(communityId) && !this.allowsMeToView(communityId, entries, everyoneId)) {
        throw this.deps.refusal('E_BAD_INPUT', 'you would lose this channel');
      }
      // A deny does not beat an allow of the same bit, so the bit leaves the allow side too.
      await this.writeOverwrite(communityId, channelId, 0, everyoneId, (everyone?.allow ?? 0) & ~PERM.viewChannel,
        (everyone?.deny ?? 0) | PERM.viewChannel);
    } else {
      if (everyone === undefined || (everyone.deny & PERM.viewChannel) === 0) return null;
      await this.writeOverwrite(communityId, channelId, 0, everyoneId, everyone.allow, everyone.deny & ~PERM.viewChannel);
    }
    await this.deps.loadAccess(communityId);
    return null;
  }

  /** The overwrites of a private create: @everyone denied viewing, each chosen role allowed, and the creator herself when
   *  she holds neither ownership nor administrator (she would lose the channel she just made). */
  async privateOverwrites(communityId: string, roleIds: readonly string[]): Promise<NewOverwrite[]> {
    const { everyoneId, owner } = await this.access(communityId);
    const out: NewOverwrite[] = [{ kind: 0, targetId: fromHex(everyoneId), allow: 0, deny: PERM.viewChannel }];
    for (const roleId of new Set(roleIds)) {
      if (roleId !== everyoneId) out.push({ kind: 0, targetId: fromHex(roleId), allow: PERM.viewChannel, deny: 0 });
    }
    const me = this.deps.me();
    if (me !== null && !owner && !this.administrator(communityId)) out.push({ kind: 1, targetId: me.userId, allow: PERM.viewChannel, deny: 0 });
    if (out.length > OVERWRITES_PER_CREATE_MAX) throw this.deps.refusal('E_BAD_INPUT', PRIVATE_ROLES_REASON);
    return out;
  }

  /** The overwrites of an announcement create: @everyone denied sending, each chosen role allowed to send (deduplicated,
   *  @everyone skipped). A creator who is neither owner nor administrator must tick a role she holds, else the create is
   *  refused here with no request: she would lose the right to post in the channel she made. */
  async announcementOverwrites(communityId: string, roleIds: readonly string[]): Promise<NewOverwrite[]> {
    const { everyoneId, owner, rows, top } = await this.access(communityId);
    const out: NewOverwrite[] = [{ kind: 0, targetId: fromHex(everyoneId), allow: 0, deny: PERM.sendMessages }];
    for (const roleId of new Set(roleIds)) {
      if (roleId !== everyoneId) out.push({ kind: 0, targetId: fromHex(roleId), allow: PERM.sendMessages, deny: 0 });
    }
    // The instance accepts no self entry here, and refuses a role entry at or above the creator's own rank, so the creator
    // keeps her right to post through a ticked role she holds below her top; the owner and an administrator need none.
    // With her own roles not yet loaded nothing is refused here: the instance answers.
    const members = this.deps.get(`members:${communityId}`);
    if (!owner && !this.administrator(communityId) && members !== undefined) {
      const me = this.deps.me();
      const mine = me === null ? undefined : toHex(me.userId);
      const held = new Set(members.find((m) => m.userId === mine)?.roleIds ?? []);
      const rank = new Map(rows.map((r) => [toHex(r.id), r.position]));
      if (![...new Set(roleIds)].some((r) => r !== everyoneId && held.has(r) && (rank.get(r) ?? top) < top)) {
        throw this.deps.refusal('E_BAD_INPUT', ANNOUNCE_HELD_ROLE_REASON, 'announce.noHeldRole');
      }
    }
    if (out.length > OVERWRITES_PER_CREATE_MAX) throw this.deps.refusal('E_BAD_INPUT', ANNOUNCE_ROLES_REASON);
    return out;
  }

  /** Runs a request; a 403 (the instance no longer grants what the page offered) or a 409 (patchRole: the role moved
   *  meanwhile) reads the access again, and the refusal still reaches the page. */
  async guarded<T>(communityId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const status = statusOf(e);
      if (status === 403 || status === 409) await this.deps.loadAccess(communityId);
      throw e;
    }
  }

  // ---- internals ----

  private async writeOverwrite(communityId: string, channelId: string, kind: 0 | 1, targetId: string, allow: number, deny: number): Promise<void> {
    if (allow === 0 && deny === 0) {
      try {
        await this.guarded(communityId, () => this.deps.routes.deleteOverwrite(fromHex(channelId), kind, fromHex(targetId)));
      } catch (e) {
        if (statusOf(e) !== 404) throw e;
      }
      return;
    }
    await this.guarded(communityId, () => this.deps.routes.putOverwrite(fromHex(channelId), kind, fromHex(targetId), { allow, deny }));
  }

  /** Mirrors the instance's rule: some overwrite of this channel, other than the @everyone one being denied, lets me view it. */
  private allowsMeToView(communityId: string, entries: readonly OverwriteSummary[], everyoneId: string): boolean {
    const me = this.deps.me();
    if (me === null) return false;
    const mine = toHex(me.userId);
    const held = new Set(this.deps.get(`members:${communityId}`)?.find((m) => m.userId === mine)?.roleIds ?? []);
    return entries.some((o) => (o.allow & PERM.viewChannel) !== 0
      && ((o.kind === 1 && o.targetId === mine) || (o.kind === 0 && o.targetId !== everyoneId && held.has(o.targetId))));
  }

  private administrator(communityId: string): boolean {
    return ((this.bits.get(communityId) ?? 0n) & BigInt(PERM.administrator)) !== 0n;
  }

  /** The rows, rank and @everyone of a server; read first when the page has none yet. */
  private async access(communityId: string): Promise<{ rows: RoleRow[]; owner: boolean; top: number; everyoneId: string }> {
    const read = (): { rows: RoleRow[]; owner: boolean; top: number; everyoneId: string } | null => {
      const rows = this.rows.get(communityId);
      const access = this.deps.get(`permissions:${communityId}`);
      if (rows === undefined || access === undefined || !access.loaded || access.everyoneId === '') return null;
      return { rows, owner: access.owner, top: access.top, everyoneId: access.everyoneId };
    };
    let held = read();
    if (held === null) { await this.deps.loadAccess(communityId); held = read(); }
    if (held === null) throw this.deps.refusal('E_BAD_INPUT', 'the roles of this server are not loaded');
    return held;
  }

  private async afterMembers(communityId: string): Promise<void> {
    await Promise.all([this.deps.reloadMembers(communityId).catch(() => undefined), this.deps.loadAccess(communityId)]);
  }

  private requireListed(communityId: string): void {
    if (!this.deps.listed(communityId)) throw this.deps.refusal('E_BAD_INPUT', 'unknown community');
  }

  private communityOfChannel(channelId: string): string {
    const communityId = this.deps.communityOf(channelId);
    if (communityId === null) throw this.deps.refusal('E_BAD_INPUT', 'unknown channel');
    return communityId;
  }
}
