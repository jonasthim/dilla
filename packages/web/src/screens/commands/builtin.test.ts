import { describe, expect, it } from 'vitest';
import type { Command } from '@dilla/client-core';
import { FakeClient } from '../../test/fake-client.ts';
import { builtinHandlers } from './builtin.ts';
import type { CommandExecutionContext } from './command-types.ts';

const client = new FakeClient();
const context: CommandExecutionContext = {
  requestId: 'attempt-1', binding: { communityId: '11'.repeat(16), channelId: '22'.repeat(16), bits: 0 },
  client, call: {} as never, navigate: () => undefined, openThread: () => undefined, openSearch: () => undefined,
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
});
