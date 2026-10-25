/** Typed, UI-independent command catalog and slash argument utilities. */

export type CommandArgumentKind =
  | 'text' | 'user' | 'channel' | 'role' | 'message' | 'queue-item' | 'poll'
  | 'announcement' | 'reminder' | 'choice' | 'number' | 'duration' | 'time';

export interface CommandOption {
  name: string;
  kind: CommandArgumentKind;
  description: string;
  required: boolean;
  /** A free-text tail consumes all remaining positional tokens. */
  freeText?: boolean;
  choices?: readonly string[];
  min?: number;
  max?: number;
}

export interface CommandDefinition {
  /** Canonical, space-separated command path. */
  id: string;
  description: string;
  scope: 'any' | 'community';
  handler: string;
  permissionBit?: number;
  options: readonly CommandOption[];
}

export interface CommandContext {
  communityId: string | null;
  channelId: string;
  threadId?: string;
  voiceChannelId?: string | null;
  bits?: number;
}

export interface CommandInvocation {
  commandId: string;
  args: Record<string, string>;
}

export interface CommandResult {
  status: 'pending' | 'success' | 'failure' | 'uncertain';
  message?: string;
  private: boolean;
}

export interface ArgumentIssue {
  code: 'missing' | 'unexpected' | 'empty' | 'invalid' | 'duplicate';
  name: string;
  message: string;
}

export interface CommandValidation {
  valid: boolean;
  issues: ArgumentIssue[];
  args: Record<string, string>;
}

type OptionSeed = Pick<CommandOption, 'name' | 'kind' | 'required'> & Partial<Pick<CommandOption, 'description' | 'freeText' | 'choices' | 'min' | 'max'>>;
const o = (name: string, kind: CommandArgumentKind, required = true, extra: Partial<CommandOption> = {}): OptionSeed => ({ name, kind, required, ...extra });
const text = (name = 'text', required = true, freeText = true): OptionSeed => o(name, 'text', required, { freeText });
const entity = (name: string, kind: CommandArgumentKind, required = true): OptionSeed => o(name, kind, required);
const choice = (name: string, choices: readonly string[], required = true): OptionSeed => o(name, 'choice', required, { choices });

