import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAnnouncer } from './announcer.ts';

afterEach(() => { vi.useRealTimers(); });

describe('useAnnouncer', () => {
  it('announces the same text twice by going empty in between', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAnnouncer());
    act(() => result.current.announce('Saved.'));
    expect(result.current.text).toBe('');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.text).toBe('Saved.');
    act(() => { vi.advanceTimersByTime(300); });
    act(() => result.current.announce('Saved.'));
    expect(result.current.text).toBe('');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.text).toBe('Saved.');
  });

  it('speaks announcements made in one tick both, in order', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAnnouncer());
    act(() => { result.current.announce('a'); result.current.announce('b'); });
    expect(result.current.text).toBe('');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.text).toBe('a');
    act(() => { vi.advanceTimersByTime(300); });
    expect(result.current.text).toBe('b');
  });

  it('drops a consecutive duplicate only while it is still queued', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAnnouncer());
    act(() => { result.current.announce('a'); result.current.announce('a'); result.current.announce('b'); });
    const seen: string[] = [];
    let last = '';
    for (let i = 0; i < 12; i++) {
      act(() => { vi.advanceTimersByTime(100); });
      if (result.current.text !== '' && result.current.text !== last) seen.push(result.current.text);
      last = result.current.text;
    }
    expect(seen).toEqual(['a', 'b']);
    act(() => { result.current.announce('b'); });
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.text).toBe('b');
  });
});
