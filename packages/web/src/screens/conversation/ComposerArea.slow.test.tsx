import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PERM } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { account } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { INITIAL_UI } from './Conversation.tsx';
import { ComposerArea, type ComposerAreaProps } from './ComposerArea.tsx';
import { nameBook } from '../shell-model.ts';

const GEN = 'c3'.repeat(16);
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

function area(over: Partial<ComposerAreaProps> = {}, fake = new FakeClient()) {
  fake.set('account', account());
  const props: ComposerAreaProps = {
    channelId: GEN, label: 'message #general', placeholder: 'message #general', blocked: null, broadcast: true, channelName: 'general',
    encodeWith: [], candidates: [], items: [], book: nameBook(null, []), draft: '', onDraft: vi.fn(), ui: INITIAL_UI, dispatch: vi.fn(),
    onSend: vi.fn(), onError: vi.fn(), ...over,
  };
  const view = render(<div className="d-root"><CoreProvider client={fake}><ComposerArea {...props} /></CoreProvider></div>);
  const rerender = (next: Partial<ComposerAreaProps>) => view.rerender(<div className="d-root"><CoreProvider client={fake}><ComposerArea {...props} {...next} /></CoreProvider></div>);
  return { fake, view, rerender };
}
const notice = () => document.querySelector('.d-composer__notice');
const waitText = (seconds: number) => en['slow.wait'].replace('{time}', `0:${String(seconds).padStart(2, '0')}`);
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('the slow-mode countdown (web3.7)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows the wait at 10 s, 1 s and then nothing at 0, once a second, and the box stays enabled', () => {
    area({ slow: { until: T0 + 10_000, queued: false }, bypass: false });
    expect(notice()).toHaveTextContent(waitText(10));
    const box = screen.getByRole('textbox', { name: 'message #general' });
    expect(box).not.toHaveAttribute('aria-disabled');
    tick(1000);
    expect(notice()).toHaveTextContent(waitText(9));
    tick(8000);
    expect(notice()).toHaveTextContent(waitText(1));
    tick(1000);
    expect(notice()).toBeNull();
    expect(box).not.toHaveAttribute('aria-disabled');
  });
  it('is over exactly at the deadline, not at the next whole second', () => {
    area({ slow: { until: T0 + 10_400, queued: false }, bypass: false });
    tick(10_399);
    expect(notice()).toHaveTextContent(waitText(1));
    tick(1);
    expect(notice()).toBeNull();
  });
  it('still reaches zero when its timer fires a fraction of a millisecond early', () => {
    area({ slow: { until: T0 + 10_400, queued: false }, bypass: false });
    const real = Date.now.bind(Date);
    // At the deadline itself the clock reads 1 ms short, as it does for a timer that fires early.
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      const v = real();
      return v === T0 + 10_400 ? v - 1 : v;
    });
    tick(10_400);
    tick(1);
    expect(notice()).toBeNull();
    spy.mockRestore();
  });
  it('stops its timer at 0', () => {
    area({ slow: { until: T0 + 2000, queued: false }, bypass: false });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    tick(3000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shows nothing for a person who bypasses slow mode', () => {
    area({ slow: { until: T0 + 10_000, queued: true }, bypass: true });
    expect(notice()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reads the bypass right from the channel bits when no flag is given', () => {
    area({ slow: { until: T0 + 10_000, queued: false }, bits: PERM.sendMessages | PERM.bypassSlowmode });
    expect(notice()).toBeNull();
  });
  it('reads the slow slice of its channel when no state is given', () => {
    const fake = new FakeClient();
    fake.set(`slow:${GEN}`, { until: T0 + 5000, queued: false });
    area({ bypass: false }, fake);
    expect(notice()).toHaveTextContent(waitText(5));
  });
  it('treats a queued slice whose time has passed as over (CB2)', () => {
    const announce = vi.fn();
    area({ slow: { until: T0 - 1, queued: true }, bypass: false, announce });
    expect(notice()).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'message #general' })).not.toHaveAttribute('aria-disabled');
  });
  it('adds the queued line and announces it once', () => {
    const announce = vi.fn();
    const { rerender } = area({ slow: { until: T0 + 10_000, queued: true }, bypass: false, announce });
    expect(notice()).toHaveTextContent(en['slow.queued']);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(en['slow.queued']);
    tick(3000);
    rerender({ slow: { until: T0 + 10_000, queued: true }, bypass: false, announce: text => { announce(text); } });
    expect(announce).toHaveBeenCalledTimes(1);
  });
  it('speaks the countdown on a change of minute or of 10 s step, not every second', () => {
    area({ slow: { until: T0 + 125_000, queued: false }, bypass: false });
    const spoken = () => document.querySelector('.d-sr-only[role="status"][data-slow]')?.textContent ?? '';
    const seen: string[] = [];
    const note = () => { const s = spoken(); if (seen.at(-1) !== s) seen.push(s); };
    note();
    for (let i = 0; i < 125; i++) { tick(1000); note(); }
    // 125 s: minutes 3, 2, then 10 s steps 6 … 1, and empty at the end.
    expect(seen).toEqual([
      'Slow mode is on. You can send again in 2:05.', 'Slow mode is on. You can send again in 2:00.',
      'Slow mode is on. You can send again in 1:00.', 'Slow mode is on. You can send again in 0:50.',
      'Slow mode is on. You can send again in 0:40.', 'Slow mode is on. You can send again in 0:30.',
      'Slow mode is on. You can send again in 0:20.', 'Slow mode is on. You can send again in 0:10.', '',
    ]);
  });
  it('has no serious axe violations while counting down', async () => {
    vi.useRealTimers();
    const { view } = area({ slow: { until: Date.now() + 60_000, queued: true }, bypass: false });
    await expectNoAxeViolations(view.container);
  });
});

describe('an announcement channel for a reader (web3.7)', () => {
  const SEND_LESS = PERM.viewChannel;
  it('says it is read-only once (walk 6), as the reason that disables the box', () => {
    area({ announcement: true, bits: SEND_LESS });
    const text = en['announce.readOnly'].replace('{name}', 'general');
    expect(notice()).toBeNull();
    expect(screen.getAllByText(text)).toHaveLength(1);
    const box = screen.getByRole('textbox', { name: 'message #general' });
    expect(box).toHaveAttribute('aria-disabled', 'true');
    expect(box).toHaveAccessibleDescription(new RegExp(text.replace(/[.#]/g, '\\$&')));
    expect(screen.getByRole('button', { name: en['shell.composer.send'] })).toBeDisabled();
  });
  it('is the ordinary composer for someone who may post', () => {
    area({ announcement: true, bits: PERM.viewChannel | PERM.sendMessages });
    expect(notice()).toBeNull();
    expect(screen.getByRole('textbox', { name: 'message #general' })).not.toHaveAttribute('aria-disabled');
  });
  it('keeps the ordinary reason in a channel that is not an announcement channel', () => {
    area({ announcement: false, bits: SEND_LESS });
    expect(notice()).toBeNull();
    expect(screen.getByText(en['chperm.cannotSend'].replace('{name}', 'general'))).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { view } = area({ announcement: true, bits: SEND_LESS });
    await expectNoAxeViolations(view.container);
  });
});
