import { useEffect, useState, useSyncExternalStore } from 'react';
import { SETTINGS } from '@dilla/client-core';
import { Banner, isPushToTalkKey, VoiceSettings, type CaptureKeyAction } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { getProcessorStatus, subscribeProcessorStatus } from '../../call/processor-status.ts';
import { noiseBuildMode, noisePreference } from '../../../../media/src/audio/noise-preference';
import { MicrophoneTest } from './MicrophoneTest.tsx';
import { t } from '../../strings/index.ts';

const TITLE_ID = 'voice-settings-title';
// L-TS-54: a device id the browser gave, as the settings key accepts it.
const DEVICE_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;

interface Device { id: string; label: string }

/**
 * The devices to choose from, read only once the microphone permission was granted: before that the browser lists no
 * labels, and asking for the list must not open a permission prompt from Settings. '' (the system default) is always there.
 * A browser that cannot query the `microphone` permission (Firefox throws) is read by its list: labelled devices are
 * listed only after a grant (review m2).
 */
function useDevices(): { inputs: Device[]; outputs: Device[]; granted: boolean } {
  const [lists, setLists] = useState<{ inputs: Device[]; outputs: Device[]; granted: boolean }>({ inputs: [], outputs: [], granted: false });
  useEffect(() => {
    let live = true;
    const read = async () => {
      const permissions = (navigator as { permissions?: Permissions }).permissions;
      const media = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
      if (media === undefined) return;
      let state: PermissionState | 'unknown' = 'unknown';
      try {
        if (permissions !== undefined) state = (await permissions.query({ name: 'microphone' })).state;
      } catch {
        state = 'unknown';
      }
      if (state !== 'granted' && state !== 'unknown') return;
      const all = await media.enumerateDevices();
      if (state === 'unknown' && !all.some(d => d.kind === 'audioinput' && d.label !== '')) return;
      const pick = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId !== 'default' && DEVICE_ID.test(d.deviceId))
        .map(d => ({ id: d.deviceId, label: d.label !== '' ? d.label : d.deviceId.slice(0, 8) }));
      if (live) setLists({ inputs: pick('audioinput'), outputs: pick('audiooutput'), granted: true });
    };
    read().catch(() => undefined);
    return () => { live = false; };
  }, []);
  return lists;
}

const LEVEL_EVERY_MS = 120;
/** The meter's 12 steps from the input's RMS (0..1); 0.25 RMS, a loud voice close to the microphone, fills it. */
const levelOf = (rms: number): number => Math.min(12, Math.round(rms * 48));

/**
 * The input level for the Settings meter (task-9 ruling): once the microphone permission was granted, the chosen input
 * is opened and read through an AnalyserNode every 120 ms; it is released when the section goes or the input changes.
 * Nothing is opened before a grant, so Settings never raises a permission prompt.
 */
function useInputLevel(granted: boolean, input: string): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const media = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
    const Ctx = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!granted || media === undefined || Ctx === undefined) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const release = () => {
      if (timer !== null) clearInterval(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
      void ctx?.close().catch(() => undefined);
      stream = null;
      ctx = null;
    };
    const open = async () => {
      const got = await media.getUserMedia({ audio: input === '' ? true : { deviceId: { exact: input } } });
      stream = got;
      if (stopped) { release(); return; }
      ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(got).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const x of buffer) sum += x * x;
        setLevel(levelOf(Math.sqrt(sum / buffer.length)));
      }, LEVEL_EVERY_MS);
    };
    open().catch(() => undefined);
    return () => { stopped = true; release(); setLevel(0); };
  }, [granted, input]);
  return level;
}

/**
 * Settings → Voice (flow 06): input and output device, voice activity or push to talk with its key, and noise
 * suppression, each written with setSetting. The section keeps no copy of a setting and renders what the worker
 * republishes. A stored push-to-talk key that is not one non-text key on its own shows as unset (task-8b ruling I2).
 */
