// Tap-to-reveal message actions on a phone (R30): the toolbar is rendered only on the revealed row, one row at a time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { PHONE_QUERY } from '../../layout.ts';
import { O1, P1, P2, ownRow, peerRow, renderConversation, rowOf } from '../../test/conversation.tsx';

function media(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  vi.useRealTimers();
});
const toolbar = (row: HTMLElement) => within(row).queryByRole('toolbar', { name: 'actions for this message' });
const body = (row: HTMLElement) => row.querySelector('.d-message-row__body') as HTMLElement;
const rows = () => [peerRow(P1, '1', 'first', { ts: 1_000 }), peerRow(P2, '2', 'second', { ts: 2_000 }), ownRow(O1, '3', 'third', { ts: 3_000 })];

describe('a message row on a phone (R30)', () => {
  beforeEach(() => media(true));

  it('has no toolbar until a tap, and a tap on the body reveals it', async () => {
    const { user } = renderConversation({ items: rows() });
    expect([P1, P2, O1].map(id => toolbar(rowOf(id)))).toEqual([null, null, null]);
    await user.click(body(rowOf(P1)));
    expect(toolbar(rowOf(P1))).not.toBeNull();
    expect(rowOf(P1)).toHaveAttribute('data-revealed', 'true');
  });
  it('hides it by a second tap on the same row', async () => {
    const { user } = renderConversation({ items: rows() });
    await user.click(body(rowOf(P1)));
    await user.click(body(rowOf(P1)));
    expect(toolbar(rowOf(P1))).toBeNull();
  });
  it('moves the reveal when another row is tapped: one revealed row at a time', async () => {
    const { user } = renderConversation({ items: rows() });
    await user.click(body(rowOf(P1)));
    await user.click(body(rowOf(P2)));
    expect(toolbar(rowOf(P1))).toBeNull();
    expect(toolbar(rowOf(P2))).not.toBeNull();
    expect(screen.getAllByRole('toolbar', { name: 'actions for this message' })).toHaveLength(1);
  });
  it('reveals on Enter on the focused row', async () => {
    const { user } = renderConversation({ items: rows() });
    act(() => rowOf(P1).focus());
    await user.keyboard('{Enter}');
    expect(toolbar(rowOf(P1))).not.toBeNull();
  });
  it('hides it with Escape, from the row and from anywhere in the log', async () => {
    const { user } = renderConversation({ items: rows() });
    await user.click(body(rowOf(P1)));
    act(() => rowOf(P1).focus());
    await user.keyboard('{Escape}');
    expect(toolbar(rowOf(P1))).toBeNull();
    await user.click(body(rowOf(P2)));
    act(() => screen.getByRole('log').focus());
    await user.keyboard('{Escape}');
    expect(toolbar(rowOf(P2))).toBeNull();
  });
  it('hides it when the log scrolls', async () => {
    const { user } = renderConversation({ items: rows() });
    await user.click(body(rowOf(P1)));
    expect(toolbar(rowOf(P1))).not.toBeNull();
    // The log sets its own scroll when the row grows under a reader at the end; that is not the reader scrolling.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    fireEvent.scroll(screen.getByRole('log'));
    expect(toolbar(rowOf(P1))).toBeNull();
  });
  it('keeps the reveal for the scroll the log makes while the row grows', async () => {
    const { user } = renderConversation({ items: rows() });
    await user.click(body(rowOf(P1)));
    fireEvent.scroll(screen.getByRole('log'));
    expect(toolbar(rowOf(P1))).not.toBeNull();
  });
  it('does not reveal on a tap on a control of the row', async () => {
    const { user } = renderConversation({ items: [peerRow(P1, '1', 'first', { reactions: [{ emoji: '👍', count: 1, mine: false }] })] });
    await user.click(within(rowOf(P1)).getByRole('button', { name: /👍|thumbs|1/ }));
    expect(toolbar(rowOf(P1))).toBeNull();
  });
});

describe('a message row off a phone', () => {
  it('keeps every toolbar rendered and reveals nothing on a tap', async () => {
    media(false);
    const { user } = renderConversation({ items: rows() });
    expect(screen.getAllByRole('toolbar', { name: 'actions for this message' })).toHaveLength(3);
    await user.click(body(rowOf(P1)));
    expect(rowOf(P1)).not.toHaveAttribute('data-revealed');
    expect(screen.getAllByRole('toolbar', { name: 'actions for this message' })).toHaveLength(3);
  });
});
