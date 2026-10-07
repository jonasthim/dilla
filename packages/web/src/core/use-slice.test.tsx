import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { ChannelSummary } from '@dilla/client-core';
import { CoreProvider } from './context.tsx';
import { useSlices } from './use-slice.ts';
import { FakeClient } from '../test/fake-client.ts';

const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const ch = (id: string, communityId: string, name: string): ChannelSummary =>
  ({ id, communityId, kind: 0, mode: 0, name, topic: '', parentId: null, position: 0, group: 'none' });

let renders = 0;
let lastArray: unknown = null;
function Probe(props: { ids: string[] }) {
  const lists = useSlices(props.ids.map(id => `channels:${id}` as const));
  renders += 1;
  lastArray = lists;
  return <p>{lists.map(l => (l === undefined ? '-' : l.map(c => c.name).join('+'))).join('|')}</p>;
}

describe('useSlices', () => {
  it('reads several slices in order, follows each, and keeps its array for unrelated changes', () => {
    const fake = new FakeClient();
    fake.set(`channels:${A}`, [ch('01'.repeat(16), A, 'general')]);
    renders = 0;
    const view = render(<CoreProvider client={fake}><Probe ids={[A, B]} /></CoreProvider>);
    expect(screen.getByText('general|-')).toBeInTheDocument();
    act(() => fake.set(`channels:${B}`, [ch('02'.repeat(16), B, 'lobby'), ch('03'.repeat(16), B, 'den')]));
    expect(screen.getByText('general|lobby+den')).toBeInTheDocument();
    const before = { renders, lastArray };
    act(() => fake.set('communities', []));
    expect(renders).toBe(before.renders);
    expect(lastArray).toBe(before.lastArray);
    view.rerender(<CoreProvider client={fake}><Probe ids={[B]} /></CoreProvider>);
    expect(screen.getByText('lobby+den')).toBeInTheDocument();
    act(() => fake.set(`channels:${A}`, []));
    expect(screen.getByText('lobby+den')).toBeInTheDocument();
  });
});
