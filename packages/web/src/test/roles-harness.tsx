// Shared set-up for the roles screens' tests (flow 09): one server, four roles, one signed-in member.
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { Command, CommunityAccess, MemberSummary, RoleSummary } from '@dilla/client-core';
import { CoreProvider } from '../core/context.tsx';
import { FakeClient } from './fake-client.ts';
import { account, ME } from './fixtures.ts';

export const SERVER = 'a1'.repeat(16);
export const BOSS = '28'.repeat(16);
export const EVERY = 'e0'.repeat(16);
export const ADMINS = 'e1'.repeat(16);
export const MODS = 'e2'.repeat(16);
export const CREW = 'e3'.repeat(16);

export const role = (id: string, name: string, position: number, over: Partial<RoleSummary> = {}): RoleSummary =>
  ({ id, name, color: 0, position, hoist: false, mentionable: false, allow: 0, deny: 0, members: 0, ...over });

export const PERM_VIEW_SEND = 3;
export const ROLES: RoleSummary[] = [role(EVERY, '@everyone', 0, { allow: PERM_VIEW_SEND, members: 5 }),
  role(CREW, 'crew', 2, { members: 1 }), role(MODS, 'mods', 5, { members: 2, color: 0x0090FF }), role(ADMINS, 'admins', 9, { members: 1 })];

export const OWNER_ACCESS: CommunityAccess = { top: 2 ** 31, owner: true, manageCommunity: true, manageChannels: true, kickMembers: true,
  banMembers: true, createInvite: true, manageRoles: true, loaded: true, everyoneId: EVERY, overwritesLoaded: true };

export interface HarnessOptions {
  access?: CommunityAccess;
  roles?: RoleSummary[] | null;
  members?: MemberSummary[];
  handler?: (c: Command, fake: FakeClient) => Promise<unknown>;
}

/** A FakeClient with the slices of one server, the handler (which may publish before it resolves) and a render helper. */
export function harness(options: HarnessOptions = {}) {
  const fake = new FakeClient();
  const access = options.access ?? OWNER_ACCESS;
  fake.set('account', account());
  fake.set('communities', [{ id: SERVER, name: 'Björn', owner: access.owner ? ME.id : BOSS }]);
  fake.set(`permissions:${SERVER}`, access);
  if (options.roles !== null) fake.set(`roles:${SERVER}`, options.roles ?? ROLES);
  fake.set(`members:${SERVER}`, options.members ?? [{ userId: ME.id, username: 'ada', display: '', kind: 0, roleIds: [] }]);
  if (options.handler) fake.handler = c => options.handler!(c, fake);
  const announce = vi.fn();
  const user = userEvent.setup();
  const mount = (ui: React.ReactNode) => render(<div className="d-root"><CoreProvider client={fake}>{ui}</CoreProvider></div>);
  return { fake, user, announce, mount };
}
