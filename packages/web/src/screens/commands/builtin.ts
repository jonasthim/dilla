import { PERM, type CommandContext as Binding, type CommandInvocation, type CommandResult, type TimelineItem } from '@dilla/client-core';
import type { CommandExecutionContext, CommandHandler, CommandProviderHandlers } from './command-types.ts';

const result = (status: CommandResult['status'], message: string, isPrivate = true): CommandResult => ({ status, message, private: isPrivate });
const success = (message: string, isPrivate = true) => result('success', message, isPrivate);
const failure = (message: string) => result('failure', message);
const targetThread = (binding: Readonly<Binding>) => binding.threadId === undefined ? {} : { threadId: binding.threadId };
const encodedSize = (value: string) => new TextEncoder().encode(value).length;

async function publish(context: CommandExecutionContext, text: string, replyTo?: string): Promise<CommandResult> {
  if (text.trim() === '') return failure('Message cannot be empty.');
  const encoded = context.encodeMessage(text);
  if (encodedSize(encoded) > 4000) return failure('Message exceeds the 4000 byte limit.');
  try {
    await context.client.call({ m: 'send', channelId: context.binding.channelId, ...targetThread(context.binding), text: encoded,
      ...(replyTo === undefined ? {} : { replyTo }) });
    return success('Sent.', false);
  } catch {
    return result('uncertain', 'The send result is uncertain. Retry this command to check the same request.', true);
  }
}

function exactMessage(context: CommandExecutionContext, id: string): TimelineItem | undefined {
  return context.items.find(item => item.msgId === id && item.state === 'ok' && item.seq !== null);
}

const handler = (fn: (invocation: CommandInvocation, context: CommandExecutionContext) => Promise<CommandResult> | CommandResult): CommandHandler => async (invocation, context) => {
  try { return await fn(invocation, context); }
  catch (error) { return failure(error instanceof Error ? error.message : 'Command failed.'); }
};

