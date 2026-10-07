import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { en } from '../../strings/en.ts';
import { REACTION_EMOJI } from '../../emoji.ts';
import { ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import {
  GEN, MOD, O1, O2, P1, P2, PEER, ROLE, file, image, ownRow, peerRow, renderConversation, reply, rowOf,
} from '../../test/conversation.tsx';
import { INITIAL_UI, conversationReducer } from './Conversation.tsx';

const composer = () => screen.getByRole('textbox', { name: 'message #general' });
const toolbarOf = (row: HTMLElement) => within(row).getByRole('toolbar', { name: 'actions for this message' });
const tabbable = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLElement>('button, textarea, a[href]')).filter(e => e.tabIndex >= 0);
/** The reply line's jump button: named by its visible text (L-UI-40, ruling 39), so it is found by its place. */
const replyButton = (row: HTMLElement) => within(row.querySelector('.d-message-row__reply') as HTMLElement).getByRole('button');

describe('conversationReducer', () => {
  it('keeps a reply and an edit apart, counts jumps, and a jump closes the pins', () => {
    const r = { msgId: P1, author: 'bob', excerpt: 'x' };
    let s = conversationReducer(INITIAL_UI, { type: 'reply', reply: r });
    s = conversationReducer(s, { type: 'edit', msgId: O1, value: 'v' });
    expect(s.reply).toEqual(r);
    expect(s.editing).toEqual({ msgId: O1, value: 'v' });
    expect(conversationReducer(s, { type: 'editChange', value: 'w' }).editing).toEqual({ msgId: O1, value: 'w' });
    expect(conversationReducer(INITIAL_UI, { type: 'editChange', value: 'w' })).toBe(INITIAL_UI);
    expect(conversationReducer(s, { type: 'editDone' }).editing).toBeNull();
    expect(conversationReducer(s, { type: 'replySent', msgId: P2 }).reply).toEqual(r);
    expect(conversationReducer(s, { type: 'replySent', msgId: P1 }).reply).toBeNull();
    s = conversationReducer(s, { type: 'pins', open: true });
    expect(s.pinsOpen).toBe(true);
    s = conversationReducer(s, { type: 'jump', msgId: P1 });
    expect(s.pinsOpen).toBe(false);
    expect(s.jump).toEqual({ msgId: P1, n: 1 });
    expect(conversationReducer(s, { type: 'jump', msgId: P1 }).jump).toEqual({ msgId: P1, n: 2 });
    expect(conversationReducer(s, { type: 'trayError', text: 'no' }).trayError).toBe('no');
    expect(conversationReducer(s, { type: 'notice', notice: 'shell.message.replyNotLoaded' }).notice).toBe('shell.message.replyNotLoaded');
    expect(conversationReducer(s, { type: 'reset' })).toEqual(INITIAL_UI);
    expect(INITIAL_UI).toEqual({ reply: null, editing: null, pinsOpen: false, jump: null, notice: null, trayError: null });
  });
});

