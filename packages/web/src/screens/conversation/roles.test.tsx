// Flow 09 in the conversation: role mentions in the composer, the send hint, pins by right, and role labels in the log.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PERM, type RoleSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { account, ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { GEN, MEMBERS, OTHER_ROLE, PEER, P1, peerRow, timeline } from '../../test/conversation.tsx';
import { mentionCandidates, mentionMembers, nameBook } from '../shell-model.ts';
import { ComposerArea, type OutgoingMessage } from './ComposerArea.tsx';
import { Conversation, INITIAL_UI } from './Conversation.tsx';

const GAME = '71'.repeat(16);
const MODS = '72'.repeat(16);
const EVERYONE = '70'.repeat(16);
const role = (id: string, name: string, over: Partial<RoleSummary> = {}): RoleSummary =>
  ({ id, name, color: 0, position: 3, hoist: false, mentionable: true, allow: 0, deny: 0, members: 0, ...over });
const ROLES = [role(EVERYONE, '@everyone', { position: 0 }), role(GAME, 'Game Night', { color: 0x336699 }), role(MODS, 'Modérateurs', { mentionable: false })];
const SEND = PERM.viewChannel | PERM.sendMessages;

function composer(over: { bits?: number | null; broadcast?: boolean } = {}) {
  const fake = new FakeClient();
  fake.set('account', account());
  const sent: OutgoingMessage[] = [];
  const book = nameBook({ id: ME.id, username: 'ada' }, MEMBERS, ROLES);
  function Harness() {
    const [draft, setDraft] = useState('');
    return <ComposerArea channelId={GEN} label="message #general" placeholder="message #general" blocked={null} broadcast={over.broadcast ?? true}
      bits={over.bits ?? null} roles={ROLES} channelName="general" encodeWith={mentionMembers(MEMBERS)} candidates={mentionCandidates(MEMBERS, ME.id)}
      items={[]} book={book} draft={draft} onDraft={setDraft} ui={INITIAL_UI} dispatch={() => undefined} onSend={m => sent.push(m)} onError={() => undefined} />;
  }
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}><Harness /></CoreProvider></div>);
  return { user, view, sent };
}
const box = () => screen.getByRole('textbox', { name: 'message #general' });
const optionNames = () => within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent);

describe('role mentions in the composer', () => {
  it('encodes a mentionable role handle to its token on send', async () => {
    const { user, sent } = composer({ bits: SEND });
    await user.type(box(), 'tonight @game-night!{Enter}');
    expect(sent.map(m => m.text)).toEqual([`tonight <@${GAME}>!`]);
  });
  it('offers a role as @handle with the secondary "role", and lists only the mentionable ones without the broadcast right', async () => {
    const { user } = composer({ bits: SEND });
    await user.type(box(), '@mod');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.clear(box());
    await user.type(box(), '@ga');
    expect(optionNames()).toEqual(['@Game Nightrole']);
  });
  it('offers every role, such as Modérateurs, to someone who may mention @everyone', async () => {
    const { user, sent } = composer({ bits: SEND | PERM.mentionEveryone });
    await user.type(box(), '@mod');
    expect(optionNames()).toEqual(['@Modérateursrole']);
    await user.keyboard('{Enter}');
    expect(box()).toHaveValue('@modérateurs ');
    await user.keyboard('x{Enter}');
    expect(sent.map(m => m.text)).toEqual([`<@${MODS}> x`]);
  });
  it('neither offers nor encodes @everyone without the bit, even where today’s rule would', async () => {
    const { user, sent } = composer({ bits: SEND, broadcast: true });
    await user.type(box(), '@every');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.type(box(), 'one {Enter}');
    expect(sent.map(m => m.text)).toEqual(['@everyone ']);
  });
  it('offers and encodes @everyone with the bit', async () => {
    const { user, sent } = composer({ bits: SEND | PERM.mentionEveryone, broadcast: false });
    await user.type(box(), '@every');
    expect(optionNames()).toEqual(['@everyoneeveryone in this channel']);
    await user.type(box(), 'one {Enter}');
    expect(sent.map(m => m.text)).toEqual(['<@everyone> ']);
  });
  it('keeps today’s broadcast rule while the bits are unknown', async () => {
    const { user, sent } = composer({ bits: null, broadcast: true });
    await user.type(box(), '@everyone {Enter}');
    expect(sent.map(m => m.text)).toEqual(['<@everyone> ']);
  });
  it('has no serious axe violations with the role list open', async () => {
    const { user, view } = composer({ bits: SEND });
    await user.type(box(), '@g');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await expectNoAxeViolations(view.container);
  });
});

