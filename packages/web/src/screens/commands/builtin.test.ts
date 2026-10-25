import { describe, expect, it, vi } from 'vitest';
import { COMMANDS, PERM, type Command } from '@dilla/client-core';
import { FakeClient } from '../../test/fake-client.ts';
import { builtinHandlers } from './builtin.ts';
import type { CommandExecutionContext } from './command-types.ts';

const client = new FakeClient();
const context: CommandExecutionContext = {
  requestId: 'attempt-1', binding: { communityId: '11'.repeat(16), channelId: '22'.repeat(16), bits: 0 },
  client, call: {} as never, isCurrent: () => true, getCurrentBinding: () => context.binding, getCall: () => context.call, navigate: () => undefined, openThread: () => undefined, openSearch: () => undefined,
  items: [], selfId: '33'.repeat(16), encodeMessage: text => text, confirm: async () => true, openInvite: async () => true, openGif: () => undefined, openModerationLog: () => undefined,
};

describe('built-in command handlers', () => {
  it('publishes formatted text to the bound thread as a plain message', async () => {
    const thread = '44'.repeat(16);
    const result = await builtinHandlers.me!({ commandId: 'me', args: { text: 'waves 👋' } }, {
      ...context, binding: { ...context.binding, threadId: thread },
    });
    expect(result).toEqual({ status: 'success', private: false, message: 'Sent.' });
    expect(client.callsOf('send')).toEqual([{ m: 'send', channelId: context.binding.channelId, threadId: thread, text: '_waves 👋_' }]);
  });

  it('refuses an edit when the selected message is not mine and makes no worker call', async () => {
    client.calls.length = 0;
    const result = await builtinHandlers.edit!({ commandId: 'edit', args: { message: '55'.repeat(16), text: 'changed' } }, {
      ...context, items: [{ msgId: '55'.repeat(16), seq: '7', senderUser: '66'.repeat(16), state: 'ok' } as never],
    });
    expect(result.status).toBe('failure');
    expect(client.calls).toEqual([]);
  });


  it('replies to the exact loaded message in the bound thread', async () => {
    client.calls.length = 0;
    const message = '77'.repeat(16);
    const result = await builtinHandlers.reply!({ commandId: 'reply', args: { message, text: 'answer' } }, {
      ...context, binding: { ...context.binding, threadId: '88'.repeat(16) },
      items: [{ msgId: message, seq: '8', state: 'ok' } as never],
    });
    expect(result.status).toBe('success');
    expect(client.callsOf('send')).toEqual([{ m: 'send', channelId: context.binding.channelId, threadId: '88'.repeat(16), text: 'answer', replyTo: message }]);
  });

  it('returns uncertain when message publication rejects after the request was handed to core', async () => {
    client.handler = async (command: Command) => { if (command.m === 'send') throw new Error('transport lost'); return null; };
    const result = await builtinHandlers.me!({ commandId: 'me', args: { text: 'hello' } }, context);
    expect(result).toMatchObject({ status: 'uncertain', private: true });
    client.handler = async () => null;
  });

  it('returns private registry help and rejects an unknown command name', async () => {
    const help = await builtinHandlers.help!({ commandId: 'help', args: { command: 'ban' } }, context);
    expect(help).toMatchObject({ status: 'success', private: true });
    expect(help.message).toContain('/ban <user> [duration] [reason]');
    expect(help.message).toContain('Ban a member');
    const unknown = await builtinHandlers.help!({ commandId: 'help', args: { command: 'madeup' } }, context);
    expect(unknown).toMatchObject({ status: 'failure', private: true });
  });

  it('does not queue a second public message when an unknown attempt is repeated', async () => {
    const core = new FakeClient();
    core.handler = async command => { if (command.m === 'send') throw new Error('lost response'); return null; };
    const attempt = { ...context, client: core, requestId: `unknown-${crypto.randomUUID()}` };
    const invocation = { commandId: 'me', args: { text: 'hello' } };
    expect((await builtinHandlers.me!(invocation, attempt)).status).toBe('uncertain');
    expect((await builtinHandlers.me!(invocation, attempt)).status).toBe('uncertain');
    expect(core.callsOf('send')).toHaveLength(1);
  });

  it('does not navigate after opening a DM when the original host is stale', async () => {
    const core = new FakeClient();
    core.handler = async command => command.m === 'openDm' ? { channelId: 'bc'.repeat(16) } : null;
    const navigated: unknown[] = [];
    const stale = await builtinHandlers.dm!({ commandId: 'dm', args: { user: 'cd'.repeat(16) } }, {
      ...context, client: core, isCurrent: () => false, navigate: route => navigated.push(route),
    });
    expect(stale).toMatchObject({ status: 'uncertain', private: true });
    expect(navigated).toEqual([]);
  });

  it('deafens an active call without toggling mute back off from a stale view', async () => {
    const state = { muted: false, deafened: false };
    const toggleMute = vi.fn(() => { state.muted = !state.muted; });
    const toggleDeafen = vi.fn(() => { state.deafened = !state.deafened; state.muted = state.deafened; });
    const live = { channelId: '55'.repeat(16), joining: false, session: { state }, selfMuted: false, selfDeafened: false, toggleMute, toggleDeafen } as any;
    const result = await builtinHandlers.deafen!({ commandId: 'deafen', args: {} }, { ...context, call: live, getCall: () => live });
    expect(result.status).toBe('success');
    expect(state).toEqual({ muted: true, deafened: true });
    expect(toggleDeafen).toHaveBeenCalledTimes(1);
    expect(toggleMute).not.toHaveBeenCalled();
  });

  it.each([
    ['mute', false, false, true, false],
    ['unmute', true, false, false, false],
    ['deafen', false, false, true, true],
    ['undeafen', true, true, true, false],
  ] as const)('%s applies the requested live mute and deafen state', async (id, muted, deafened, expectedMuted, expectedDeafened) => {
    const state = { muted, deafened };
    const call: any = { channelId: '55'.repeat(16), selfMuted: muted, selfDeafened: deafened, joining: false,
      session: { state }, toggleMute: () => { state.muted = !state.muted; if (!state.muted) state.deafened = false; },
      toggleDeafen: () => { state.deafened = !state.deafened; if (state.deafened) state.muted = true; } };
    const result = await builtinHandlers[id]!({ commandId: id, args: {} }, { ...context, call, getCall: () => call });
    expect(result.status).toBe('success');
    expect(state).toEqual({ muted: expectedMuted, deafened: expectedDeafened });
  });

  it('waits for the actual voice session and reports media setup failure', async () => {
    const core = new FakeClient();
    const communityId = context.binding.communityId!, voiceId = 'aa'.repeat(16);
    core.set(`channels:${communityId}`, [{ id: voiceId, communityId, kind: 1, mode: 0, name: 'voice' } as any]);
    core.set('call', { channelId: voiceId, phase: 'in' } as any);
    const live: any = { channelId: null, joining: false, session: null, notice: null, join: (id: string) => {
      live.channelId = id; live.joining = true;
      window.setTimeout(() => { live.session = { state: { muted: false, deafened: false } }; live.joining = false; }, 5);
    } };
    const result = await builtinHandlers.join!({ commandId: 'join', args: { channel: voiceId } }, {
      ...context, client: core, call: live, getCall: () => live,
    });
    expect(result).toMatchObject({ status: 'success', message: 'Joined voice.' });

    live.channelId = null; live.session = null; live.joining = false;
    const failedLive: any = { ...live, join: (id: string) => {
      failedLive.channelId = id; failedLive.joining = true;
      window.setTimeout(() => { failedLive.notice = { channelId: id, key: 'call.unsupported' }; failedLive.joining = false; failedLive.channelId = null; }, 5);
    } };
    const failed = await builtinHandlers.join!({ commandId: 'join', args: { channel: voiceId } }, {
      ...context, client: core, call: failedLive, getCall: () => failedLive,
    });
    expect(failed).toMatchObject({ status: 'failure', message: expect.stringContaining('call.unsupported') });
  });
});

