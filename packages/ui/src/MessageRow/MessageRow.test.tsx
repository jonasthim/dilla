import { render, screen } from '@testing-library/react';
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
});
