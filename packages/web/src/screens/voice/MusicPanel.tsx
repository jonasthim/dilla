import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { voiceMusicAdapter, type VoiceMusicAdapter } from '@dilla/client-core';
import { t } from '../../strings/index.ts';

function time(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const RANGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/** Authenticated transport is not shipped yet; tests and future clients may inject an explicit adapter. */
export function MusicPanel({ channelId, adapter = voiceMusicAdapter }: {
  channelId: string;
  adapter?: VoiceMusicAdapter;
}): React.JSX.Element {
  const [fullScreen, setFullScreen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const pendingRef = useRef(false);
  const queuedSliders = useRef(new Map<'seek' | 'volume', () => void | Promise<void>>());
  const seekEditing = useRef(false);
  const volumeEditing = useRef(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const subscribe = useCallback((onChange: () => void) => adapter.subscribe(channelId, onChange), [adapter, channelId]);
  const getSnapshot = useCallback(() => adapter.state(channelId), [adapter, channelId]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!fullScreen) return;
    const element = dialog.current;
    const opener = openButton.current;
    if (element === null) return;
    if (!element.open) element.showModal();
    returnButton.current?.focus();
    return () => {
      if (element.open) element.close();
      opener?.focus();
    };
  }, [fullScreen, state.status]);
  if (state.status === 'unavailable') {
    // Installation status is only readable by community managers, so ordinary voice members have no reliable UI gate.
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
  const execute = (command: () => void | Promise<void>) => {
    pendingRef.current = true;
    setPending(true);
    setActionError(false);
    const finish = (failed: boolean) => {
      if (failed) setActionError(true);
      const nextQueued = queuedSliders.current.entries().next();
      if (!nextQueued.done) {
        const [key, next] = nextQueued.value;
        queuedSliders.current.delete(key);
        execute(next);
        return;
      }
      pendingRef.current = false;
      setPending(false);
      if (!failed) {
        if (!seekEditing.current) setSeekDraft(null);
        if (!volumeEditing.current) setVolumeDraft(null);
      }
    };
    try {
      void Promise.resolve(command()).then(() => finish(false), () => finish(true));
    } catch {
      finish(true);
    }
  };
  const run = (command: () => void | Promise<void>) => {
    if (!pendingRef.current) execute(command);
  };
  const runSlider = (key: 'seek' | 'volume', command: () => void | Promise<void>) => {
    if (pendingRef.current) queuedSliders.current.set(key, command);
    else execute(command);
  };
  const queue = <ol className="dw-voice-music__queue" aria-label={t('voice.music.queue')}>
    {current.queue.map((item, index) => <li key={item.id}>
      <span>{item.track.title} <span className="dw-voice-music__artist">{item.track.artist}</span></span>
      <span className="dw-voice-music__queue-actions">
        <button type="button" aria-label={t('voice.music.moveUp', { title: item.track.title })} disabled={pending || !manage || index === 0}
          onClick={() => run(() => adapter.move(channelId, item.id, index - 1))}>{t('voice.music.up')}</button>
        <button type="button" aria-label={t('voice.music.moveDown', { title: item.track.title })} disabled={pending || !manage || index === current.queue.length - 1}
          onClick={() => run(() => adapter.move(channelId, item.id, index + 1))}>{t('voice.music.down')}</button>
        <button type="button" aria-label={t('voice.music.remove', { title: item.track.title })} disabled={pending || !manage}
          onClick={() => run(() => adapter.remove(channelId, item.id))}>{t('voice.music.removeAction')}</button>
      </span>
    </li>)}
  </ol>;

  const heading = <header className="dw-voice-music__heading">
      <h2 id="dw-voice-music-title">{t('voice.music.title')}</h2>
      <button type="button" aria-expanded={queueOpen} aria-controls="dw-voice-music-queue"
        onClick={() => setQueueOpen(open => !open)}>{t(queueOpen ? 'voice.music.hideQueue' : 'voice.music.showQueue')}</button>
      <button ref={openButton} type="button" className="dw-voice-music__open" onClick={() => { setQueueOpen(true); setFullScreen(true); }}>{t('voice.music.open')}</button>
    </header>;
  const dialogHeading = <header className="dw-voice-music__heading">
    <h2>{t('voice.music.title')}</h2>
    <button ref={returnButton} type="button" onClick={() => setFullScreen(false)}>{t('voice.music.returnToCall')}</button>
  </header>;
  const content = <div className="dw-voice-music__content">
      <div className="dw-voice-music__now" aria-live="polite">
        <strong>{track?.title ?? t('voice.music.nothingPlaying')}</strong>
        {track && <span>{track.artist}{track.album ? ` — ${track.album}` : ''}</span>}
      </div>
      {track && <>
        <div className="dw-voice-music__controls" role="group" aria-label={t('voice.music.controls')}>
          <button type="button" disabled={pending || !control} onClick={() => run(() => adapter.pause(channelId, !current.paused))}>
            {t(current.paused ? 'voice.music.play' : 'voice.music.pause')}
          </button>
          <button type="button" disabled={pending || !control} onClick={() => run(() => adapter.skip(channelId))}>{t('voice.music.skip')}</button>
          <button type="button" disabled={pending || !control} onClick={() => run(() => adapter.stop(channelId))}>{t('voice.music.stop')}</button>
          <button type="button" aria-pressed={current.shuffle} disabled={pending || !control}
            onClick={() => run(() => adapter.setShuffle(channelId, !current.shuffle))}>{t('voice.music.shuffle')}</button>
          <label>{t('voice.music.repeat')} <select value={current.repeat} disabled={pending || !control}
            onChange={event => run(() => adapter.setRepeat(channelId, event.currentTarget.value as 'off' | 'one' | 'all'))}>
            <option value="off">{t('voice.music.repeatOff')}</option><option value="one">{t('voice.music.repeatOne')}</option><option value="all">{t('voice.music.repeatAll')}</option>
          </select></label>
        </div>
        <label className="dw-voice-music__seek">{t('voice.music.position', { current: time(current.positionMs), duration: time(track.durationMs) })}
          <input type="range" min="0" max={track.durationMs} value={Math.min(seekDraft ?? current.positionMs, track.durationMs)} disabled={!control}
            aria-label={t('voice.music.seek')} onPointerDown={() => { seekEditing.current = true; }}
            onKeyDown={event => { if (RANGE_KEYS.has(event.key)) seekEditing.current = true; }}
            onChange={event => { seekEditing.current = true; setSeekDraft(Number(event.currentTarget.value)); }}
            onPointerUp={event => { const value = Number(event.currentTarget.value); seekEditing.current = false; setSeekDraft(value); runSlider('seek', () => adapter.seek(channelId, value)); }}
            onKeyUp={event => { if (RANGE_KEYS.has(event.key)) { const value = Number(event.currentTarget.value); seekEditing.current = false; setSeekDraft(value); runSlider('seek', () => adapter.seek(channelId, value)); } }}
            onBlur={event => { if (seekEditing.current) { const value = Number(event.currentTarget.value); seekEditing.current = false; setSeekDraft(value); runSlider('seek', () => adapter.seek(channelId, value)); } }} />
        </label>
      </>}
      <label className="dw-voice-music__volume">{t('voice.music.volume', { volume: current.volume })}
        <input type="range" min="0" max="100" value={volumeDraft ?? current.volume} disabled={!control}
          aria-label={t('voice.music.volumeLabel')} onPointerDown={() => { volumeEditing.current = true; }}
          onKeyDown={event => { if (RANGE_KEYS.has(event.key)) volumeEditing.current = true; }}
          onChange={event => { volumeEditing.current = true; setVolumeDraft(Number(event.currentTarget.value)); }}
          onPointerUp={event => { const value = Number(event.currentTarget.value); volumeEditing.current = false; setVolumeDraft(value); runSlider('volume', () => adapter.setVolume(channelId, value)); }}
          onKeyUp={event => { if (RANGE_KEYS.has(event.key)) { const value = Number(event.currentTarget.value); volumeEditing.current = false; setVolumeDraft(value); runSlider('volume', () => adapter.setVolume(channelId, value)); } }}
          onBlur={event => { if (volumeEditing.current) { const value = Number(event.currentTarget.value); volumeEditing.current = false; setVolumeDraft(value); runSlider('volume', () => adapter.setVolume(channelId, value)); } }} />
      </label>
      <div id="dw-voice-music-queue" className="dw-voice-music__queue-wrap" role="region" aria-labelledby="dw-voice-music-queue-title"
        hidden={!queueOpen}>
        <h3 id="dw-voice-music-queue-title">{t('voice.music.queue')}</h3>
        {current.queue.length > 0 ? queue : <p>{t('voice.music.queueEmpty')}</p>}
      </div>
    </div>;
  const attrs = { 'data-availability': 'available', 'data-permission': control ? 'control' : manage ? 'queue' : 'read-only' };
  const status = actionError ? <p role="status">{t('voice.music.actionError')}</p>
    : pending ? <p role="status">{t('voice.music.pending')}</p> : null;
  return <>
    <section className="dw-voice-music" aria-labelledby="dw-voice-music-title" hidden={fullScreen} {...attrs}>
      {heading}{!fullScreen && status}{!fullScreen && content}
    </section>
    {fullScreen && <dialog ref={dialog} className="dw-voice-music dw-voice-music--full" aria-label={t('voice.music.title')} aria-modal="true"
      {...attrs} onCancel={event => { event.preventDefault(); setFullScreen(false); }}>{dialogHeading}{status}{content}</dialog>}
  </>;
}