const seeds: Array<{ id: string; description: string; scope?: 'any' | 'community'; permissionBit?: number; options?: OptionSeed[] }> = [
  { id: 'help', description: 'Show command help', scope: 'any', options: [o('command', 'text', false)] },
  { id: 'me', description: 'Send an action message', options: [text()] },
  { id: 'shrug', description: 'Send a shrug', options: [text('text', false)] },
  { id: 'tableflip', description: 'Flip a table', options: [text('text', false)] },
  { id: 'unflip', description: 'Put a table back', options: [text('text', false)] },
  { id: 'code', description: 'Send a code block', options: [o('language', 'text'), text()] },
  { id: 'giphy', description: 'Find a GIF', options: [text('query', false)] },
  { id: 'dm', description: 'Open a direct message', scope: 'any', options: [entity('user', 'user')] },
  { id: 'invite', description: 'Create a community invite', permissionBit: 1 << 11 },
  { id: 'search', description: 'Search messages', options: [text('query'), o('scope', 'text', false)] },
  { id: 'topic', description: 'Set the channel topic', permissionBit: 1 << 14, options: [text()] },
  { id: 'thread', description: 'Start a thread from a message', options: [entity('message', 'message')] },
  { id: 'reply', description: 'Reply to a message', options: [entity('message', 'message'), text()] },
  { id: 'edit', description: 'Edit a message', options: [entity('message', 'message'), text()] },
  { id: 'delete', description: 'Delete a message', permissionBit: 1 << 2, options: [entity('message', 'message'), text('reason', false)] },
  { id: 'pin', description: 'Pin a message', permissionBit: 1 << 3, options: [entity('message', 'message')] },
  { id: 'unpin', description: 'Unpin a message', permissionBit: 1 << 3, options: [entity('message', 'message')] },
  { id: 'join', description: 'Join a voice channel', options: [entity('voice-channel', 'channel')] },
  { id: 'leave', description: 'Leave voice', scope: 'any' },
  { id: 'mute', description: 'Mute your microphone', scope: 'any' },
  { id: 'unmute', description: 'Unmute your microphone', scope: 'any' },
  { id: 'deafen', description: 'Deafen yourself', scope: 'any' },
  { id: 'undeafen', description: 'Stop deafening yourself', scope: 'any' },
  { id: 'play', description: 'Play a search result or URL', options: [text('query-or-url')] },
  { id: 'pause', description: 'Pause playback' },
  { id: 'resume', description: 'Resume playback' },
  { id: 'skip', description: 'Skip the current track' },
  { id: 'stop', description: 'Stop playback' },
  { id: 'queue', description: 'Show the music queue' },
  { id: 'nowplaying', description: 'Show the current track' },
  { id: 'seek', description: 'Seek within the current track', options: [o('position', 'time')] },
  { id: 'volume', description: 'Set playback volume', options: [o('level', 'number', true, { min: 0, max: 100 })] },
  { id: 'shuffle', description: 'Toggle queue shuffle', options: [choice('mode', ['on', 'off'])] },
  { id: 'repeat', description: 'Set repeat mode', options: [choice('mode', ['off', 'one', 'all'])] },
  { id: 'queue remove', description: 'Remove a queued track', options: [entity('item', 'queue-item')] },
  { id: 'queue move', description: 'Move a queued track', options: [entity('item', 'queue-item'), o('position', 'number', true, { min: 1 })] },
  { id: 'queue clear', description: 'Clear the music queue' },
  { id: 'music help', description: 'Show music command help' },
  { id: 'kick', description: 'Remove a member from the community', permissionBit: 1 << 12, options: [entity('user', 'user')] },
  { id: 'ban', description: 'Ban a member', permissionBit: 1 << 13, options: [entity('user', 'user'), o('duration', 'duration', false), text('reason', false)] },
  { id: 'unban', description: 'Unban a member', permissionBit: 1 << 13, options: [entity('user', 'user')] },
  { id: 'timeout', description: 'Temporarily restrict a member', permissionBit: 1 << 24, options: [entity('user', 'user'), o('duration', 'duration')] },
  { id: 'untimeout', description: 'Remove a member timeout', permissionBit: 1 << 24, options: [entity('user', 'user')] },
  { id: 'warn', description: 'Warn a member', permissionBit: 1 << 24, options: [entity('user', 'user'), text('reason')] },
  { id: 'modlog', description: 'Show moderation history', permissionBit: 1 << 17, options: [entity('user', 'user', false)] },
  { id: 'role add', description: 'Add a role to a member', permissionBit: 1 << 15, options: [entity('user', 'user'), entity('role', 'role')] },
  { id: 'role remove', description: 'Remove a role from a member', permissionBit: 1 << 15, options: [entity('user', 'user'), entity('role', 'role')] },
  { id: 'selfrole list', description: 'List self-assignable roles' },
  { id: 'selfrole add', description: 'Add one of your self-assignable roles', options: [entity('role', 'role')] },
  { id: 'selfrole remove', description: 'Remove one of your self-assignable roles', options: [entity('role', 'role')] },
  { id: 'rolepanel create', description: 'Create a role panel', permissionBit: 1 << 15 },
  { id: 'announcement list', description: 'List announcements' },
  { id: 'announcement create', description: 'Create an announcement', permissionBit: 1 << 16, options: [text()] },
  { id: 'announcement edit', description: 'Edit an announcement', permissionBit: 1 << 16, options: [entity('announcement', 'announcement'), text()] },
  { id: 'announcement delete', description: 'Delete an announcement', permissionBit: 1 << 16, options: [entity('announcement', 'announcement')] },
  { id: 'poll create', description: 'Create a poll', options: [text('question'), text('answers'), choice('multiple', ['on', 'off'], false), o('duration', 'duration', false)] },
  { id: 'poll vote', description: 'Vote in a poll', options: [entity('poll', 'poll'), entity('choice', 'choice')] },
  { id: 'poll results', description: 'Show poll results', options: [entity('poll', 'poll')] },
  { id: 'poll close', description: 'Close a poll', permissionBit: 1 << 2, options: [entity('poll', 'poll')] },
  { id: 'remind', description: 'Create a personal reminder', scope: 'any', options: [o('when', 'time'), text()] },
  { id: 'reminders list', description: 'List your reminders', scope: 'any' },
  { id: 'reminders cancel', description: 'Cancel a reminder', scope: 'any', options: [entity('reminder', 'reminder')] },
  { id: 'reminders dismiss', description: 'Dismiss a due reminder', scope: 'any', options: [entity('reminder', 'reminder')] },
];

