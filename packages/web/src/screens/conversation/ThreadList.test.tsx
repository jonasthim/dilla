import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ThreadSummary } from '@dilla/client-core';
import { CoreProvider } from '../../core/context.tsx';
import { FakeClient } from '../../test/fake-client.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { en } from '../../strings/index.ts';
import { GEN, O1, P1, P2 } from '../../test/conversation.tsx';
import { ThreadList } from './ThreadList.tsx';

const row = (rootMsgId: string, count: number, lastTs: number, excerpt: string): ThreadSummary => ({ rootMsgId, rootSeq: '1', count, lastTs, excerpt });

function setup(rows: ThreadSummary[] | undefined) {
  const fake = new FakeClient();
  if (rows !== undefined) fake.set(`threads:${GEN}`, rows);
  const onOpen = vi.fn();
  const user = userEvent.setup();
  const view = render(<div className="d-root"><CoreProvider client={fake}>
    <ThreadList channelId={GEN} channelName="general" onOpen={onOpen} />
  </CoreProvider></div>);
  return { fake, user, view, onOpen };
}

describe('ThreadList (web3.7)', () => {
  it('reads the channel’s threads on mount and has a level-two heading', () => {
    const { fake } = setup([]);
    expect(fake.calls).toEqual([{ m: 'loadThreads', channelId: GEN }]);
    expect(screen.getByRole('heading', { level: 2, name: en['thread.list'] })).toBeInTheDocument();
  });
  it('lists one button per thread, newest first, named by its excerpt and count', async () => {
    const { user, onOpen } = setup([row(P1, 1, 10, 'older root'), row(P2, 3, 30, 'newest root'), row(O1, 2, 20, 'middle root')]);
    const names = screen.getAllByRole('button').map(b => b.textContent);
    expect(names).toEqual([
      `newest root · ${en['thread.summary.other'].replace('{count}', '3')}`,
      `middle root · ${en['thread.summary.other'].replace('{count}', '2')}`,
      `older root · ${en['thread.summary.one']}`,
    ]);
    await user.click(screen.getByRole('button', { name: /middle root/ }));
    expect(onOpen).toHaveBeenCalledWith(O1);
  });
  it('says the root is missing for a thread whose root is not held', () => {
    setup([row(P1, 2, 10, '')]);
    expect(screen.getByRole('button')).toHaveTextContent(`${en['thread.rootMissing']} · ${en['thread.summary.other'].replace('{count}', '2')}`);
  });
  it('says there are no threads yet', () => {
    setup([]);
    expect(screen.getByText(en['thread.empty'].replace('{name}', 'general'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('says nothing about being empty until the read has answered', () => {
    setup(undefined);
    expect(screen.queryByText(en['thread.empty'].replace('{name}', 'general'))).toBeNull();
  });
  it('follows the slice when a thread gets a reply', () => {
    const { fake } = setup([row(P1, 1, 10, 'root')]);
    act(() => fake.set(`threads:${GEN}`, [row(P1, 4, 40, 'root')]));
    expect(screen.getByRole('button')).toHaveTextContent(en['thread.summary.other'].replace('{count}', '4'));
  });
  it('says the threads could not be loaded when the read fails', async () => {
    const fake = new FakeClient();
    fake.handler = () => Promise.reject(new Error('x'));
    render(<div className="d-root"><CoreProvider client={fake}><ThreadList channelId={GEN} channelName="general" onOpen={vi.fn()} /></CoreProvider></div>);
    expect(await screen.findByRole('alert')).toHaveTextContent(en['thread.loadFailed']);
  });
  it('keeps list semantics on the rows', () => {
    setup([row(P1, 1, 10, 'root')]);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
  it('has no serious axe violations', async () => {
    const { view } = setup([row(P1, 1, 10, 'root'), row(P2, 2, 20, '')]);
    await expectNoAxeViolations(view.container);
  });
});
