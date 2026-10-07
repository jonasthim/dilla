import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageRow } from './MessageRow.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

const BODY = 'anyone up for a round tonight?';
const UNREADABLE = 'This message could not be read on this device.';

describe('MessageRow', () => {
  it('shows author, time and body and hides the avatar from assistive tech', () => {
    const { container } = render(<MessageRow author="ada" time="21:02" body={BODY} state="ok" />);
    const row = container.firstElementChild;
    expect(row).toHaveClass('d-message-row');
    expect(row).toHaveAttribute('data-state', 'ok');
    expect(row).not.toHaveAttribute('data-own');
    expect(screen.getByText('ada')).toHaveClass('d-message-row__author');
    expect(screen.getByText('21:02')).toHaveClass('d-message-row__time');
    expect(screen.getByText(BODY)).toHaveClass('d-message-row__body');
    expect(screen.queryByRole('img', { name: 'ada' })).toBeNull();
    expect(container.querySelector('.d-message-row__state')).toBeNull();
  });

  it('marks web and bot senders with their tag, and the own row', () => {
    const { rerender, container } = render(<MessageRow author="björn" time="21:03" body="after nine" state="ok" tag="web" />);
    expect(screen.getByText('web')).toHaveClass('d-tag');
    rerender(<MessageRow author="loot-bot" time="21:05" body="weekly reset in 2 h" state="ok" tag="bot" own />);
    expect(screen.getByText('bot')).toHaveClass('d-tag');
    expect(container.firstElementChild).toHaveAttribute('data-own', 'true');
  });

  it('shows a pending row with its body and its state label', () => {
    render(<MessageRow author="mira" time="21:04" body="count me in" state="pending" stateLabel="sending" detail="E_IGNORED" />);
    expect(screen.getByText('count me in')).toBeInTheDocument();
    expect(screen.getByText('sending')).toHaveClass('d-message-row__state');
    expect(screen.queryByText('E_IGNORED')).toBeNull();
  });

  it('shows a failed row with its state label, its code and its actions', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const discard = vi.fn();
    render(<MessageRow author="mira" time="21:04" body="count me in" state="failed" stateLabel="not sent" detail="E_TOO_LARGE"
      actions={[{ label: 'retry', onAction: retry }, { label: 'discard', onAction: discard }]} />);
    expect(screen.getByText('count me in')).toBeInTheDocument();
    expect(screen.getByText('not sent')).toHaveClass('d-message-row__state');
    expect(screen.getByText('E_TOO_LARGE').tagName).toBe('CODE');
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['retry', 'discard']);
    await user.click(screen.getByRole('button', { name: 'retry' }));
    await user.click(screen.getByRole('button', { name: 'discard' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('never shows the body of an unreadable row, only the fixed text and the code', () => {
    const { container } = render(<MessageRow author="ada" time="21:06" body="this text must not render" state="cannot-read"
      stateLabel={UNREADABLE} detail="E_SENDER_MISMATCH" />);
    expect(container.textContent).not.toContain('this text must not render');
    expect(screen.getByText(UNREADABLE)).toHaveClass('d-message-row__note');
    expect(screen.getByText('E_SENDER_MISMATCH').tagName).toBe('CODE');
    expect(container.querySelector('.d-message-row__body')).toBeNull();
  });

  it('shows only the state label for a deleted row', () => {
    const { container } = render(<MessageRow author="ada" time="21:07" body="gone" state="deleted" stateLabel="message deleted" detail="E_IGNORED" />);
    expect(container.textContent).not.toContain('gone');
    expect(screen.getByText('message deleted')).toHaveClass('d-message-row__note');
    expect(screen.queryByText('E_IGNORED')).toBeNull();
  });

  it('keeps the line breaks of the body', () => {
    const { container } = render(<MessageRow author="ada" time="21:08" body={'line one\nline two'} state="ok" />);
    expect(container.querySelector('.d-message-row__body')?.textContent).toBe('line one\nline two');
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><MessageRow author="mira" time="21:04" body="count me in" state="failed" stateLabel="not sent"
      detail="E_TOO_LARGE" tag="web" actions={[{ label: 'retry', onAction: () => {} }, { label: 'discard', onAction: () => {} }]} /></div>);
    await expectNoAxeViolations(container);
  });

  // ---- web-2b (L-UI-40) ----
  const MSG = 'ab'.repeat(16);

  it('is an article named by its head, carrying the DOM contract, and a tab stop only while active', () => {
    const { container, rerender } = render(<MessageRow author="ada" time="21:02" body="hi" state="ok" seq="12" msgId={MSG} />);
    const row = container.querySelector('article')!;
    expect(row).toHaveClass('d-message-row');
    expect(row).toHaveAttribute('tabindex', '-1');
    expect(row).toHaveAttribute('data-seq', '12');
    expect(row).toHaveAttribute('data-msg-id', MSG);
    expect(row).not.toHaveAttribute('data-active');
    expect(row).not.toHaveAttribute('data-edited');
    expect(row).not.toHaveAttribute('data-pinned');
    expect(row).not.toHaveAttribute('data-mention');
    expect(row.getAttribute('aria-labelledby')).toBe(container.querySelector('.d-message-row__head')?.id);
    expect(screen.getByRole('article')).toHaveAccessibleName(/^ada/);
    rerender(<MessageRow author="ada" time="21:02" body="hi" state="ok" seq={null} msgId={null} active />);
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAttribute('data-active', 'true');
    expect(row).not.toHaveAttribute('data-seq');
    expect(row).not.toHaveAttribute('data-msg-id');
  });

  it('renders body parts as text and mention pills, never the raw token and never HTML', () => {
    const { container } = render(<MessageRow author="mira" time="21:03" state="ok" mention body={[
      { kind: 'text', text: 'hey ' }, { kind: 'mention', label: '@ada', me: true, broadcast: false },
      { kind: 'text', text: ' and ' }, { kind: 'mention', label: '@everyone', me: true, broadcast: true },
      { kind: 'text', text: ' and ' }, { kind: 'mention', label: '@björn', me: false, broadcast: false },
      { kind: 'text', text: ' <b>not bold</b>' },
    ]} />);
    const body = container.querySelector('.d-message-row__body')!;
    expect(body.textContent).toBe('hey @ada and @everyone and @björn <b>not bold</b>');
    expect(body.querySelector('b')).toBeNull();
    expect([...body.querySelectorAll('.d-mention')].map((p) => [p.tagName, p.textContent, p.getAttribute('data-me'), p.getAttribute('data-broadcast')])).toEqual([
      ['SPAN', '@ada', 'true', null], ['SPAN', '@everyone', 'true', 'true'], ['SPAN', '@björn', null, null],
    ]);
    expect(container.querySelector('article')).toHaveAttribute('data-mention', 'true');
    expect(body.innerHTML).not.toContain('&lt;@');
  });

  it('marks an edited and a pinned row in its head, as text and as data attributes', () => {
    const { container } = render(<MessageRow author="ada" time="21:04" body="meet at nine" state="ok" editedLabel="edited" pinnedLabel="pinned" />);
    const head = container.querySelector('.d-message-row__head')!;
    expect(head.querySelector('.d-message-row__edited')?.textContent).toBe('edited');
    expect(head.querySelector('.d-message-row__pinned')?.textContent).toBe('pinned');
    const row = container.querySelector('article')!;
    expect(row).toHaveAttribute('data-edited', 'true');
    expect(row).toHaveAttribute('data-pinned', 'true');
  });

  it('places its parts in the order of the keyboard map', () => {
    const { container } = render(<MessageRow author="ada" time="21:04" state="ok" active body="the body"
      toolbar={<button type="button">tb</button>}
      reply={{ label: 'reply to björn', author: 'björn', excerpt: 'after nine', state: 'ok', jumpLabel: 'go to the original message', onJump: () => {} }}
      attachments={<button type="button">card</button>}
      reactions={<button type="button">chip</button>}
      pendingAction={{ label: 'not saved', tone: 'failed', actions: [{ label: 'retry', onAction: () => {} }] }} />);
    // The visible text of each button without its aria-hidden glyphs: the reply button has no aria-label (SLICE-UX-07).
    const shown = (b: Element): string => b.getAttribute('aria-label')
      ?? [...b.childNodes].filter((n) => !(n instanceof Element && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join('');
    expect([...container.querySelectorAll('button')].map(shown)).toEqual([
      'tb', 'björn after nine', 'card', 'chip', 'retry',
    ]);
    const main = container.querySelector('.d-message-row__main')!;
    expect([...main.children].map((c) => c.className.split(' ')[0])).toEqual([
      'd-message-row__head', 'd-message-row__toolbar', 'd-message-row__reply', 'd-message-row__body',
      'd-message-row__attachments', 'd-message-row__reactions', 'd-message-row__pending',
    ]);
  });

  it('the reply line is named by its visible text, jumps when the original is held, and says why it cannot when it is not', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const { container, rerender } = render(<MessageRow author="ada" time="21:04" body="yes" state="ok" active
      reply={{ label: 'reply to björn', author: 'björn', excerpt: 'after nine', state: 'ok', jumpLabel: 'go to the original message', onJump }} />);
    const jump = screen.getByRole('button', { name: 'björn after nine' });
    expect(jump).toHaveAccessibleDescription('reply to björn go to the original message');
    expect(jump).not.toHaveAttribute('aria-label');
    expect(jump).toHaveTextContent('björn');
    expect(jump).toHaveTextContent('after nine');
    await user.click(jump);
    expect(onJump).toHaveBeenCalledTimes(1);
    rerender(<MessageRow author="ada" time="21:04" body="yes" state="ok" active
      reply={{ label: 'reply to someone', author: '', excerpt: '', state: 'missing', stateText: 'the original message cannot be shown here', jumpLabel: 'go to the original message' }} />);
    expect(container.querySelector('.d-message-row__reply button')).toBeNull();
    expect(container.querySelector('.d-message-row__reply')).toHaveAttribute('data-state', 'missing');
    expect(screen.getByText('the original message cannot be shown here')).toHaveClass('d-message-row__reply-state');
    rerender(<MessageRow author="ada" time="21:04" body="yes" state="ok" active
      reply={{ label: 'reply to björn', author: 'björn', excerpt: '', state: 'deleted', stateText: 'the original message was deleted', jumpLabel: 'go to the original message' }} />);
    expect(screen.getByText('the original message was deleted')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("keeps an inactive row's own buttons out of the tab order", () => {
    const props = {
      author: 'mira', time: '21:05', body: 'count me in', state: 'failed' as const, stateLabel: 'not sent', detail: 'E_TOO_LARGE',
      actions: [{ label: 'retry', onAction: () => {} }],
      reply: { label: 'reply to ada', author: 'ada', excerpt: 'meet at nine', state: 'ok' as const, jumpLabel: 'go to the original message', onJump: () => {} },
      pendingAction: { label: 'not saved', tone: 'failed' as const, actions: [{ label: 'discard', onAction: () => {} }] },
    };
    const { container, rerender } = render(<MessageRow {...props} active={false} />);
    expect([...container.querySelectorAll('button')].map((b) => b.tabIndex)).toEqual([-1, -1, -1]);
    rerender(<MessageRow {...props} active />);
    expect([...container.querySelectorAll('button')].map((b) => b.tabIndex)).toEqual([0, 0, 0]);
  });

  it('Escape inside the row returns focus to the row; keys on the row go to onKeyDown', () => {
    const onKeyDown = vi.fn();
    const { container } = render(<MessageRow author="ada" time="21:04" body="x" state="ok" active onKeyDown={onKeyDown}
      toolbar={<button type="button">tb</button>} />);
    const row = container.querySelector('article')!;
    const tb = screen.getByRole('button', { name: 'tb' });
    tb.focus();
    fireEvent.keyDown(tb, { key: 'Escape' });
    expect(row).toHaveFocus();
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: 'Escape' });
    fireEvent.keyDown(row, { key: 'ArrowUp' });
    expect(onKeyDown.mock.calls.map((c) => (c[0] as KeyboardEvent).key)).toEqual(['Escape', 'ArrowUp']);
  });

  it('shows the pending action with its tone and its buttons, the editor in place of the body, and the flash', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { container, rerender } = render(<MessageRow author="ada" time="21:04" body="meet at nine" state="ok" active
      pendingAction={{ label: 'not saved', tone: 'failed', actions: [{ label: 'retry', onAction: retry }] }} />);
    const line = container.querySelector('.d-message-row__pending')!;
    expect(line).toHaveAttribute('data-tone', 'failed');
    expect(line).toHaveTextContent('not saved');
    await user.click(screen.getByRole('button', { name: 'retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<MessageRow author="ada" time="21:04" body="meet at nine" state="ok" flash editor={<textarea aria-label="edit your message" />} />);
    expect(container.querySelector('.d-message-row__body')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'edit your message' })).toBeInTheDocument();
    expect(container.querySelector('article')).toHaveAttribute('data-flash', 'true');
  });

  it('attaches rowRef to the article', () => {
    const ref = { current: null as HTMLElement | null };
    render(<MessageRow author="ada" time="21:04" body="x" state="ok" rowRef={ref} />);
    expect(ref.current?.tagName).toBe('ARTICLE');
  });

  it('has no serious axe violations with every part shown', async () => {
    const { container } = render(<div className="d-root" role="log" aria-label="messages in #general"><MessageRow author="ada" time="21:04" state="ok" active
      editedLabel="edited" pinnedLabel="pinned" mention seq="4" msgId={MSG}
      body={[{ kind: 'text', text: 'see ' }, { kind: 'mention', label: '@mira', me: false, broadcast: false }]}
      toolbar={<div role="toolbar" aria-label="actions for this message"><button type="button">react</button></div>}
      reply={{ label: 'reply to björn', author: 'björn', excerpt: 'after nine', state: 'ok', jumpLabel: 'go to the original message', onJump: () => {} }}
      reactions={<div role="group" aria-label="reactions"><button type="button" aria-pressed="true" aria-label="thumbs up, 3">👍 3</button></div>}
      pendingAction={{ label: 'saving…', tone: 'pending' }} /></div>);
    await expectNoAxeViolations(container);
  });
});