function materialize(seed: (typeof seeds)[number]): CommandDefinition {
  return {
    id: seed.id,
    description: seed.description,
    scope: seed.scope ?? 'community',
    handler: seed.id.replaceAll(' ', '.'),
    ...(seed.permissionBit === undefined ? {} : { permissionBit: seed.permissionBit }),
    options: (seed.options ?? []).map((option) => ({ ...option, description: option.description ?? `${option.name} argument` })),
  };
}

export const COMMANDS: readonly CommandDefinition[] = Object.freeze(seeds.map(materialize));
const byId = new Map(COMMANDS.map((command) => [command.id, command]));
export const commandById = (id: string): CommandDefinition | undefined => byId.get(id);

/** Search names and descriptions; ties preserve catalog order. */
export function searchCommands(query: string, limit = 25): CommandDefinition[] {
  const needle = query.trim().toLowerCase();
  if (limit <= 0) return [];
  const ranked = COMMANDS.map((command, index) => {
    const id = command.id.toLowerCase();
    const description = command.description.toLowerCase();
    const rank = needle === '' ? 3 : id === needle ? 0 : id.startsWith(needle) ? 1 : id.includes(needle) || description.includes(needle) ? 2 : 4;
    return { command, index, rank };
  }).filter((entry) => entry.rank < 4);
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, Math.min(25, limit)).map((entry) => entry.command);
}

function issue(code: ArgumentIssue['code'], name: string, message: string): ArgumentIssue { return { code, name, message }; }

export function validateCommandArgs(command: CommandDefinition, input: Record<string, string>): CommandValidation {
  const issues: ArgumentIssue[] = [];
  const known = new Map(command.options.map((option) => [option.name, option]));
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    const option = known.get(name);
    if (!option) { issues.push(issue('unexpected', name, `Unexpected argument: ${name}`)); continue; }
    if (typeof value !== 'string') { issues.push(issue('invalid', name, `${name} must be text`)); continue; }
    if (value.trim() === '') { issues.push(issue('empty', name, `${name} cannot be empty`)); continue; }
    args[name] = value;
    if (option.kind === 'choice' && option.choices && !option.choices.includes(value)) {
      issues.push(issue('invalid', name, `${name} must be one of: ${option.choices.join(', ')}`));
    } else if (option.kind === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())
        || (option.min !== undefined && number < option.min) || (option.max !== undefined && number > option.max)) {
        issues.push(issue('invalid', name, `${name} must be a number${option.min !== undefined || option.max !== undefined ? ` from ${option.min ?? '−∞'} to ${option.max ?? '∞'}` : ''}`));
      }
    } else if (option.kind === 'duration' && !isDuration(value)) {
      issues.push(issue('invalid', name, `${name} must be a duration such as 10m or 2h`));
    } else if (option.kind === 'time' && value.trim().length < 2) {
      issues.push(issue('invalid', name, `${name} must identify a time`));
    }
  }
  for (const option of command.options) {
    if (option.required && !(option.name in args)) issues.push(issue('missing', option.name, `Missing required argument: ${option.name}`));
  }
  return { valid: issues.length === 0, issues, args };
}

function isDuration(value: string): boolean {
  return /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/.test(value.trim());
}

export type CommandParseResult =
  | { type: 'literal'; text: string }
  | { type: 'unknown'; text: string; commandText: string }
  | { type: 'incomplete'; text: string; commandId: string; validation: CommandValidation; subcommands?: string[] }
  | { type: 'invocation'; text: string; invocation: CommandInvocation }
  | { type: 'invalid'; text: string; issues: ArgumentIssue[] };

