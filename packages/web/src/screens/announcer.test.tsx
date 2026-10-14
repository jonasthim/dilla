import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAnnouncer } from './announcer.ts';

const later = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

describe('useAnnouncer', () => {
  it('announces the same text twice by going empty in between', async () => {
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Saved.'));
    expect(result.current.text).toBe('');
    await later();
    expect(result.current.text).toBe('Saved.');
    act(() => result.current.announce('Saved.'));
    expect(result.current.text).toBe('');
    await later();
    expect(result.current.text).toBe('Saved.');
  });

  it('a newer announcement replaces one still pending', async () => {
    const { result } = renderHook(() => useAnnouncer());
    act(() => { result.current.announce('one'); result.current.announce('two'); });
    await later();
    expect(result.current.text).toBe('two');
  });
});