describe('builtin handler safety regressions', () => {
  const message = '99'.repeat(16);
  const ownMessage = { msgId: message, seq: '9', state: 'ok', senderUser: context.selfId, body: 'hello', pinned: false } as any;

  it('allows pinning with Pin Messages and does not require Manage Messages', async () => {
    const core = new FakeClient();
    const result = await builtinHandlers.pin!({ commandId: 'pin', args: { message } }, contextWithBinding({ bits: PERM.pinMessages }, { client: core, items: [ownMessage] }));
    expect(result.status).toBe('success');
    expect(core.callsOf('pin')).toEqual([{ m: 'pin', channelId: context.binding.channelId, msgId: message, on: true }]);
  });

  it('uses the mention encoder before edit UTF-8 validation and publication', async () => {
    const core = new FakeClient();
    const result = await builtinHandlers.edit!({ commandId: 'edit', args: { message, text: '@bob hi' } }, {
      ...context, client: core, items: [ownMessage], encodeMessage: () => '<@55'.repeat(1) + ' hi',
    });
    expect(result.status).toBe('success');
    expect(core.callsOf('editMessage')[0]?.text).toBe('<@55 hi');
  });

  it('rejects an edit whose mention encoding expands beyond the UTF-8 budget', async () => {
    const core = new FakeClient();
    const result = await builtinHandlers.edit!({ commandId: 'edit', args: { message, text: 'x' } }, {
      ...context, client: core, items: [ownMessage], encodeMessage: () => '界'.repeat(1400),
    });
    expect(result.status).toBe('failure');
    expect(core.callsOf('editMessage')).toEqual([]);
  });

  it('preserves unknown moderation removal as uncertain and includes its recovery proof id', async () => {
    const core = new FakeClient();
    core.handler = async command => command.m === 'moderateRemoveMessage' || command.m === 'resolveManualRemoval'
      ? { removal: 'unknown', proofRequestId: 'aa'.repeat(16), evidenceRequestId: 'bb'.repeat(16), evidenceUpload: 'unknown' } : null;
    const result = await builtinHandlers.delete!({ commandId: 'delete', args: { message, reason: 'review' } }, contextWithBinding({ bits: PERM.manageMessages }, {
      client: core, items: [{ ...ownMessage, senderUser: '66'.repeat(16) } as any], confirm: async () => true,
    }));
    expect(result).toMatchObject({ status: 'uncertain', message: expect.stringContaining('aa'.repeat(16)) });
  });

  it('preserves rejected moderation removal as a failure', async () => {
    const core = new FakeClient();
    core.handler = async command => command.m === 'moderateRemoveMessage' ? { removal: 'rejected', proofRequestId: 'aa'.repeat(16) } : null;
    const result = await builtinHandlers.delete!({ commandId: 'delete', args: { message, reason: 'review' } }, {
      ...context, client: core, binding: { ...context.binding, bits: PERM.manageMessages },
      items: [{ ...ownMessage, senderUser: '66'.repeat(16) } as any], confirm: async () => true,
    });
    expect(result.status).toBe('failure');
  });

  it('rechecks Manage Messages after confirming removal', async () => {
    const core = new FakeClient();
    let currentBits = PERM.manageMessages;
    const binding = { ...context.binding, bits: PERM.manageMessages };
    const result = await builtinHandlers.delete!({ commandId: 'delete', args: { message, reason: 'review' } }, {
      ...context, client: core, binding, getCurrentBinding: () => ({ ...binding, bits: currentBits }),
      items: [{ ...ownMessage, senderUser: '66'.repeat(16) } as any],
      confirm: async () => { currentBits = 0; return true; },
    });
    expect(result.status).toBe('failure');
    expect(core.callsOf('moderateRemoveMessage')).toEqual([]);
  });

  it('bounds a moderator excerpt to the worker’s 512 UTF-8 byte limit', async () => {
    const core = new FakeClient();
    core.handler = async command => command.m === 'moderateRemoveMessage' ? { removal: 'accepted', proofRequestId: 'aa'.repeat(16), evidenceRequestId: 'bb'.repeat(16), evidenceUpload: 'accepted' } : null;
    const result = await builtinHandlers.delete!({ commandId: 'delete', args: { message, reason: 'review' } }, contextWithBinding({ bits: PERM.manageMessages }, {
      client: core, items: [{ ...ownMessage, senderUser: '66'.repeat(16), body: '界'.repeat(200) } as any], confirm: async () => true,
    }));
    expect(result.status).toBe('success');
    const command = core.callsOf('moderateRemoveMessage')[0];
    expect(new TextEncoder().encode(command?.excerpt ?? '').length).toBeLessThanOrEqual(512);
  });

  it('refuses moderation of a self or higher-rank target before confirmation', async () => {
    const core = new FakeClient();
    const cid = context.binding.communityId!;
    const target = '66'.repeat(16);
    core.set('communities', [{ id: cid, name: 'Town', owner: '77'.repeat(16) }]);
    core.set(`permissions:${cid}`, { loaded: true, top: 4, owner: false, manageCommunity: false, kickMembers: true, banMembers: true, moderateMembers: true, manageRoles: true, manageChannels: true, createInvite: false, everyoneId: '88'.repeat(16), overwritesLoaded: true });
    core.set(`roles:${cid}`, [{ id: 'a'.repeat(32), name: 'higher', position: 5, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 }]);
    core.set(`members:${cid}`, [{ userId: target, username: 'target', display: '', kind: 0, roleIds: ['a'.repeat(32)] }, { userId: context.selfId!, username: 'self', display: '', kind: 0, roleIds: ['b'.repeat(32)] }]);
    core.set(`roles:${cid}`, [{ id: 'a'.repeat(32), name: 'higher', position: 5, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 }, { id: 'b'.repeat(32), name: 'lower', position: 4, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 }]);
    const confirm = async () => true;
    const result = await builtinHandlers.kick!({ commandId: 'kick', args: { user: target } }, { ...context, client: core, confirm });
    expect(result.status).toBe('failure');
    expect(core.callsOf('kickMember')).toEqual([]);
  });

  it('does not grant @everyone or a role at the caller rank', async () => {
    const core = new FakeClient();
    const cid = context.binding.communityId!;
    const target = '66'.repeat(16);
    core.set('communities', [{ id: cid, name: 'Town', owner: '77'.repeat(16) }]);
    core.set(`permissions:${cid}`, { loaded: true, top: 4, owner: false, manageCommunity: false, kickMembers: false, banMembers: false, moderateMembers: false, manageRoles: true, manageChannels: true, createInvite: false, everyoneId: '88'.repeat(16), overwritesLoaded: true });
    core.set(`roles:${cid}`, [{ id: 'a'.repeat(32), name: 'equal', position: 4, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 0 }]);
    core.set(`members:${cid}`, [{ userId: target, username: 'target', display: '', kind: 0, roleIds: [] }, { userId: context.selfId!, username: 'self', display: '', kind: 0, roleIds: [] }]);
    const result = await builtinHandlers['role add']!({ commandId: 'role add', args: { user: target, role: 'a'.repeat(32) } }, contextFor(core));
    expect(result.status).toBe('failure');
    expect(core.callsOf('grantRole')).toEqual([]);
  });
  it('keeps DM pin behavior available when community permission bits do not exist', async () => {
    const core = new FakeClient();
    const result = await builtinHandlers.pin!({ commandId: 'pin', args: { message } }, {
      ...context, client: core, binding: { communityId: null, channelId: context.binding.channelId }, items: [ownMessage],
    });
    expect(result.status).toBe('success');
    expect(core.callsOf('pin')).toHaveLength(1);
  });

  it('unpins the exact loaded message when Pin Messages is granted', async () => {
    const core = new FakeClient();
    const result = await builtinHandlers.unpin!({ commandId: 'unpin', args: { message } }, contextWithBinding({ bits: PERM.pinMessages }, { client: core, items: [{ ...ownMessage, pinned: true }] }));
    expect(result).toMatchObject({ status: 'success', message: 'Message unpinned.' });
    expect(core.callsOf('pin')).toEqual([{ m: 'pin', channelId: context.binding.channelId, msgId: message, on: false }]);
  });

  it('forwards each formatting handler as a plain type-0 send to the current channel or thread', async () => {
    const core = new FakeClient();
    const threadId = 'ab'.repeat(16);
    const cases: { id: string; args: Record<string, string>; text: string }[] = [
      { id: 'shrug', args: {}, text: '¯\\_(ツ)_/¯' },
      { id: 'tableflip', args: {}, text: '(╯°□°)╯︵ ┻━┻' },
      { id: 'unflip', args: {}, text: '┬─┬ ノ( ゜-゜ノ)' },
      { id: 'code', args: { language: 'ts', text: 'let n = 1' }, text: '```ts\nlet n = 1\n```' },
    ];
    for (const testCase of cases) {
      const result = await builtinHandlers[testCase.id]!({ commandId: testCase.id, args: testCase.args }, {
        ...context, client: core, binding: { ...context.binding, threadId },
      });
      expect(result.status).toBe('success');
      expect(core.callsOf('send').at(-1)).toEqual({ m: 'send', channelId: context.binding.channelId, threadId, text: testCase.text });
    }
  });

  it('routes navigation and search through explicit production callbacks', async () => {
    const core = new FakeClient();
    core.handler = async command => command.m === 'openDm' ? { channelId: 'bc'.repeat(16) } : null;
    const navigated: unknown[] = [];
    const searched: unknown[] = [];
    const result = await builtinHandlers.dm!({ commandId: 'dm', args: { user: 'cd'.repeat(16) } }, {
      ...context, client: core, navigate: route => navigated.push(route), openSearch: (query, scope) => searched.push({ query, scope }),
    });
    expect(result.status).toBe('success');
    expect(navigated).toEqual([{ name: 'dm', channelId: 'bc'.repeat(16) }]);
    expect(core.callsOf('openDm')).toEqual([{ m: 'openDm', userId: 'cd'.repeat(16) }]);
    const searchedResult = await builtinHandlers.search!({ commandId: 'search', args: { query: 'hello', scope: 'community' } }, { ...context, openSearch: (query, scope) => searched.push({ query, scope }) });
    expect(searchedResult).toMatchObject({ status: 'success' });
    expect(searched).toContainEqual({ query: 'hello', scope: 'community' });
  });

  it('updates only the topic field and opens a loaded thread root', async () => {
    const core = new FakeClient();
    const root = 'de'.repeat(16);
    const updated = await builtinHandlers.topic!({ commandId: 'topic', args: { text: 'weekly plan' } }, contextWithBinding({ bits: PERM.manageChannels }, { client: core }));
    expect(updated.status).toBe('success');
    expect(core.callsOf('updateChannel')).toEqual([{ m: 'updateChannel', channelId: context.binding.channelId, name: null, topic: 'weekly plan', parent: 'keep', slowmode: null }]);
    const opened: string[] = [];
    const threaded = await builtinHandlers.thread!({ commandId: 'thread', args: { message: root } }, {
      ...context, items: [{ msgId: root, seq: '4', state: 'ok' } as never], openThread: id => opened.push(id),
    });
    expect(threaded.status).toBe('success');
    expect(opened).toEqual([root]);
  });

  it('runs a kick only after confirmation and reflects the accepted worker mutation', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, kick: true });
    const target = '66'.repeat(16), cid = context.binding.communityId!;
    core.handler = async command => {
      if (command.m === 'kickMember') core.set(`members:${cid}`, core.get(`members:${cid}`)!.filter(row => row.userId !== target));
      return null;
    };
    const result = await builtinHandlers.kick!({ commandId: 'kick', args: { user: target } }, { ...context, client: core });
    expect(result.status).toBe('success');
    expect(core.get(`members:${cid}`)?.some(row => row.userId === target)).toBe(false);
    expect(core.callsOf('kickMember')).toEqual([{ m: 'kickMember', communityId: cid, userId: target }]);
  });

  it('rechecks moderation permission after confirmation and makes no call if it changed', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, kick: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16);
    const confirm = async () => { core.set(`permissions:${cid}`, { ...core.get(`permissions:${cid}`)!, kickMembers: false }); return true; };
    const result = await builtinHandlers.kick!({ commandId: 'kick', args: { user: target } }, { ...context, client: core, confirm });
    expect(result.status).toBe('failure');
    expect(core.callsOf('kickMember')).toEqual([]);
  });

  it('rejects ban reasons containing control characters before confirmation or mutation', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, ban: true });
    const confirm = async () => { throw new Error('confirmation should not open'); };
    const result = await builtinHandlers.ban!({ commandId: 'ban', args: { user: '66'.repeat(16), reason: 'bad\u0001reason' } }, { ...context, client: core, confirm });
    expect(result.status).toBe('failure');
    expect(core.callsOf('banMember')).toEqual([]);
  });

  it.each([
    ['ban', { user: '66'.repeat(16), duration: '1d', reason: 'review' }, 'banMember'],
    ['timeout', { user: '66'.repeat(16), duration: '10m' }, 'setMemberTimeout'],
    ['warn', { user: '66'.repeat(16), reason: 'review' }, 'warnMember'],
  ] as const)('%s forwards its confirmed mutation to the authorized worker method', async (id, args, method) => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, kick: true, ban: true, timeout: true });
    const result = await builtinHandlers[id]!({ commandId: id, args: { ...args } }, { ...context, client: core });
    expect(result.status).toBe('success');
    expect(core.calls.some(call => call.m === method)).toBe(true);
  });

  it.each([
    ['kick', { user: '66'.repeat(16) }, 'kickMember'],
    ['ban', { user: '66'.repeat(16), duration: '1d', reason: 'review' }, 'banMember'],
    ['unban', { user: '66'.repeat(16) }, 'unbanMember'],
    ['timeout', { user: '66'.repeat(16), duration: '10m' }, 'setMemberTimeout'],
    ['untimeout', { user: '66'.repeat(16) }, 'clearMemberTimeout'],
    ['warn', { user: '66'.repeat(16), reason: 'review' }, 'warnMember'],
  ] as const)('%s cancellation leaves the protected mutation untouched', async (id, args, method) => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, kick: true, ban: true, timeout: true });
    const cid = context.binding.communityId!;
    core.set(`bans:${cid}`, [{ userId: '66'.repeat(16), name: 'target', reason: '', byUser: context.selfId!, created: 1, expires: null }]);
    core.handler = async command => command.m === 'getMemberTimeout' ? '2000000000' : null;
    const result = await builtinHandlers[id]!({ commandId: id, args: { ...args } }, { ...context, client: core, confirm: async () => false });
    expect(result).toMatchObject({ status: 'failure', message: 'Cancelled.' });
    expect(core.calls.some(call => call.m === method)).toBe(false);
  });

  it('loads current bans before a confirmed unban and mutates the selected stable ID', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, ban: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16);
    core.set(`bans:${cid}`, [{ userId: target, name: 'target', reason: '', byUser: context.selfId!, created: 1, expires: null }]);
    core.handler = async command => {
      if (command.m === 'unbanMember') core.set(`bans:${cid}`, []);
      return null;
    };
    const result = await builtinHandlers.unban!({ commandId: 'unban', args: { user: target } }, { ...context, client: core });
    expect(result.status).toBe('success');
    expect(core.callsOf('loadBans')).toEqual([{ m: 'loadBans', communityId: cid }, { m: 'loadBans', communityId: cid }]);
    expect(core.callsOf('unbanMember')).toEqual([{ m: 'unbanMember', communityId: cid, userId: target }]);
    expect(core.get(`bans:${cid}`)).toEqual([]);
  });

  it('cancels a role removal without issuing a mutation', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, manageRoles: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16), roleId = 'aa'.repeat(16);
    core.set(`roles:${cid}`, [...core.get(`roles:${cid}`)!, { id: roleId, name: 'Helper', position: 2, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 0 }]);
    core.set(`members:${cid}`, core.get(`members:${cid}`)!.map(row => row.userId === target ? { ...row, roleIds: [roleId] } : row));
    const result = await builtinHandlers['role remove']!({ commandId: 'role remove', args: { user: target, role: roleId } }, { ...context, client: core, confirm: async () => false });
    expect(result.status).toBe('failure');
    expect(core.callsOf('revokeRole')).toEqual([]);
  });

  it('rejects @everyone and roles whose permissions the caller does not hold', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, manageRoles: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16), everyone = '88'.repeat(16), tooPowerful = 'ab'.repeat(16);
    core.set(`roles:${cid}`, [...core.get(`roles:${cid}`)!,
      { id: everyone, name: '@everyone', position: 0, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 2 },
      { id: tooPowerful, name: 'Can kick', position: 2, allow: PERM.kickMembers, deny: 0, color: 0, hoist: false, mentionable: false, members: 0 }]);
    const everybody = await builtinHandlers['role add']!({ commandId: 'role add', args: { user: target, role: everyone } }, contextFor(core));
    const powerful = await builtinHandlers['role add']!({ commandId: 'role add', args: { user: target, role: tooPowerful } }, contextFor(core));
    expect(everybody.status).toBe('failure');
    expect(powerful.status).toBe('failure');
    expect(core.callsOf('grantRole')).toEqual([]);
  });

  it('grants a rank-safe role and observes the member slice update', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, manageRoles: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16), roleId = 'aa'.repeat(16);
    core.set(`roles:${cid}`, [...core.get(`roles:${cid}`)!, { id: roleId, name: 'Helper', position: 2, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 0 }]);
    core.handler = async command => {
      if (command.m === 'grantRole') core.set(`members:${cid}`, core.get(`members:${cid}`)!.map(row => row.userId === target ? { ...row, roleIds: [...row.roleIds, roleId] } : row));
      return null;
    };
    const result = await builtinHandlers['role add']!({ commandId: 'role add', args: { user: target, role: roleId } }, { ...context, client: core });
    expect(result.status).toBe('success');
    expect(core.get(`members:${cid}`)?.find(row => row.userId === target)?.roleIds).toContain(roleId);
    expect(core.callsOf('grantRole')).toEqual([{ m: 'grantRole', communityId: cid, userId: target, roleId }]);
  });

  it('removes a rank-safe role after confirmation with exact target IDs', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, manageRoles: true });
    const cid = context.binding.communityId!, target = '66'.repeat(16), roleId = 'aa'.repeat(16);
    core.set(`roles:${cid}`, [...core.get(`roles:${cid}`)!, { id: roleId, name: 'Helper', position: 2, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 }]);
    core.set(`members:${cid}`, core.get(`members:${cid}`)!.map(row => row.userId === target ? { ...row, roleIds: [roleId] } : row));
    let confirmed = 0;
    core.handler = async command => {
      if (command.m === 'revokeRole') core.set(`members:${cid}`, core.get(`members:${cid}`)!.map(row => row.userId === target ? { ...row, roleIds: [] } : row));
      return null;
    };
    const outcome = await builtinHandlers['role remove']!({ commandId: 'role remove', args: { user: target, role: roleId } }, { ...context, client: core, confirm: async () => { confirmed++; return true; } });
    expect(outcome).toMatchObject({ status: 'success', message: 'Helper removed from target.' });
    expect(confirmed).toBe(1);
    expect(core.callsOf('revokeRole')).toEqual([{ m: 'revokeRole', communityId: cid, userId: target, roleId }]);
    expect(core.get(`members:${cid}`)?.find(row => row.userId === target)?.roleIds).toEqual([]);
  });

  it('lists and grants only roles returned by the self-role service', async () => {
    const core = new FakeClient();
    const cid = context.binding.communityId!, roleId = 'ef'.repeat(16);
    core.handler = async command => command.m === 'listSelfRoles' ? [{ id: roleId, name: 'Reader', selfSelected: false }] : null;
    const listed = await builtinHandlers['selfrole list']!({ commandId: 'selfrole list', args: {} }, { ...context, client: core });
    const added = await builtinHandlers['selfrole add']!({ commandId: 'selfrole add', args: { role: roleId } }, { ...context, client: core });
    expect(listed.message).toContain('Reader');
    expect(added.status).toBe('success');
    expect(core.callsOf('selectSelfRole')).toEqual([{ m: 'selectSelfRole', communityId: cid, roleId, requestId: context.requestId, enabled: true }]);
  });

  it('removes only a currently selected self-role using the stable role ID and attempt ID', async () => {
    const core = new FakeClient();
    const cid = context.binding.communityId!, roleId = 'ef'.repeat(16);
    core.handler = async command => command.m === 'listSelfRoles' ? [{ id: roleId, name: 'Reader', selfSelected: true }] : null;
    const outcome = await builtinHandlers['selfrole remove']!({ commandId: 'selfrole remove', args: { role: roleId } }, { ...context, client: core });
    expect(outcome).toMatchObject({ status: 'success', message: 'Reader removed.' });
    expect(core.callsOf('selectSelfRole')).toEqual([{ m: 'selectSelfRole', communityId: cid, roleId, requestId: context.requestId, enabled: false }]);
  });

  it('clears an existing timeout with the confirmed stable user ID', async () => {
    const core = authorizedCore({ targetRolePosition: 1, myRolePosition: 4, timeout: true });
    const target = '66'.repeat(16), cid = context.binding.communityId!;
    core.handler = async command => command.m === 'getMemberTimeout' ? '2000000000' : null;
    const outcome = await builtinHandlers.untimeout!({ commandId: 'untimeout', args: { user: target } }, { ...context, client: core });
    expect(outcome.status).toBe('success');
    expect(core.callsOf('getMemberTimeout')).toEqual([{ m: 'getMemberTimeout', communityId: cid, userId: target }]);
    expect(core.callsOf('clearMemberTimeout')).toEqual([{ m: 'clearMemberTimeout', communityId: cid, userId: target, requestId: context.requestId }]);
  });

  it('leaves the live voice call and reports the outcome', async () => {
    const leave = vi.fn();
    const outcome = await builtinHandlers.leave!({ commandId: 'leave', args: {} }, { ...context, getCall: () => ({ channelId: '55'.repeat(16), leave } as never) });
    expect(outcome).toMatchObject({ status: 'success', message: 'Left voice.' });
    expect(leave).toHaveBeenCalledOnce();
  });

  it('opens invite and moderation history through the focused host callbacks', async () => {
    const openInvite = vi.fn(async () => true), openModerationLog = vi.fn();
    const invite = await builtinHandlers.invite!({ commandId: 'invite', args: {} }, contextWithBinding({ bits: PERM.createInvite }, { openInvite }));
    const modlog = await builtinHandlers.modlog!({ commandId: 'modlog', args: {} }, contextWithBinding({ bits: PERM.viewAuditLog }, { openModerationLog }));
    expect(invite).toMatchObject({ status: 'success', message: 'Invite created and shown privately.' });
    expect(openInvite).toHaveBeenCalledOnce();
    expect(modlog).toMatchObject({ status: 'success', message: 'Moderation history opened.' });
    expect(openModerationLog).toHaveBeenCalledOnce();
  });

  it('has a real handler registered for every built-in catalog entry', () => {
    const ids = COMMANDS.filter(command => command.provider === 'builtin').map(command => command.id);
    expect(ids.filter(id => builtinHandlers[id] === undefined)).toEqual([]);
  });
});


