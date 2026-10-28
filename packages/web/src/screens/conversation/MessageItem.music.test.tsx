// Fix round 1 (Jonas 2026-10-28): Glenn's public "started music" message reads the prototype's line and carries the live card.
import { describe, expect, it } from 'vitest';
import { within } from '@testing-library/react';
import { A, CHANNEL, P1, P2, peerRow, renderConversation, rowOf } from '../../test/conversation.tsx';
import { ME } from '../../test/fixtures.ts';

const HARBOUR = '4e'.repeat(16);
const GLENN = '9f'.repeat(16);

describe('a "started music" message', () => {
  it('reads "{name} started music in {room}" with the player card, from a bot only', () => {
    const marker = `Music started.\n[dilla-music:v1:${HARBOUR}:${ME.id}]`;
    renderConversation({
      items: [peerRow(P1, '1', marker, { bot: true, senderUser: GLENN }), peerRow(P2, '2', marker)],
      before: fake => fake.set(`channels:${A}`, [CHANNEL, { ...CHANNEL, id: HARBOUR, kind: 1, name: 'harbour' }]),
    });
    const bot = rowOf(P1);
    expect(bot).toHaveTextContent('Ada L started music in harbour');
    expect(bot).not.toHaveTextContent('dilla-music');
    const card = within(bot).getByRole('group', { name: 'Music player' });
    // The Bot is not in harbour in this fixture: the card says it left voice.
    expect(card).toHaveTextContent('left voice');
    expect(within(rowOf(P2)).queryByRole('group', { name: 'Music player' })).toBeNull();
  });
});