export function Voice(): React.JSX.Element {
  const client = useCore();
  const settings = useSlice('settings') ?? {};
  const { inputs, outputs, granted } = useDevices();
  const call = useSlice('call');
  const inCall = call !== undefined && ['joining', 'in', 'paused', 'leaving'].includes(call.phase);
  const [testOpen, setTestOpen] = useState(false);
  const status = useSyncExternalStore(subscribeProcessorStatus, getProcessorStatus);
  const level = useInputLevel(granted && !inCall && !testOpen, settings[SETTINGS.voiceInput] ?? '');
  const noise = noisePreference(settings[SETTINGS.voiceNoise]);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<UiError | null>(null);
  const write = (key: string, value: string | null) => {
    setError(null);
    client.call({ m: 'setSetting', key, value }).catch((e: unknown) => setError(errorOf(e)));
  };
  const stored = settings[SETTINGS.voicePttKey];
  const pttKey = stored !== undefined && isPushToTalkKey(stored) ? stored : null;
  const onCaptureKey = (action: CaptureKeyAction) => {
    if (action === 'start') { setCapturing(true); return; }
    setCapturing(false);
    if (action !== 'cancel' && isPushToTalkKey(action.code)) write(SETTINGS.voicePttKey, action.code);
  };
  // web3.3 fix round 1 (I1): call audio plays through the call’s AudioContext (webAudioMix), so the output is chosen
  // there; a browser whose AudioContext cannot (Firefox) plays on the system default whatever an element could do.
  const canSelectOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID} data-doc-state="voice-settings">
      <h2 id={TITLE_ID} tabIndex={-1}>{t('settings.voice.section')}</h2>
      {error === null ? null : <Banner tone="danger">{t('settings.error.other', { code: error.code })}</Banner>}
      <VoiceSettings inputs={inputs} outputs={outputs} input={settings[SETTINGS.voiceInput] ?? ''} output={settings[SETTINGS.voiceOutput] ?? ''}
        canSelectOutput={canSelectOutput} mode={settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad'} pttKey={pttKey}
        capturing={capturing} noise={noise} level={level}
        levelUnavailable={inCall || testOpen ? t('settings.voice.levelUnavailable') : undefined}
        labels={{ input: t('settings.voice.input'), output: t('settings.voice.output'), systemDefault: t('settings.voice.systemDefault'),
          outputUnsupported: t('settings.voice.outputUnsupported'), mode: t('settings.voice.mode'), vad: t('settings.voice.vad'),
          ptt: t('settings.voice.ptt'), pttKey: t('settings.voice.pttKey'), pttNone: t('settings.voice.pttNone'), pttSet: t('settings.voice.pttSet'),
          pttPrompt: t('settings.voice.pttPrompt'), pttRefused: t('settings.voice.pttRefused'), noise: t('settings.voice.noise'), automatic: t(noiseBuildMode === 'beta' ? 'settings.voice.automaticBeta' : 'settings.voice.automatic'), lightweight: t('settings.voice.lightweight'), off: t('settings.voice.off'),
          level: t('settings.voice.level') }}
        onInput={id => write(SETTINGS.voiceInput, id === '' ? null : id)}
        onOutput={id => write(SETTINGS.voiceOutput, id === '' ? null : id)}
        onMode={mode => write(SETTINGS.voiceMode, mode)}
        onCaptureKey={onCaptureKey}
        onNoise={mode => write(SETTINGS.voiceNoise, mode)} />
      {noiseBuildMode === 'beta' ? <p>{t('settings.voice.noiseBeta')}</p> : null}
      {noise === 'automatic' && status === null ? <p>{t('settings.voice.noisePending')}</p> : null}
      {status === null ? null : <p role="status">
        {t('settings.voice.processor', {processor: (status.effective === 'off' || (status.effective === 'browser' && status.browserNoise === 'off')) ? t('settings.voice.processor.off') : status.effective === 'browser' ? t('settings.voice.processor.browser') : status.effective === 'failed' ? t('settings.voice.processor.failed') : status.effective === 'initializing' ? t('settings.voice.processor.initializing') : status.engineName ?? t('settings.voice.lightweight')})}{' '}
        {status.reason === null ? null : t(`settings.voice.fallback.${status.reason}`)}{' '}
        {status.browserNoise === 'unknown' ? t('settings.voice.browserUnknown') : noise === 'off' && status.browserNoise === 'on' ? t('settings.voice.browserStillOn') : null}
      </p>}
      <MicrophoneTest input={settings[SETTINGS.voiceInput] ?? ''} noise={noise} disabled={inCall} onOpen={setTestOpen} />
    </section>
  );
}