const entries: Record<string, CommandHandler> = {
  help: handler(async invocation => success(invocation.args.command ? `Help for ${invocation.args.command} is available in the command picker.` : 'Choose a command from the searchable command picker.')),
  me: handler((invocation, context) => publish(context, `_${invocation.args.text}_`)),
  shrug: handler((invocation, context) => publish(context, `¯\\_(ツ)_/¯${invocation.args.text ? ` ${invocation.args.text}` : ''}`)),
  tableflip: handler((invocation, context) => publish(context, `(╯°□°)╯︵ ┻━┻${invocation.args.text ? ` ${invocation.args.text}` : ''}`)),
  unflip: handler((invocation, context) => publish(context, `┬─┬ ノ( ゜-゜ノ)${invocation.args.text ? ` ${invocation.args.text}` : ''}`)),
  code: handler((invocation, context) => {
    const language = invocation.args.language.trim();
    if (!/^[\w+-]{1,32}$/.test(language)) return failure('Language must be 1 to 32 letters, digits, underscores, plus signs, or hyphens.');
    if (invocation.args.text.includes('```')) return failure('Code text cannot contain a closing code fence.');
    return publish(context, `\`\`\`${language}\n${invocation.args.text}\n\`\`\``);
  }),
  giphy: handler((invocation, context) => {
    if (context.binding.communityId === null) return failure('GIF search is available only in a community channel.');
    context.openGif(invocation.args.query ?? '');
    return success('GIF search opened.');
  }),
  invite: handler(async (_invocation, context) => {
    if (context.binding.communityId === null || context.binding.bits === undefined || (context.binding.bits & PERM.createInvite) === 0) return failure('You cannot create invites here.');
    const created = await context.openInvite();
    return created ? success('Invite created and shown privately.') : failure('Invite creation cancelled.');
  }),
  join: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const target = context.client.get(`channels:${communityId}`)?.find(channel => channel.id === invocation.args['voice-channel'] || channel.id === invocation.args.channel);
    if (target?.kind !== 1) return failure('Choose an accessible voice channel.');
    context.call.join(target.id);
    return await waitForVoiceJoin(context, target.id);
  }),
  dm: handler(async (invocation, context) => {
    const value = await context.client.call({ m: 'openDm', userId: invocation.args.user });
    const channelId = typeof value === 'object' && value !== null ? (value as { channelId?: unknown }).channelId : null;
    if (typeof channelId !== 'string') return failure('Could not open that direct message.');
    context.navigate({ name: 'dm', channelId });
    return success('Direct message opened.');
  }),
  search: handler((invocation, context) => {
    const scopeRaw = invocation.args.scope ?? 'channel';
    if (!['channel', 'community', 'all'].includes(scopeRaw)) return failure('Scope must be channel, community, or all.');
    const scope = scopeRaw as 'channel' | 'community' | 'all';
    if (scope === 'community' && context.binding.communityId === null) return failure('Community search is unavailable here.');
    context.openSearch(invocation.args.query, scope);
    return success('Search opened.');
  }),
  topic: handler(async (invocation, context) => {
    if (context.binding.communityId === null || context.binding.bits === undefined || (context.binding.bits & PERM.manageChannels) === 0) return failure('You cannot manage this channel.');
    await context.client.call({ m: 'updateChannel', channelId: context.binding.channelId, name: null, topic: invocation.args.text, parent: 'keep', slowmode: null });
    return success('Channel topic updated.');
  }),
  thread: handler((invocation, context) => {
    const item = exactMessage(context, invocation.args.message);
    if (context.binding.communityId === null || item?.msgId === null || item === undefined) return failure('That message is not available in this channel.');
    context.openThread(item.msgId);
    return success('Thread opened.');
  }),
  reply: handler((invocation, context) => {
    if (exactMessage(context, invocation.args.message) === undefined) return failure('That message is not available in this conversation.');
    return publish(context, invocation.args.text, invocation.args.message);
  }),
  edit: handler(async (invocation, context) => {
    const item = exactMessage(context, invocation.args.message);
    if (item === undefined || item.senderUser !== context.selfId || item.msgId === null) return failure('You can edit only your own loaded message.');
    if (encodedSize(invocation.args.text) > 4000) return failure('Message exceeds the 4000 byte limit.');
    await context.client.call({ m: 'editMessage', channelId: context.binding.channelId, msgId: item.msgId, text: invocation.args.text });
    return success('Message edited.', false);
  }),
  delete: handler(async (invocation, context) => {
    const item = exactMessage(context, invocation.args.message);
    if (item === undefined || item.msgId === null) return failure('That message is not available in this conversation.');
    if (!await context.confirm('Delete this message?', item.senderUser === context.selfId ? 'This permanently deletes your message.' : `Remove this message from everyone? Reason: ${invocation.args.reason?.trim() || 'Removed by a moderator.'}`)) return failure('Cancelled.');
    if (item.senderUser === context.selfId) {
      await context.client.call({ m: 'deleteMessage', channelId: context.binding.channelId, msgId: item.msgId, seq: item.seq! });
    } else {
      if (context.binding.bits === undefined || (context.binding.bits & PERM.manageMessages) === 0 || !invocation.args.reason?.trim()) return failure('Deleting another person’s message requires Manage Messages and a reason.');
      await context.client.call({ m: 'moderateRemoveMessage', channelId: context.binding.channelId, msgId: item.msgId, seq: item.seq!, reason: invocation.args.reason?.trim() || 'Removed by a moderator.', excerpt: item.body.slice(0, 240) });
    }
    return success('Message deleted.', false);
  }),
  pin: handler(async (invocation, context) => pinMessage(invocation, context, true)),
  unpin: handler(async (invocation, context) => pinMessage(invocation, context, false)),
  leave: handler(async (_invocation, context) => {
    if (context.call.channelId === null) return failure('You are not in a voice call.');
    context.call.leave();
    return success('Left voice.');
  }),
  mute: handler(async (_invocation, context) => setVoice(context, true, context.call.selfDeafened)),
  unmute: handler(async (_invocation, context) => setVoice(context, false, context.call.selfDeafened)),
  deafen: handler(async (_invocation, context) => setVoice(context, true, true)),
  undeafen: handler(async (_invocation, context) => setVoice(context, context.call.selfMuted, false)),
  kick: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const member = memberById(context, invocation.args.user);
    if (!member) return failure('That member is no longer available.');
    if (!await context.confirm(`Kick ${member.name}?`, `This removes ${member.name} from this community. Confirm to continue.`)) return failure('Cancelled.');
    await context.client.call({ m: 'kickMember', communityId, userId: member.userId });
    return success(`${member.name} was kicked.`);
  }),
  ban: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const member = memberById(context, invocation.args.user);
    if (!member) return failure('That member is no longer available.');
    const seconds = durationSeconds(invocation.args.duration ?? '1d');
    if (seconds !== null && (seconds < 3600 || seconds > 3_153_600_000)) return failure('Ban duration must be from 1h to 100y.');
    const reason = (invocation.args.reason ?? '').trim();
    if (new TextEncoder().encode(reason).length > 512) return failure('Reason must be at most 512 UTF-8 bytes.');
    if (!await context.confirm(`Ban ${member.name}?`, `Ban length: ${invocation.args.duration ?? '1d'}. ${reason || 'No reason supplied.'}`)) return failure('Cancelled.');
    await context.client.call({ m: 'banMember', communityId, userId: member.userId, reason, seconds });
    return success(`${member.name} was banned.`);
  }),
  unban: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    await context.client.call({ m: 'loadBans', communityId });
    const ban = context.client.get(`bans:${communityId}`)?.find(row => row.userId === invocation.args.user);
    if (!ban) return failure('That member is not currently banned.');
    if (!await context.confirm(`Unban ${ban.name}?`, 'This restores the member’s ability to join the community.')) return failure('Cancelled.');
    await context.client.call({ m: 'unbanMember', communityId, userId: ban.userId });
    return success(`${ban.name} was unbanned.`);
  }),
  timeout: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const member = memberById(context, invocation.args.user);
    const seconds = durationSeconds(invocation.args.duration);
    if (!member) return failure('That member is no longer available.');
    if (seconds === null || seconds < 60 || seconds > 2_419_200) return failure('Timeout duration must be from 1m to 28d.');
    if (!await context.confirm(`Timeout ${member.name}?`, `Restrict this member for ${invocation.args.duration}.`)) return failure('Cancelled.');
    await context.client.call({ m: 'setMemberTimeout', communityId, userId: member.userId, requestId: context.requestId, expires: String(Math.floor(Date.now() / 1000) + seconds) });
    return success(`${member.name} was timed out.`);
  }),
  untimeout: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const member = memberById(context, invocation.args.user);
    if (!member) return failure('That member is no longer available.');
    const expires = await context.client.call({ m: 'getMemberTimeout', communityId, userId: member.userId });
    if (typeof expires !== 'string') return failure(`${member.name} is not timed out.`);
    if (!await context.confirm(`Remove ${member.name}’s timeout?`, 'This restores the member’s ability to send messages.')) return failure('Cancelled.');
    await context.client.call({ m: 'clearMemberTimeout', communityId, userId: member.userId, requestId: context.requestId });
    return success(`${member.name}’s timeout was removed.`);
  }),
  warn: handler(async (invocation, context) => {
    const communityId = requireCommunity(context);
    const member = memberById(context, invocation.args.user);
    const reason = invocation.args.reason.trim();
    if (!member) return failure('That member is no longer available.');
    if (reason.length === 0 || new TextEncoder().encode(reason).length > 512 || /[\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f-\u009f]/.test(reason)) return failure('Enter a reason of at most 512 UTF-8 bytes without control characters.');
    if (!await context.confirm(`Warn ${member.name}?`, reason)) return failure('Cancelled.');
    await context.client.call({ m: 'warnMember', communityId, userId: member.userId, requestId: context.requestId, reason });
    return success(`${member.name} was warned.`);
  }),
  'role add': handler(async (invocation, context) => updateMemberRole(invocation, context, true)),
  'role remove': handler(async (invocation, context) => updateMemberRole(invocation, context, false)),
  'selfrole list': handler(async (_invocation, context) => {
    const communityId = requireCommunity(context);
    const rows = await context.client.call({ m: 'listSelfRoles', communityId }) as { id: string; name: string; selfSelected: boolean }[];
    return success(rows.length ? rows.map(row => `${row.selfSelected ? '✓' : '○'} ${row.name}`).join(' · ') : 'No self-assignable roles are available.');
  }),
  'selfrole add': handler(async (invocation, context) => selfRole(invocation, context, true)),
  'selfrole remove': handler(async (invocation, context) => selfRole(invocation, context, false)),
  modlog: handler((_invocation, context) => {
    if (context.binding.communityId === null) return failure('Moderation history needs a community.');
    context.openModerationLog();
    return success('Moderation history opened.');
  }),
};



