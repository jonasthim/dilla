import { useEffect, useState } from 'react';
import { SETTINGS } from '@dilla/client-core';
import { Banner, isPushToTalkKey, VoiceSettings, type CaptureKeyAction } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';

const TITLE_ID = 'voice-settings-title';
// L-TS-54: a device id the browser gave, as the settings key accepts it.
const DEVICE_ID = /^[A-Za-z0-9+/=_-]{1,128}$/;

interface Device { id: string; label: string }

/**
 * The devices to choose from, read only once the microphone permission was granted: before that the browser lists no
 * labels, and asking for the list must not open a permission prompt from Settings. '' (the system default) is always there.
 */
function useDevices(): { inputs: Device[]; outputs: Device[] } {
  const [lists, setLists] = useState<{ inputs: Device[]; outputs: Device[] }>({ inputs: [], outputs: [] });
  useEffect(() => {
    let live = true;
    const read = async () => {
      const permissions = (navigator as { permissions?: Permissions }).permissions;
      const media = (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
      if (permissions === undefined || media === undefined) return;
      const status = await permissions.query({ name: 'microphone' });
      if (status.state !== 'granted') return;
      const all = await media.enumerateDevices();
      const pick = (kind: MediaDeviceKind) => all.filter(d => d.kind === kind && d.deviceId !== 'default' && DEVICE_ID.test(d.deviceId))
        .map(d => ({ id: d.deviceId, label: d.label !== '' ? d.label : d.deviceId.slice(0, 8) }));
      if (live) setLists({ inputs: pick('audioinput'), outputs: pick('audiooutput') });
    };
    read().catch(() => undefined);
    return () => { live = false; };
  }, []);
  return lists;
}

/**
 * Settings → Voice (flow 06): input and output device, voice activity or push to talk with its key, and noise
 * suppression, each written with setSetting. The section keeps no copy of a setting and renders what the worker
 * republishes. A stored push-to-talk key that is not one non-text key on its own shows as unset (task-8b ruling I2).
 */
export function Voice(): React.JSX.Element {
  const client = useCore();
  const settings = useSlice('settings') ?? {};
  const { inputs, outputs } = useDevices();
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
  const canSelectOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID} data-doc-state="voice-settings">
      <h2 id={TITLE_ID} tabIndex={-1}>{t('settings.voice.section')}</h2>
      {error === null ? null : <Banner tone="danger">{t('settings.error.other', { code: error.code })}</Banner>}
      <VoiceSettings inputs={inputs} outputs={outputs} input={settings[SETTINGS.voiceInput] ?? ''} output={settings[SETTINGS.voiceOutput] ?? ''}
        canSelectOutput={canSelectOutput} mode={settings[SETTINGS.voiceMode] === 'ptt' ? 'ptt' : 'vad'} pttKey={pttKey}
        capturing={capturing} noise={settings[SETTINGS.voiceNoise] !== 'off'} level={0}
        labels={{ input: t('settings.voice.input'), output: t('settings.voice.output'), systemDefault: t('settings.voice.systemDefault'),
          outputUnsupported: t('settings.voice.outputUnsupported'), mode: t('settings.voice.mode'), vad: t('settings.voice.vad'),
          ptt: t('settings.voice.ptt'), pttKey: t('settings.voice.pttKey'), pttNone: t('settings.voice.pttNone'), pttSet: t('settings.voice.pttSet'),
          pttPrompt: t('settings.voice.pttPrompt'), pttRefused: t('settings.voice.pttRefused'), noise: t('settings.voice.noise'),
          level: t('settings.voice.level') }}
        onInput={id => write(SETTINGS.voiceInput, id === '' ? null : id)}
        onOutput={id => write(SETTINGS.voiceOutput, id === '' ? null : id)}
        onMode={mode => write(SETTINGS.voiceMode, mode)}
        onCaptureKey={onCaptureKey}
        onNoise={on => write(SETTINGS.voiceNoise, on ? 'on' : 'off')} />
    </section>
  );
}