describe('the send hint', () => {
  it('replaces the composer with chperm.cannotSend when the bits lack send', () => {
    composer({ bits: PERM.viewChannel });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('You cannot send messages in #general.')).toBeInTheDocument();
  });
  it('keeps the composer with send, and with unknown bits', () => {
    composer({ bits: SEND });
    expect(box()).toBeInTheDocument();
  });
  it('keeps the composer with unknown bits', () => {
    composer({ bits: null });
    expect(box()).toBeInTheDocument();
  });
});

function log(over: { bits?: number | null; items?: ReturnType<typeof peerRow>[]; pinsOpen?: boolean } = {}) {
  const fake = new FakeClient();
  fake.set('account', account());
  fake.set(`pins:${GEN}`, []);
  const book = nameBook({ id: ME.id, username: 'ada' }, MEMBERS, ROLES);
  const items = over.items ?? [peerRow(P1, '1', 'theirs')];
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <Conversation channelId={GEN} logKey="k" label="log" timeline={timeline(items)} book={book} encodeWith={[]} broadcast bits={over.bits ?? null} roles={ROLES}
      pinsTitle="Pinned in #general" ui={{ ...INITIAL_UI, pinsOpen: over.pinsOpen ?? false }} dispatch={vi.fn()} loadingEarlier={false}
      onLoadEarlier={vi.fn()} onError={vi.fn()} />
  </CoreProvider></div>);
  return { fake, view };
}
const row = (id: string) => document.querySelector<HTMLElement>(`.d-message-row[data-msg-id="${id}"]`) as HTMLElement;
const actions = (id: string) => within(within(row(id)).getByRole('toolbar', { name: 'actions for this message' })).getAllByRole('button').map(b => b.textContent);

describe('pins by right', () => {
  it('hides the pin item without the pin right, and shows it with the right or with unknown bits', () => {
    log({ bits: SEND });
    expect(actions(P1)).toEqual(['react', 'reply']);
  });
  it('shows the pin item with the pin right', () => {
    log({ bits: SEND | PERM.pinMessages });
    expect(actions(P1)).toEqual(['react', 'reply', 'pin']);
  });
  it('shows the pin item while the bits are unknown', () => {
    log({ bits: null });
    expect(actions(P1)).toEqual(['react', 'reply', 'pin']);
  });
  it('hides the unpin item too without the right', () => {
    log({ bits: SEND, items: [peerRow(P1, '1', 'theirs', { pinned: true })] });
    expect(actions(P1)).toEqual(['react', 'reply']);
  });
  it('shows perm.pinsNote in the pins dialog', () => {
    log({ bits: SEND, pinsOpen: true });
    expect(within(screen.getByRole('dialog', { name: 'Pinned in #general' })).getByText('A pin shows while the person who pinned it may pin in this channel.')).toBeInTheDocument();
  });
});

describe('role labels in the log', () => {
  it('renders a known role with its name and colour dot, and an unknown one generically', () => {
    log({ items: [peerRow(P1, '1', `see <@${GAME}> and <@${OTHER_ROLE}> from <@${PEER}>`)] });
    const mention = within(row(P1)).getByText('@Game Night');
    expect(mention.querySelector('.d-role-dot')?.getAttribute('style')).toContain('#336699');
    expect(within(row(P1)).getByText('@role').querySelector('.d-role-dot')).toBeNull();
  });
});