function waitForVoiceJoin(context: CommandExecutionContext, channelId: string): Promise<CommandResult> {
  const read = () => context.client.get('call');
  const current = read();
  if (current?.channelId === channelId && (current.phase === 'in' || current.phase === 'paused')) return Promise.resolve(success('Joined voice.'));
  if (current?.channelId === channelId && ['failed', 'blocked', 'removed'].includes(current.phase)) return Promise.resolve(failure(`Could not join voice (${current.error?.code ?? current.phase}).`));
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: CommandResult) => { if (settled) return; settled = true; clearTimeout(timer); unsubscribe(); resolve(value); };
    const check = () => {
      const state = read();
      if (!state || state.channelId !== channelId) return;
      if (state.phase === 'in' || state.phase === 'paused') finish(success('Joined voice.'));
      else if (['failed', 'blocked', 'removed'].includes(state.phase)) finish(failure(`Could not join voice (${state.error?.code ?? state.phase}).`));
    };
    const unsubscribe = context.client.subscribe('call', check);
    const timer = window.setTimeout(() => finish(result('uncertain', 'Voice join is still pending. Check the call before retrying.', true)), 35_000);
    check();
  });
}

function requireCommunity(context: CommandExecutionContext): string {
  if (context.binding.communityId === null) throw new Error('This command needs a community channel.');
  return context.binding.communityId;
}
function memberById(context: CommandExecutionContext, id: string): { userId: string; name: string } | undefined {
  const communityId = context.binding.communityId;
  if (communityId === null) return undefined;
  const row = context.client.get(`members:${communityId}`)?.find(member => member.userId === id);
  return row ? { userId: row.userId, name: row.display || row.username } : undefined;
}
function durationSeconds(value: string): number | null {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)];
  if (parts.length === 0 || parts.map(part => part[0]).join('') !== value.trim()) return null;
  const scale: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Math.floor(parts.reduce((sum, part) => sum + Number(part[1]) * scale[part[2]], 0));
}
async function updateMemberRole(invocation: CommandInvocation, context: CommandExecutionContext, add: boolean): Promise<CommandResult> {
  const communityId = requireCommunity(context);
  const member = memberById(context, invocation.args.user);
  const role = context.client.get(`roles:${communityId}`)?.find(row => row.id === invocation.args.role);
  if (!member || !role) return failure('That member or role is no longer available.');
  if (!add && !await context.confirm(`Remove ${role.name} from ${member.name}?`, 'This changes the member’s roles.')) return failure('Cancelled.');
  await context.client.call({ m: add ? 'grantRole' : 'revokeRole', communityId, userId: member.userId, roleId: role.id });
  return success(add ? `${role.name} added to ${member.name}.` : `${role.name} removed from ${member.name}.`);
}
async function selfRole(invocation: CommandInvocation, context: CommandExecutionContext, enabled: boolean): Promise<CommandResult> {
  const communityId = requireCommunity(context);
  const rows = await context.client.call({ m: 'listSelfRoles', communityId }) as { id: string; name: string; selfSelected: boolean }[];
  const role = rows.find(row => row.id === invocation.args.role);
  if (!role) return failure('That role is not currently self-assignable.');
  if (role.selfSelected === enabled) return success(enabled ? `You already have ${role.name}.` : `You do not have ${role.name}.`);
  await context.client.call({ m: 'selectSelfRole', communityId, roleId: role.id, requestId: context.requestId, enabled });
  return success(enabled ? `${role.name} added.` : `${role.name} removed.`);
}

async function pinMessage(invocation: CommandInvocation, context: CommandExecutionContext, on: boolean): Promise<CommandResult> {
  const item = exactMessage(context, invocation.args.message);
  if (item === undefined || item.msgId === null) return failure('That message is not available in this channel.');
  if (context.binding.bits === undefined || (context.binding.bits & PERM.manageMessages) === 0) return failure('You cannot pin messages here.');
  if (item.pinned === on) return success(on ? 'Message is already pinned.' : 'Message is already unpinned.');
  await context.client.call({ m: 'pin', channelId: context.binding.channelId, msgId: item.msgId, on });
  return success(on ? 'Message pinned.' : 'Message unpinned.', false);
}

function setVoice(context: CommandExecutionContext, muted: boolean, deafened: boolean): CommandResult {
  if (context.call.channelId === null) return failure('Join a voice call first.');
  if (context.call.selfDeafened !== deafened) context.call.toggleDeafen();
  if (context.call.selfMuted !== muted) context.call.toggleMute();
  return success('Voice settings updated.');
}

export const builtinHandlers: CommandProviderHandlers = Object.freeze(entries);
