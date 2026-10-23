import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { VoiceMusicAdapter, VoiceMusicState } from '@dilla/client-core';
import { MusicPanel } from './MusicPanel.tsx';

type MusicCalls = { [K in Exclude<keyof VoiceMusicAdapter, 'state' | 'subscribe'>]: ReturnType<typeof vi.fn<VoiceMusicAdapter[K]>> };
type TestAdapter = VoiceMusicAdapter & { calls: MusicCalls };

function adapter(permissions = { control: true, manageQueue: true }): TestAdapter {
  const state: Extract<VoiceMusicState, { status: 'available' }> = {
    status: 'available', track: { id: 't1', title: 'North', artist: 'Harbor', durationMs: 180_000 },
    queue: [
      { id: 'q0', track: { id: 't0', title: 'East', artist: 'Harbor', durationMs: 170_000 } },
      { id: 'q1', track: { id: 't2', title: 'South', artist: 'Harbor', durationMs: 190_000 } },
    ],
    positionMs: 30_000, volume: 75, paused: false, shuffle: false, repeat: 'off', permissions,
  };
  let current = state;
  const listeners = new Set<() => void>();
  const calls: MusicCalls = {
    pause: vi.fn<VoiceMusicAdapter['pause']>(), skip: vi.fn<VoiceMusicAdapter['skip']>(),
    stop: vi.fn<VoiceMusicAdapter['stop']>(), seek: vi.fn<VoiceMusicAdapter['seek']>(),
    setVolume: vi.fn<VoiceMusicAdapter['setVolume']>(), setShuffle: vi.fn<VoiceMusicAdapter['setShuffle']>(),
    setRepeat: vi.fn<VoiceMusicAdapter['setRepeat']>(), remove: vi.fn<VoiceMusicAdapter['remove']>(),
    move: vi.fn<VoiceMusicAdapter['move']>(),
    search: vi.fn<VoiceMusicAdapter['search']>(), enqueue: vi.fn<VoiceMusicAdapter['enqueue']>(),
  };
  calls.pause.mockImplementation((_channelId, paused) => {
    current = { ...current, paused };
    listeners.forEach(listener => listener());
  });
  calls.seek.mockImplementation((_channelId, positionMs) => {
    current = { ...current, positionMs };
    listeners.forEach(listener => listener());
  });
  calls.setVolume.mockImplementation((_channelId, volume) => {
    current = { ...current, volume };
    listeners.forEach(listener => listener());
  });
  return {
    state: vi.fn(() => current),
    subscribe: (_channelId, onChange) => { listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    ...calls, calls,
  };
}

describe('MusicPanel', () => {
  it('shows the unavailable state without implying queue data or exposing controls', () => {
    render(<MusicPanel channelId={'ab'.repeat(16)} />);

    expect(screen.getByRole('region', { name: 'Music' })).toHaveAttribute('data-availability', 'unavailable');
    expect(screen.getByRole('status')).toHaveTextContent('Music controls are unavailable until this client supports the authenticated music transport.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('sends playback and queue commands through the injected adapter', async () => {
    const music = adapter();
    const { pause, skip, seek, setVolume, setShuffle, setRepeat, move, remove } = music.calls;
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled());
    const seekSlider = screen.getByRole('slider', { name: 'Seek' });
    fireEvent.pointerDown(seekSlider);
    fireEvent.change(seekSlider, { target: { value: '45000' } });
    fireEvent.pointerUp(seekSlider);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Skip' })).toBeEnabled());
    const volume = screen.getByRole('slider', { name: 'Music volume' });
    fireEvent.pointerDown(volume);
    fireEvent.change(volume, { target: { value: '60' } });
    fireEvent.pointerUp(volume);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Shuffle' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Shuffle' })).toBeEnabled());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });
    await waitFor(() => expect(screen.getByRole('combobox')).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Show queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move South up' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove South from queue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Remove South from queue' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove South from queue' })).toBeEnabled());

    expect(pause).toHaveBeenCalledWith('channel-1', true);
    expect(skip).toHaveBeenCalledWith('channel-1');
    expect(seek).toHaveBeenCalledWith('channel-1', 45_000);
    expect(setVolume).toHaveBeenCalledWith('channel-1', 60);
    expect(setShuffle).toHaveBeenCalledWith('channel-1', true);
    expect(setRepeat).toHaveBeenCalledWith('channel-1', 'all');
    expect(move).toHaveBeenCalledWith('channel-1', 'q1', 0);
    expect(remove).toHaveBeenCalledWith('channel-1', 'q1');
  });

  it('searches YouTube and lets an authorized DJ enqueue a result', async () => {
    const music = adapter();
    music.calls.search.mockResolvedValue([{
      id: 'yt:abcdefghijk', title: 'North', artist: 'Harbor', durationMs: 120_000,
      input: 'https://www.youtube.com/watch?v=abcdefghijk',
    }]);
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search music' }), { target: { value: 'harbor north' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('button', { name: 'Add North to queue' })).toBeInTheDocument();
    expect(music.calls.search).toHaveBeenCalledWith('channel-1', 'harbor north');
    fireEvent.click(screen.getByRole('button', { name: 'Add North to queue' }));
    await waitFor(() => expect(music.calls.enqueue).toHaveBeenCalledWith('channel-1', 'https://www.youtube.com/watch?v=abcdefghijk'));
  });

  it('explains that Spotify URLs are unsupported without submitting them', () => {
    const music = adapter();
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'YouTube or Spotify URL' }), {
      target: { value: 'https://open.spotify.com/track/1234567890123456789012' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add URL to queue' }));

    expect(screen.getByRole('status')).toHaveTextContent("Spotify links aren't supported yet. Paste a YouTube link instead.");
    expect(music.calls.enqueue).not.toHaveBeenCalled();
  });

  it('announces search loading and a retryable failure', async () => {
    const music = adapter();
    let rejectSearch: ((reason: Error) => void) | undefined;
    music.calls.search.mockImplementation(() => new Promise((_resolve, reject) => { rejectSearch = reject; }));
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search music' }), { target: { value: 'harbor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('status')).toHaveTextContent('Searching YouTube…');
    await act(() => { rejectSearch?.(new Error('resolver failed')); return Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('YouTube search failed. Try again.'));
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
  });

  it('announces enqueue loading and a retryable failure', async () => {
    const music = adapter();
    let rejectEnqueue: ((reason: Error) => void) | undefined;
    music.calls.enqueue.mockImplementation(() => new Promise((_resolve, reject) => { rejectEnqueue = reject; }));
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'YouTube or Spotify URL' }), {
      target: { value: 'https://www.youtube.com/watch?v=abcdefghijk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add URL to queue' }));
    expect(screen.getByText('Adding to queue…')).toBeInTheDocument();
    await act(() => { rejectEnqueue?.(new Error('resolver unavailable')); return Promise.resolve(); });
    await waitFor(() => expect(screen.getByText('Could not add that input to the queue. Check it and try again.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add URL to queue' })).toBeEnabled();
  });

  it('refreshes from the adapter subscription after an action succeeds', async () => {
    const music = adapter();
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('reports rejected actions and clears pending state without claiming success', async () => {
    const music = adapter();
    let rejectAction: ((reason: Error) => void) | undefined;
    music.calls.pause.mockImplementation(() => new Promise((_resolve, reject) => { rejectAction = reject; }));
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('status')).toHaveTextContent('Updating music…');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    await act(() => { rejectAction?.(new Error('write failed')); return Promise.resolve(); });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The music update failed. Try again.'));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
  });

  it('keeps seek usable during an in-flight command and coalesces to the final drag value', async () => {
    const music = adapter();
    let resolveFirst: (() => void) | undefined;
    music.calls.seek.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    render(<MusicPanel channelId="channel-1" adapter={music} />);
    const seek = screen.getByRole('slider', { name: 'Seek' });

    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '45000' } });
    fireEvent.pointerUp(seek);
    await waitFor(() => expect(music.calls.seek).toHaveBeenCalledWith('channel-1', 45_000));
    expect(seek).toBeEnabled();

    fireEvent.pointerDown(seek);
    fireEvent.change(seek, { target: { value: '70000' } });
    fireEvent.pointerUp(seek);
    const volume = screen.getByRole('slider', { name: 'Music volume' });
    fireEvent.pointerDown(volume);
    fireEvent.change(volume, { target: { value: '82' } });
    fireEvent.pointerUp(volume);
    expect(seek).toBeEnabled();
    expect(volume).toBeEnabled();
    expect(seek).toHaveValue('70000');
    expect(volume).toHaveValue('82');
    expect(music.calls.seek).toHaveBeenCalledTimes(1);
    expect(music.calls.setVolume).not.toHaveBeenCalled();

    await act(() => { resolveFirst?.(); return Promise.resolve(); });
    await waitFor(() => expect(music.calls.seek).toHaveBeenCalledTimes(2));
    expect(music.calls.seek).toHaveBeenLastCalledWith('channel-1', 70_000);
    await waitFor(() => expect(seek).toHaveValue('70000'));
    expect(music.calls.setVolume).toHaveBeenCalledWith('channel-1', 82);
    await waitFor(() => expect(volume).toHaveValue('82'));
  });

  it('exposes queue management from the desktop player and can collapse it again', async () => {
    const music = adapter();
    const { move, remove } = music.calls;
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    expect(screen.queryByRole('region', { name: 'Queue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show queue' }));
    expect(screen.getByRole('region', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move South up' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move South up' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove South from queue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Remove South from queue' }));
    expect(move).toHaveBeenCalledWith('channel-1', 'q1', 0);
    expect(remove).toHaveBeenCalledWith('channel-1', 'q1');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Hide queue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Hide queue' }));
    expect(screen.queryByRole('region', { name: 'Queue' })).toBeNull();
  });

  it('disables playback and queue mutations without the matching authorization', () => {
    const music = adapter({ control: false, manageQueue: false });
    const { pause, remove } = music.calls;
    render(<MusicPanel channelId="channel-1" adapter={music} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show queue' }));

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move South up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove South from queue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add URL to queue' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeDisabled();
    expect(pause).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('opens a modal phone music view, focuses Return, and restores the opener on Escape', async () => {
    const music = adapter();
    const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    try {
      render(<div data-layout="phone"><MusicPanel channelId="channel-1" adapter={music} /></div>);
      const opener = screen.getByRole('button', { name: 'Open music player' });
      opener.focus();
      fireEvent.click(opener);

      const dialog = screen.getByRole('dialog', { name: 'Music' });
      await waitFor(() => expect(dialog).toHaveAttribute('open'));
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByRole('button', { name: 'Return to call' })).toHaveFocus();
      fireEvent(dialog, new Event('cancel', { cancelable: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(opener).toHaveFocus();

      fireEvent.click(opener);
      const reopened = await screen.findByRole('dialog', { name: 'Music' });
      await waitFor(() => expect(reopened).toHaveAttribute('open'));
      fireEvent.click(screen.getByRole('button', { name: 'Return to call' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(opener).toHaveFocus();
    } finally {
      show.mockRestore();
      close.mockRestore();
    }
  });
});
