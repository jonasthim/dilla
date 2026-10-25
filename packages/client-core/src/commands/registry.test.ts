import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  commandById,
  parseCommand,
  searchCommands,
  validateCommandArgs,
} from './registry';

describe('command registry', () => {
  it('contains unique canonical ids for the complete approved catalog', () => {
    const ids = COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'help', 'me', 'code', 'dm', 'search', 'reply', 'join', 'play', 'queue',
      'queue remove', 'queue move', 'queue clear', 'kick', 'timeout', 'role add',
      'selfrole list', 'announcement create', 'poll vote', 'remind', 'reminders dismiss',
    ]) expect(commandById(id)).toBeDefined();
    expect(ids).toHaveLength(63);
  });

  it('validates required and optional arguments across schema kinds', () => {
    expect(validateCommandArgs(commandById('dm')!, {})).toMatchObject({ valid: false });
    expect(validateCommandArgs(commandById('dm')!, { user: 'user-123' })).toMatchObject({ valid: true });
    expect(validateCommandArgs(commandById('ban')!, { user: 'user-123', duration: '1h', reason: 'spam' })).toMatchObject({ valid: true });
    expect(validateCommandArgs(commandById('shuffle')!, { mode: 'on' })).toMatchObject({ valid: true });
    expect(validateCommandArgs(commandById('volume')!, { level: '101' })).toMatchObject({ valid: false });
    expect(validateCommandArgs(commandById('queue move')!, { item: 'track-id', position: '2' })).toMatchObject({ valid: true });
    expect(validateCommandArgs(commandById('remind')!, { when: '1h', text: 'stretch' })).toMatchObject({ valid: true });
  });

  it('accepts selected entity ids without trying to resolve display names', () => {
    const cases = [
      ['join', { 'voice-channel': 'channel-7' }],
      ['thread', { message: 'message-8' }],
      ['role add', { user: 'user-9', role: 'role-10' }],
      ['poll results', { poll: 'poll-11' }],
      ['announcement delete', { announcement: 'announcement-12' }],
      ['reminders cancel', { reminder: 'reminder-13' }],
    ] as const;
    for (const [id, args] of cases) expect(validateCommandArgs(commandById(id)!, args).valid).toBe(true);
  });

  it('parses free text, named values and quoted Unicode without losing spaces', () => {
    expect(parseCommand('/play jazz 東京')).toMatchObject({
      type: 'invocation', invocation: { commandId: 'play', args: { 'query-or-url': 'jazz 東京' } },
    });
    expect(parseCommand('/play https://example.test/a:b')).toMatchObject({ type: 'invocation' });
    expect(parseCommand('/remind when:"tomorrow 09:00" text:"call Åsa"')).toMatchObject({
      type: 'invocation', invocation: { commandId: 'remind', args: { when: 'tomorrow 09:00', text: 'call Åsa' } },
    });
  });

  it('distinguishes groups, incomplete and unknown commands', () => {
    expect(parseCommand('/queue')).toMatchObject({ type: 'invocation', invocation: { commandId: 'queue' } });
    expect(parseCommand('/queue remove')).toMatchObject({ type: 'incomplete', commandId: 'queue remove' });
    expect(parseCommand('/queue clear')).toMatchObject({ type: 'invocation', invocation: { commandId: 'queue clear' } });
    expect(parseCommand('/role')).toMatchObject({ type: 'incomplete', commandId: 'role', subcommands: ['add', 'remove'] });
    expect(parseCommand('/not-a-command')).toMatchObject({ type: 'unknown' });
  });

  it('treats only leading slashes as commands and supports // literal escape', () => {
    expect(parseCommand('hello /play jazz')).toMatchObject({ type: 'literal' });
    expect(parseCommand('```\n/play jazz\n```')).toMatchObject({ type: 'literal' });
    expect(parseCommand('//play jazz')).toMatchObject({ type: 'literal', text: '/play jazz' });
  });

  it('rejects malformed quotes, duplicate and unexpected arguments', () => {
    expect(parseCommand('/remind "unfinished')).toMatchObject({ type: 'invalid' });
    expect(validateCommandArgs(commandById('dm')!, { user: 'one', extra: 'two' })).toMatchObject({ valid: false });
    expect(parseCommand('/dm user:one user:two')).toMatchObject({ type: 'invalid' });
  });

  it('ranks exact, prefix and substring matches deterministically', () => {
    expect(searchCommands('queue remove')[0]?.id).toBe('queue remove');
    expect(searchCommands('queue rem')[0]?.id).toBe('queue remove');
    expect(searchCommands('remind')).toContainEqual(expect.objectContaining({ id: 'remind' }));
    expect(searchCommands('', 100)).toHaveLength(Math.min(COMMANDS.length, 25));
  });
});
