import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { VoiceMusicAdapter, VoiceMusicState } from '@dilla/client-core';
import { MusicPanel } from './MusicPanel.tsx';

type MusicCalls = { [K in Exclude<keyof VoiceMusicAdapter, 'state'>]: ReturnType<typeof vi.fn<VoiceMusicAdapter[K]>> };
type TestAdapter = VoiceMusicAdapter & { calls: MusicCalls };

function adapter(permissions = { control: true, manageQueue: true }): TestAdapter {
  const state: VoiceMusicState = {
    status: 'available', track: { id: 't1', title: 'North', artist: 'Harbor', durationMs: 180_000 },
    queue: [
      { id: 'q0', track: { id: 't0', title: 'East', artist: 'Harbor', durationMs: 170_000 } },
      { id: 'q1', track: { id: 't2', title: 'South', artist: 'Harbor', durationMs: 190_000 } },
    ],
    positionMs: 30_000, volume: 75, paused: false, shuffle: false, repeat: 'off', permissions,
  };
  const calls: MusicCalls = {
    pause: vi.fn<VoiceMusicAdapter['pause']>(), skip: vi.fn<VoiceMusicAdapter['skip']>(),
    stop: vi.fn<VoiceMusicAdapter['stop']>(), seek: vi.fn<VoiceMusicAdapter['seek']>(),
    setVolume: vi.fn<VoiceMusicAdapter['setVolume']>(), setShuffle: vi.fn<VoiceMusicAdapter['setShuffle']>(),
    setRepeat: vi.fn<VoiceMusicAdapter['setRepeat']>(), remove: vi.fn<VoiceMusicAdapter['remove']>(),
    move: vi.fn<VoiceMusicAdapter['move']>(),
  };
  return { state: vi.fn(() => state), ...calls, calls };
}

describe('MusicPanel', () => {
  it('shows the unavailable state without implying queue data or exposing controls', () => {
    render(<MusicPanel channelId={'ab'.repeat(16)} />);

    expect(screen.getByRole('region', { name: 'Music' })).toHaveAttribute('data-availability', 'unavailable');
    expect(screen.getByRole('status')).toHaveTextContent('Music controls are unavailable until this client supports the authenticated music transport.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('sends playback and queue commands through the injected adapter', () => {
    const music = adapter();
    const { pause, skip, seek, setVolume, setShuffle, setRepeat, move, remove } = music.calls;
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Seek' }), { target: { value: '45000' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Music volume' }), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move South up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove South from queue' }));

    expect(pause).toHaveBeenCalledWith('channel-1', true);
    expect(skip).toHaveBeenCalledWith('channel-1');
    expect(seek).toHaveBeenCalledWith('channel-1', 45_000);
    expect(setVolume).toHaveBeenCalledWith('channel-1', 60);
    expect(setShuffle).toHaveBeenCalledWith('channel-1', true);
    expect(setRepeat).toHaveBeenCalledWith('channel-1', 'all');
    expect(move).toHaveBeenCalledWith('channel-1', 'q1', 0);
    expect(remove).toHaveBeenCalledWith('channel-1', 'q1');
  });

  it('disables playback and queue mutations without the matching authorization', () => {
    const music = adapter({ control: false, manageQueue: false });
    const { pause, remove } = music.calls;
    render(<MusicPanel channelId="channel-1" adapter={music} />);

    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move South up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove South from queue' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeDisabled();
    expect(pause).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('opens a phone music view and gives the user a direct return to the call', () => {
    const music = adapter();
    render(<div data-layout="phone"><MusicPanel channelId="channel-1" adapter={music} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Open music player' }));

    expect(screen.getByRole('dialog', { name: 'Music' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to call' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
