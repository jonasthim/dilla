import { useState } from 'react';
import { voiceMusicAdapter, type VoiceMusicAdapter } from '@dilla/client-core';
import { t } from '../../strings/index.ts';

function time(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Authenticated transport is not shipped yet; tests and future clients may inject an explicit adapter. */
export function MusicPanel({ channelId, adapter = voiceMusicAdapter }: {
  channelId: string;
  adapter?: VoiceMusicAdapter;
}): React.JSX.Element {
  const [fullScreen, setFullScreen] = useState(false);
  const state = adapter.state(channelId);
  if (state.status === 'unavailable') {
    return <section className="dw-voice-music" aria-labelledby="dw-voice-music-title" data-availability="unavailable">
      <div className="dw-voice-music__heading">
        <h2 id="dw-voice-music-title">{t('voice.music.title')}</h2>
        <span>{t('voice.music.unavailableBadge')}</span>
      </div>
      <p role="status">{t('voice.music.unavailable')}</p>
    </section>;
  }

  const current = state;
  const track = current.track;
  const control = current.permissions.control;
  const manage = current.permissions.manageQueue;
  const call = (command: () => void | Promise<void>) => { void command(); };
  const queue = <ol className="dw-voice-music__queue" aria-label={t('voice.music.queue')}>
    {current.queue.map((item, index) => <li key={item.id}>
      <span>{item.track.title} <span className="dw-voice-music__artist">{item.track.artist}</span></span>
      <span className="dw-voice-music__queue-actions">
        <button type="button" aria-label={t('voice.music.moveUp', { title: item.track.title })} disabled={!manage || index === 0}
          onClick={() => call(() => adapter.move(channelId, item.id, index - 1))}>{t('voice.music.up')}</button>
        <button type="button" aria-label={t('voice.music.moveDown', { title: item.track.title })} disabled={!manage || index === current.queue.length - 1}
          onClick={() => call(() => adapter.move(channelId, item.id, index + 1))}>{t('voice.music.down')}</button>
        <button type="button" aria-label={t('voice.music.remove', { title: item.track.title })} disabled={!manage}
          onClick={() => call(() => adapter.remove(channelId, item.id))}>{t('voice.music.removeAction')}</button>
      </span>
    </li>)}
  </ol>;

  return <section role={fullScreen ? 'dialog' : undefined}
    className={`dw-voice-music${fullScreen ? ' dw-voice-music--full' : ''}`} aria-labelledby="dw-voice-music-title"
    data-availability="available" data-permission={control ? 'control' : manage ? 'queue' : 'read-only'}>
    <header className="dw-voice-music__heading">
      <h2 id="dw-voice-music-title">{t('voice.music.title')}</h2>
      {fullScreen ? <button type="button" onClick={() => setFullScreen(false)}>{t('voice.music.returnToCall')}</button>
        : <button type="button" className="dw-voice-music__open" onClick={() => setFullScreen(true)}>{t('voice.music.open')}</button>}
    </header>
    <div className="dw-voice-music__content">
      <div className="dw-voice-music__now" aria-live="polite">
        <strong>{track?.title ?? t('voice.music.nothingPlaying')}</strong>
        {track && <span>{track.artist}{track.album ? ` — ${track.album}` : ''}</span>}
      </div>
      {track && <>
        <div className="dw-voice-music__controls" role="group" aria-label={t('voice.music.controls')}>
          <button type="button" disabled={!control} onClick={() => call(() => adapter.pause(channelId, !current.paused))}>
            {t(current.paused ? 'voice.music.play' : 'voice.music.pause')}
          </button>
          <button type="button" disabled={!control} onClick={() => call(() => adapter.skip(channelId))}>{t('voice.music.skip')}</button>
          <button type="button" disabled={!control} onClick={() => call(() => adapter.stop(channelId))}>{t('voice.music.stop')}</button>
          <button type="button" aria-pressed={current.shuffle} disabled={!control}
            onClick={() => call(() => adapter.setShuffle(channelId, !current.shuffle))}>{t('voice.music.shuffle')}</button>
          <label>{t('voice.music.repeat')} <select value={current.repeat} disabled={!control}
            onChange={event => call(() => adapter.setRepeat(channelId, event.currentTarget.value as 'off' | 'one' | 'all'))}>
            <option value="off">{t('voice.music.repeatOff')}</option><option value="one">{t('voice.music.repeatOne')}</option><option value="all">{t('voice.music.repeatAll')}</option>
          </select></label>
        </div>
        <label className="dw-voice-music__seek">{t('voice.music.position', { current: time(current.positionMs), duration: time(track.durationMs) })}
          <input type="range" min="0" max={track.durationMs} value={Math.min(current.positionMs, track.durationMs)} disabled={!control}
            aria-label={t('voice.music.seek')} onChange={event => call(() => adapter.seek(channelId, Number(event.currentTarget.value)))} />
        </label>
      </>}
      <label className="dw-voice-music__volume">{t('voice.music.volume', { volume: current.volume })}
        <input type="range" min="0" max="100" value={current.volume} disabled={!control}
          aria-label={t('voice.music.volumeLabel')} onChange={event => call(() => adapter.setVolume(channelId, Number(event.currentTarget.value)))} />
      </label>
      <div className="dw-voice-music__queue-wrap">
        <h3>{t('voice.music.queue')}</h3>
        {current.queue.length > 0 ? queue : <p>{t('voice.music.queueEmpty')}</p>}
      </div>
    </div>
  </section>;
}