describe('the roving log (keyboard map, ruling 21)', () => {
  it('moves the active row with the arrows and Home/End, and only the active row’s controls are tabbable', async () => {
    const { user } = renderConversation({ items: [peerRow(P1, '1', 'first'), peerRow(P2, '2', 'second'), ownRow(O1, '3', 'third')] });
    expect([rowOf(P1), rowOf(P2), rowOf(O1)].map(r => r.tabIndex)).toEqual([-1, -1, 0]);
    expect(tabbable(rowOf(P1))).toEqual([]);
    expect(tabbable(rowOf(O1))).toHaveLength(1);
    act(() => rowOf(O1).focus());
    await user.keyboard('{ArrowUp}');
    expect(rowOf(P2)).toHaveFocus();
    expect([rowOf(P1), rowOf(P2), rowOf(O1)].map(r => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(tabbable(rowOf(O1))).toEqual([]);
    expect(tabbable(rowOf(P2))).toHaveLength(1);
    await user.keyboard('{Home}');
    expect(rowOf(P1)).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(rowOf(P1)).toHaveFocus();
    await user.keyboard('{End}');
    expect(rowOf(O1)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(rowOf(O1)).toHaveFocus();
  });
  it('hands the arrows from the log container to its active row', async () => {
    const { user } = renderConversation({ items: [peerRow(P1, '1', 'first'), peerRow(P2, '2', 'second')] });
    act(() => screen.getByRole('log').focus());
    await user.keyboard('{ArrowDown}');
    expect(rowOf(P2)).toHaveFocus();
    act(() => screen.getByRole('log').focus());
    await user.keyboard('{Home}');
    expect(rowOf(P1)).toHaveFocus();
  });
  it('makes a row active when focus enters it by pointer', async () => {
    const { user } = renderConversation({ items: [peerRow(P1, '1', 'first'), peerRow(P2, '2', 'second')] });
    await user.click(within(toolbarOf(rowOf(P1))).getByRole('button', { name: 'pin' }));
    expect(rowOf(P1).tabIndex).toBe(0);
    expect(rowOf(P2).tabIndex).toBe(-1);
  });
  it('Escape in a row control returns to the row, and on the row to the composer', async () => {
    const { user } = renderConversation({ items: [ownRow(O1, '1', 'mine')] });
    act(() => within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'react' }).focus());
    await user.keyboard('{Escape}');
    expect(rowOf(O1)).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(composer()).toHaveFocus();
  });
});

describe('the toolbar (L-UI-41)', () => {
  it('offers react, reply and pin on others’ rows, edit and delete on own rows, and nothing on rows that are not ok', () => {
    renderConversation({ items: [
      peerRow(P1, '1', 'theirs'),
      ownRow(O1, '2', 'mine', { pinned: true }),
      ownRow(O2, null, 'sending', { state: 'pending' }),
      peerRow(P2, '4', '', { state: 'deleted' }),
    ] });
    const labels = (row: HTMLElement) => within(toolbarOf(row)).getAllByRole('button').map(b => b.textContent);
    expect(labels(rowOf(P1))).toEqual(['react', 'reply', 'pin']);
    expect(labels(rowOf(O1))).toEqual(['react', 'reply', 'edit', 'unpin', 'delete']);
    expect(within(rowOf(O2)).queryByRole('toolbar')).toBeNull();
    expect(within(rowOf(P2)).queryByRole('toolbar')).toBeNull();
    expect(screen.getAllByRole('toolbar')).toHaveLength(2);
  });
  it('pins and unpins by the row’s pinned flag', async () => {
    const { fake, user } = renderConversation({ items: [peerRow(P1, '1', 'theirs'), ownRow(O1, '2', 'mine', { pinned: true })] });
    expect(rowOf(O1)).toHaveAttribute('data-pinned', 'true');
    expect(rowOf(O1)).toHaveTextContent('pinned');
    await user.click(within(toolbarOf(rowOf(P1))).getByRole('button', { name: 'pin' }));
    await user.click(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'unpin' }));
    expect(fake.callsOf('pin')).toEqual([
      { m: 'pin', channelId: GEN, msgId: P1, on: true }, { m: 'pin', channelId: GEN, msgId: O1, on: false },
    ]);
  });
  it('offers edit and delete to the author user on another device even when own is false (F3)', () => {
    renderConversation({ items: [ownRow(O1, '1', 'other device', { own: false })] });
    expect(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'edit' })).toBeInTheDocument();
    expect(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'delete' })).toBeInTheDocument();
    expect(rowOf(O1)).not.toHaveAttribute('data-own');
  });
});