function authorizedCore(over: { targetRolePosition: number; myRolePosition: number; kick?: boolean; ban?: boolean; timeout?: boolean; manageRoles?: boolean }): FakeClient {
  const core = new FakeClient();
  const cid = context.binding.communityId!, target = '66'.repeat(16), owner = '77'.repeat(16);
  core.set('communities', [{ id: cid, name: 'Town', owner }]);
  core.set(`permissions:${cid}`, { loaded: true, top: over.myRolePosition, owner: false, manageCommunity: false,
    kickMembers: over.kick ?? false, banMembers: over.ban ?? false, moderateMembers: over.timeout ?? false,
    manageRoles: over.manageRoles ?? false, manageChannels: false, createInvite: false, everyoneId: '88'.repeat(16), overwritesLoaded: true });
  const targetRole = 'a1'.repeat(16), ownRole = 'a2'.repeat(16);
  core.set(`roles:${cid}`, [
    { id: targetRole, name: 'Target', position: over.targetRolePosition, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 },
    { id: ownRole, name: 'Self', position: over.myRolePosition, allow: 0, deny: 0, color: 0, hoist: false, mentionable: false, members: 1 },
  ]);
  core.set(`members:${cid}`, [
    { userId: target, username: 'target', display: '', kind: 0, roleIds: [targetRole] },
    { userId: context.selfId!, username: 'self', display: '', kind: 0, roleIds: [ownRole] },
  ]);
  return core;
}

function contextFor(core: FakeClient): CommandExecutionContext {
  return { ...context, client: core };
}
function contextWithBinding(over: Partial<CommandExecutionContext['binding']>, other: Partial<CommandExecutionContext> = {}): CommandExecutionContext {
  const binding = { ...context.binding, ...over };
  return { ...context, ...other, binding, getCurrentBinding: () => binding };
}