interface Token { value: string; start: number }
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let value = '';
  let quote = '';
  let escaped = false;
  let start = 0;
  let active = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (!active && /\s/u.test(char)) continue;
    if (!active) { active = true; start = i; }
    if (escaped) { value += char; escaped = false; continue; }
    if (char === '\\' && quote) { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = ''; else value += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/u.test(char)) { tokens.push({ value, start }); value = ''; active = false; continue; }
    value += char;
  }
  if (escaped || quote) return null;
  if (active) tokens.push({ value, start });
  return tokens;
}

export function parseCommand(input: string): CommandParseResult {
  const literal = input.startsWith('//') ? input.slice(1) : input;
  if (!input.startsWith('/') || input.startsWith('//')) return { type: 'literal', text: literal };
  // A code fence at the beginning is ordinary content; slash text inside is never inspected.
  if (input.startsWith('```')) return { type: 'literal', text: input };
  const raw = input.slice(1);
  const tokens = tokenize(raw);
  if (!tokens) return { type: 'invalid', text: input, issues: [issue('invalid', '', 'Unclosed quote or escape')] };
  if (tokens.length === 0) return { type: 'unknown', text: input, commandText: '' };

  const words: string[] = [];
  for (const token of tokens) {
    if (token.value.includes(':')) break;
    words.push(token.value.toLowerCase());
  }
  let command: CommandDefinition | undefined;
  let commandWordCount = 0;
  for (let count = 1; count <= words.length; count++) {
    const candidate = commandById(words.slice(0, count).join(' '));
    if (candidate) { command = candidate; commandWordCount = count; }
  }
  if (!command) {
    const path = words.join(' ');
    const subcommands = path === '' ? [] : [...new Set(COMMANDS.flatMap((entry) => {
      const prefix = `${path} `;
      return entry.id.startsWith(prefix) ? [entry.id.slice(prefix.length).split(' ')[0]!] : [];
    }))];
    if (subcommands.length > 0 && tokens.length === words.length) {
      const missing = issue('missing', 'subcommand', `Choose a subcommand: ${subcommands.join(', ')}`);
      return { type: 'incomplete', text: input, commandId: path, validation: { valid: false, issues: [missing], args: {} }, subcommands };
    }
    return { type: 'unknown', text: input, commandText: path };
  }

  const args: Record<string, string> = {};
  const issues: ArgumentIssue[] = [];
  const positional: string[] = [];
  for (const token of tokens.slice(commandWordCount)) {
    const colon = token.value.indexOf(':');
    const named = colon >= 0 && command.options.some((option) => option.name === token.value.slice(0, colon).toLowerCase());
    if (named) {
      const name = token.value.slice(0, colon).toLowerCase();
      const value = token.value.slice(colon + 1);
      if (!command.options.some((option) => option.name === name)) { issues.push(issue('unexpected', name, `Unexpected argument: ${name}`)); continue; }
      if (name in args) { issues.push(issue('duplicate', name, `Argument supplied more than once: ${name}`)); continue; }
      if (!value) { issues.push(issue('empty', name, `${name} cannot be empty`)); continue; }
      args[name] = value;
    } else positional.push(token.value);
  }
  let pos = 0;
  for (const option of command.options) {
    if (option.name in args) continue;
    if (pos >= positional.length) continue;
    args[option.name] = option.freeText ? positional.slice(pos).join(' ') : positional[pos]!;
    pos = option.freeText ? positional.length : pos + 1;
  }
  if (pos < positional.length) issues.push(issue('unexpected', '', `Unexpected argument: ${positional.slice(pos).join(' ')}`));
  if (issues.length) return { type: 'invalid', text: input, issues };
  const validation = validateCommandArgs(command, args);
  if (!validation.valid) return { type: 'incomplete', text: input, commandId: command.id, validation };
  return { type: 'invocation', text: input, invocation: { commandId: command.id, args: validation.args } };
}