describe('delete (Q19, ruling 24)', () => {
  it('deletes only after the dialog is confirmed, then hands focus to the row', async () => {
    const { fake, user } = renderConversation({ items: [ownRow(O1, '1', 'mine')] });
    await user.click(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this message?' });
    expect(dialog).toHaveTextContent('It is removed for everyone in this conversation, with its reactions and files. Copies someone already saved stay with them. This cannot be undone.');
    expect(fake.callsOf('deleteMessage')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fake.callsOf('deleteMessage')).toEqual([]);
    await user.click(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'delete' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Delete this message?' })).getByRole('button', { name: 'Delete' }));
    expect(fake.callsOf('deleteMessage')).toEqual([{ m: 'deleteMessage', channelId: GEN, msgId: O1 }]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(rowOf(O1)).toHaveFocus();
  });
});

describe('edit in place (L-UI-44)', () => {
  it('saves the text with its mentions encoded, cancels on Escape, and sends nothing for an unchanged or empty text', async () => {
    const { fake, user } = renderConversation({ items: [ownRow(O1, '1', `hi <@${PEER}>`)] });
    const edit = () => user.click(within(toolbarOf(rowOf(O1))).getByRole('button', { name: 'edit' }));
    await edit();
    const editor = screen.getByRole('textbox', { name: 'edit your message' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('hi @bob');
    expect(rowOf(O1)).toContainElement(editor);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('textbox', { name: 'edit your message' })).toBeNull();
    expect(rowOf(O1)).toHaveFocus();
    await edit();
    await user.keyboard(' and @mo{Escape}');
    expect(screen.queryByRole('textbox', { name: 'edit your message' })).toBeNull();
    expect(rowOf(O1)).toHaveFocus();
    await edit();
    await user.clear(screen.getByRole('textbox', { name: 'edit your message' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'edit your message' })).toBeInTheDocument();
    expect(fake.callsOf('editMessage')).toEqual([]);
    await user.keyboard('{Escape}');
    await edit();
    await user.keyboard(' and @mo{Enter}');
    expect(fake.callsOf('editMessage')).toEqual([{ m: 'editMessage', channelId: GEN, msgId: O1, text: `hi <@${PEER}> and <@${MOD}>` }]);
    expect(rowOf(O1)).toHaveFocus();
  });
  it('marks an edited row, and shows the edit only as the core folded it', () => {
    renderConversation({ items: [ownRow(O1, '1', 'folded text', { edited: true })] });
    expect(rowOf(O1)).toHaveAttribute('data-edited', 'true');
    expect(rowOf(O1)).toHaveTextContent('edited');
    expect(rowOf(O1)).toHaveTextContent('folded text');
  });
});

describe('reactions (Q18, ruling 28)', () => {
  it('toggles a chip by whether it is mine, and adds from the grid of 32 with focus back on the opener', async () => {
    const { fake, user } = renderConversation({ items: [peerRow(P1, '1', 'theirs', { reactions: [
      { emoji: '\u{1F44D}', count: 2, mine: true }, { emoji: '\u{1F602}', count: 1, mine: false }, { emoji: '\u{1F984}', count: 1, mine: false },
    ] })] });
    const bar = within(rowOf(P1)).getByRole('group', { name: 'reactions' });
    expect(within(bar).getByRole('button', { name: 'thumbs up, 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(bar).getByRole('button', { name: 'tears of joy, 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(bar).getByRole('button', { name: '\u{1F984}, 1' })).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'thumbs up, 2' }));
    await user.click(within(bar).getByRole('button', { name: 'tears of joy, 1' }));
    const react = within(toolbarOf(rowOf(P1))).getByRole('button', { name: 'react' });
    await user.click(react);
    const grid = screen.getByRole('dialog', { name: 'pick a reaction' });
    expect(within(grid).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(REACTION_EMOJI.map(e => en[e.key]));
    await user.click(within(grid).getByRole('button', { name: 'rocket' }));
    expect(screen.queryByRole('dialog', { name: 'pick a reaction' })).toBeNull();
    expect(react).toHaveFocus();
    const add = within(bar).getByRole('button', { name: 'add a reaction' });
    await user.click(add);
    // The grid lives in the conversation's overlay layer, never inside the log (SLICE-UX-08, ruling 39).
    const fromAdd = screen.getByRole('dialog', { name: 'pick a reaction' });
    expect(screen.getByRole('log').contains(fromAdd)).toBe(false);
    expect(fromAdd.closest('.dw-overlay')).not.toBeNull();
    await user.click(within(fromAdd).getByRole('button', { name: 'thumbs up' }));
    await user.click(add);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'pick a reaction' })).toBeNull();
    expect(add).toHaveFocus();
    expect(fake.callsOf('react')).toEqual([
      { m: 'react', channelId: GEN, msgId: P1, emoji: '\u{1F44D}', on: false },
      { m: 'react', channelId: GEN, msgId: P1, emoji: '\u{1F602}', on: true },
      { m: 'react', channelId: GEN, msgId: P1, emoji: '\u{1F680}', on: true },
      { m: 'react', channelId: GEN, msgId: P1, emoji: '\u{1F44D}', on: false },
    ]);
  });
  it('draws no reaction bar on a row without reactions', () => {
    renderConversation({ items: [peerRow(P1, '1', 'quiet')] });
    expect(within(rowOf(P1)).queryByRole('group', { name: 'reactions' })).toBeNull();
  });
});

describe('the reply line and the jump (brief:186)', () => {
  let scroll: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as unknown as Record<string, unknown>).scrollIntoView;
    delete (window as unknown as Record<string, unknown>).matchMedia;
  });
  it('jumps to a loaded original, focuses it and flashes it for 1.4 s', () => {
    vi.useFakeTimers();
    renderConversation({ items: [peerRow(P1, '1', 'the original'), ownRow(O1, '2', 'my answer', { reply: reply() })] });
    const jump = replyButton(rowOf(O1));
    expect(jump).toHaveTextContent('bob');
    expect(jump).toHaveTextContent('the original');
    expect(jump).toHaveAccessibleName('bob the original');
    expect(jump).toHaveAccessibleDescription('reply to bob go to the original message');
    fireEvent.click(jump);
    expect(rowOf(P1)).toHaveFocus();
    expect(rowOf(P1)).toHaveAttribute('data-flash', 'true');
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    act(() => { vi.advanceTimersByTime(1399); });
    expect(rowOf(P1)).toHaveAttribute('data-flash', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(rowOf(P1)).not.toHaveAttribute('data-flash');
  });
  it('does not animate the scroll under reduced motion', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true,
      value: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)', media: q, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) });
    renderConversation({ items: [peerRow(P1, '1', 'the original'), ownRow(O1, '2', 'my answer', { reply: reply() })] });
    fireEvent.click(replyButton(rowOf(O1)));
    expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });
    expect(rowOf(P1)).toHaveAttribute('data-flash', 'true');
  });
  it('says the original is further back when it is not loaded, and the notice can be dismissed', async () => {
    const { user } = renderConversation({ items: [ownRow(O1, '5', 'answer', { reply: reply() })] });
    await user.click(replyButton(rowOf(O1)));
    expect(screen.getByText('The original message is further back. Load earlier messages to reach it.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(screen.queryByText('The original message is further back. Load earlier messages to reach it.')).toBeNull();
  });
  it('says when the original cannot be shown or was deleted', () => {
    renderConversation({ items: [
      ownRow(O1, '5', 'a', { reply: reply({ state: 'missing', senderUser: null, excerpt: '', seq: null }) }),
      ownRow(O2, '6', 'b', { reply: reply({ state: 'deleted', excerpt: '' }) }),
    ] });
    expect(rowOf(O1)).toHaveTextContent('the original message cannot be shown here');
    expect(rowOf(O1).querySelector('.d-message-row__reply button')).toBeNull();
    expect(rowOf(O2)).toHaveTextContent('the original message was deleted');
    expect(replyButton(rowOf(O2))).toHaveAccessibleName('bob the original message was deleted');
  });
});

