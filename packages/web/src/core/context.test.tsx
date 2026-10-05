import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CoreProvider, useCore } from './context.tsx';
import { useSlice } from './use-slice.ts';
import { FakeClient } from '../test/fake-client.ts';

let renders = 0;
function Probe() {
  const c = useSlice('connection');
  renders += 1;
  return <p>{c === undefined ? 'none' : `${c.status} ${c.generation ?? '-'}`}</p>;
}

describe('useSlice', () => {
  it('reads a slice, follows it and ignores other slices', () => {
    const fake = new FakeClient();
    renders = 0;
    render(<CoreProvider client={fake}><Probe /></CoreProvider>);
    expect(screen.getByText('none')).toBeInTheDocument();
    act(() => fake.set('connection', { status: 'online', generation: '7' }));
    expect(screen.getByText('online 7')).toBeInTheDocument();
    const after = renders;
    act(() => fake.set('communities', []));
    expect(renders).toBe(after);
  });
});

describe('useCore', () => {
  it('throws outside a provider', () => {
    function Bare() { useCore(); return null; }
    expect(() => render(<Bare />)).toThrow('useCore: no CoreProvider');
  });
});
