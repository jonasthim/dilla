import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageLog } from './MessageLog.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

type Metrics = { scrollHeight: number; clientHeight: number };
function metrics(el: HTMLElement, m: Metrics) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => m.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => m.clientHeight });
}
function log(keys: string[], extra: { earlier?: { label: string; onLoad(): void } } = {}) {
  return (
    <MessageLog label="messages in #general" emptyLabel="No messages yet." earlier={extra.earlier}>
      {keys.map(k => <p key={k}>{k}</p>)}
    </MessageLog>
  );
}

describe('MessageLog', () => {
  it('is a polite log named by its label and reachable by Tab', () => {
    render(log(['a']));
    const el = screen.getByRole('log', { name: 'messages in #general' });
    expect(el).toHaveClass('d-message-log');
    expect(el).toHaveAttribute('aria-live', 'polite');
    expect(el).toHaveAttribute('tabindex', '0');
  });

  it('is busy exactly while the caller says so', () => {
    const { rerender } = render(<MessageLog label="messages in #general" emptyLabel="No messages yet." busy>{[]}</MessageLog>);
    expect(screen.getByRole('log', { name: 'messages in #general' })).toHaveAttribute('aria-busy', 'true');
    rerender(<MessageLog label="messages in #general" emptyLabel="No messages yet.">{[]}</MessageLog>);
    expect(screen.getByRole('log', { name: 'messages in #general' })).not.toHaveAttribute('aria-busy');
    rerender(<MessageLog label="messages in #general" emptyLabel="No messages yet." busy={false}>{[]}</MessageLog>);
    expect(screen.getByRole('log', { name: 'messages in #general' })).not.toHaveAttribute('aria-busy');
  });

  it('shows the empty label only when there are no rows', () => {
    const { rerender } = render(log([]));
    expect(screen.getByText('No messages yet.')).toBeInTheDocument();
    rerender(log(['a']));
    expect(screen.queryByText('No messages yet.')).toBeNull();
  });

  it('offers load earlier as the first control inside the log and calls onLoad', async () => {
    const user = userEvent.setup();
    const onLoad = vi.fn();
    render(log(['a', 'b'], { earlier: { label: 'load earlier', onLoad } }));
    const el = screen.getByRole('log');
    const button = screen.getByRole('button', { name: 'load earlier' });
    expect(el.querySelector('button')).toBe(button);
    expect(el.firstElementChild).toBe(button);
    await user.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('keeps the view pinned to the end while the reader is at the end', () => {
    const { rerender } = render(log(['a']));
    const el = screen.getByRole('log');
    const m = { scrollHeight: 1000, clientHeight: 200 };
    metrics(el, m);
    rerender(log(['a', 'b']));
    expect(el.scrollTop).toBe(1000);
    m.scrollHeight = 1100;
    rerender(log(['a', 'b', 'c']));
    expect(el.scrollTop).toBe(1100);
  });

  it('stays where the reader scrolled to when rows arrive at the end', () => {
    const { rerender } = render(log(['a', 'b']));
    const el = screen.getByRole('log');
    const m = { scrollHeight: 1000, clientHeight: 200 };
    metrics(el, m);
    el.scrollTop = 300;
    fireEvent.scroll(el);
    m.scrollHeight = 1100;
    rerender(log(['a', 'b', 'c']));
    expect(el.scrollTop).toBe(300);
  });

  it('re-pins once the reader scrolls back within 24 px of the end', () => {
    const { rerender } = render(log(['a', 'b']));
    const el = screen.getByRole('log');
    const m = { scrollHeight: 1000, clientHeight: 200 };
    metrics(el, m);
    el.scrollTop = 300;
    fireEvent.scroll(el);
    el.scrollTop = 780;
    fireEvent.scroll(el);
    m.scrollHeight = 1100;
    rerender(log(['a', 'b', 'c']));
    expect(el.scrollTop).toBe(1100);
  });

  it('keeps the reader in place when earlier rows are put in front', () => {
    const { rerender } = render(log(['b', 'c']));
    const el = screen.getByRole('log');
    const m = { scrollHeight: 1000, clientHeight: 200 };
    metrics(el, m);
    rerender(log(['b', 'c']));
    el.scrollTop = 0;
    fireEvent.scroll(el);
    m.scrollHeight = 1400;
    rerender(log(['a', 'b', 'c']));
    expect(el.scrollTop).toBe(400);
  });

  it('never moves focus when rows arrive', () => {
    const { rerender } = render(<><button type="button">elsewhere</button>{log(['a'])}</>);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();
    rerender(<><button type="button">elsewhere</button>{log(['a', 'b'])}</>);
    expect(elsewhere).toHaveFocus();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root">{log(['a', 'b'], { earlier: { label: 'load earlier', onLoad: () => {} } })}</div>);
    await expectNoAxeViolations(container);
  });
});