describe('bodies and pending actions', () => {
  it('renders mentions as names, marks the viewer’s, and never shows a raw token', () => {
    renderConversation({ items: [peerRow(P1, '1', `<@${ME.id}> and <@${MOD}>, <@everyone>, <@${ROLE}>`, { mention: true })] });
    const row = rowOf(P1);
    expect(row).toHaveAttribute('data-mention', 'true');
    expect(Array.from(row.querySelectorAll('.d-mention')).map(p => [p.textContent, p.hasAttribute('data-me'), p.hasAttribute('data-broadcast')])).toEqual([
      ['@Ada L', true, false], ['@Mo', false, false], ['@everyone', true, true], ['@role', true, false],
    ]);
    expect(row.textContent).not.toContain('<@');
  });
  it('shows a pending action as saving… and a failed one with retry and discard', async () => {
    const E1 = 'e1'.repeat(16);
    const E2 = 'e2'.repeat(16);
    const { fake, user } = renderConversation({ items: [
      peerRow(P1, '1', 'a', { actions: [{ msgId: E1, type: 3, state: 'pending', reason: '' }] }),
      ownRow(O1, '2', 'b', { actions: [{ msgId: E1, type: 1, state: 'pending', reason: '' }, { msgId: E2, type: 1, state: 'failed', reason: 'E_NETWORK' }] }),
    ] });
    expect(rowOf(P1)).toHaveTextContent('saving…');
    expect(rowOf(O1)).toHaveTextContent('not saved');
    expect(rowOf(O1)).not.toHaveTextContent('saving…');
    await user.click(within(rowOf(O1)).getByRole('button', { name: 'retry' }));
    expect(rowOf(O1)).toHaveFocus();
    await user.click(within(rowOf(O1)).getByRole('button', { name: 'discard' }));
    expect(fake.callsOf('retrySend')).toEqual([{ m: 'retrySend', msgId: E2 }]);
    expect(fake.callsOf('discardSend')).toEqual([{ m: 'discardSend', msgId: E2 }]);
  });
  it('offers only discard for a sent message whose file is no longer on the server', async () => {
    const { fake, user } = renderConversation({ items: [
      ownRow(O1, null, 'with a file', { state: 'failed', reason: 'E_ATTACHMENT_MISSING', attachments: [file()] }),
    ] });
    const row = rowOf(O1);
    expect(row).toHaveTextContent('A file of this message is no longer on the server. Discard it and attach the file again.');
    expect(within(row).queryByRole('button', { name: 'retry' })).toBeNull();
    expect(within(row).getAllByRole('button', { name: 'discard' })).toHaveLength(1);
    await user.click(within(row).getByRole('button', { name: 'discard' }));
    expect(fake.callsOf('discardSend')).toEqual([{ m: 'discardSend', msgId: O1 }]);
    expect(fake.callsOf('retrySend')).toEqual([]);
  });
  it('passes axe with every decoration on one row', async () => {
    const { view } = renderConversation({ items: [
      peerRow(P1, '1', 'the original'),
      ownRow(O1, '2', `<@${PEER}> look`, { edited: true, pinned: true, reply: reply(), mention: false,
        reactions: [{ emoji: '\u{1F44D}', count: 3, mine: true }], attachments: [image({ thumb: false }), file({ index: 1 })],
        actions: [{ msgId: 'e3'.repeat(16), type: 3, state: 'pending', reason: '' }] }),
    ] });
    await expectNoAxeViolations(view.container);
  });
});

describe('focus handoffs (F4)', () => {
  it('returns to the row when unreacting removes its last chip', async () => {
    const { fake, user } = renderConversation({ items: [peerRow(P1, '1', 'x', { reactions: [{ emoji: '👍', count: 1, mine: true }] })] });
    await user.click(within(rowOf(P1)).getByRole('button', { name: 'thumbs up, 1' }));
    act(() => fake.set(`timeline:${GEN}`, { channelId: GEN, group: 'active', hasEarlier: false, items: [peerRow(P1, '1', 'x')] }));
    expect(rowOf(P1)).toHaveFocus();
  });
  it('dismisses the reply not loaded banner to the active log row', async () => {
    const { user } = renderConversation({ items: [ownRow(O1, '5', 'answer', { reply: reply() })] });
    await user.click(replyButton(rowOf(O1)));
    await user.click(screen.getByRole('button', { name: 'dismiss' }));
    expect(rowOf(O1)).toHaveFocus();
  });
  it('hands attachment gone discard to the next failed row’s discard', async () => {
    const { user } = renderConversation({ items: [
      ownRow(O1, null, 'gone', { state: 'failed', reason: 'E_ATTACHMENT_MISSING', attachments: [file()] }),
      ownRow(O2, null, 'failed', { state: 'failed', reason: 'E_NETWORK' }),
    ] });
    await user.click(within(rowOf(O1)).getByRole('button', { name: 'discard' }));
    expect(within(rowOf(O2)).getByRole('button', { name: 'discard' })).toHaveFocus();
  });
  it('closes the emoji grid when focus leaves it without moving focus', async () => {
    const { user } = renderConversation({ items: [peerRow(P1, '1', 'x')] });
    await user.click(within(toolbarOf(rowOf(P1))).getByRole('button', { name: 'react' }));
    const grid = screen.getByRole('dialog', { name: 'pick a reaction' });
    act(() => composer().focus());
    fireEvent.blur(grid.querySelector('button') as HTMLElement, { relatedTarget: composer() });
    expect(grid).not.toBeInTheDocument();
    expect(composer()).toHaveFocus();
  });
});
