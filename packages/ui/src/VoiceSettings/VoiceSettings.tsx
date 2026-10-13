import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { SettingsRow } from '../SettingsRow/SettingsRow.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { Toggle } from '../Toggle/Toggle.tsx';
import { AudioMeter } from '../AudioMeter/AudioMeter.tsx';
import '../Button/Button.css';
import './VoiceSettings.css';

export type CaptureKeyAction = 'start' | 'cancel' | { code: string };

export interface VoiceSettingsProps {
  inputs: readonly { id: string; label: string }[];
  outputs: readonly { id: string; label: string }[];
  /** The chosen device ids; '' is the system default. */
  input: string;
  output: string;
  /** False where the browser cannot route output (no `setSinkId`): the output row says so instead. */
  canSelectOutput: boolean;
  mode: 'vad' | 'ptt';
  /** The push-to-talk key's shown name, or null: there is no default key (decision 2). */
  pttKey: string | null;
  /** True while the next key press becomes the push-to-talk key. */
  capturing: boolean;
  noise: boolean;
  /** The input meter's level, 0..12. */
  level: number;
  labels: {
    input: string; output: string; systemDefault: string; outputUnsupported: string;
    mode: string; vad: string; ptt: string; pttKey: string; pttNone: string; pttSet: string; pttPrompt: string;
    noise: string; level: string;
  };
  onInput(id: string): void;
  onOutput(id: string): void;
  onMode(mode: 'vad' | 'ptt'): void;
  /** 'start' from the set-key button; then `{ code }` (the KeyboardEvent.code) for any key but Escape, or 'cancel'. */
  onCaptureKey(action: CaptureKeyAction): void;
  onNoise(on: boolean): void;
}

/** A native select of devices, the system default first. */
function DeviceSelect({ id, value, devices, systemDefault, label, onChange }: {
  id: string; value: string; devices: VoiceSettingsProps['inputs']; systemDefault: string; label: string; onChange(id: string): void;
}) {
  return (
    <select id={id} className="d-voice-settings__select" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{systemDefault}</option>
      {devices.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
    </select>
  );
}

/**
 * Settings → Voice (flow 06): input and output devices as native selects, the input mode (voice activity by
 * default, push to talk opt-in) with the push-to-talk key, noise suppression and the input meter. Capturing the key:
 * the set-key button takes focus and the prompt is announced; the next key but Escape is saved without typing
 * anything (Tab still leaves, which cancels); Escape cancels.
 */
export function VoiceSettings({
  inputs, outputs, input, output, canSelectOutput, mode, pttKey, capturing, noise, level, labels,
  onInput, onOutput, onMode, onCaptureKey, onNoise,
}: VoiceSettingsProps) {
  const id = useId();
  const captureRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (capturing) captureRef.current?.focus(); }, [capturing]);

  const onCaptureKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing || e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') onCaptureKey('cancel');
    else onCaptureKey({ code: e.code !== '' ? e.code : e.key });
  };

  return (
    <div className="d-voice-settings">
      <SettingsRow id={`${id}-input`} label={labels.input}>
        <DeviceSelect id={`${id}-input-select`} value={input} devices={inputs} systemDefault={labels.systemDefault} label={labels.input} onChange={onInput} />
      </SettingsRow>
      <SettingsRow id={`${id}-output`} label={labels.output} hint={canSelectOutput ? undefined : labels.outputUnsupported}>
        {canSelectOutput ? (
          <DeviceSelect id={`${id}-output-select`} value={output} devices={outputs} systemDefault={labels.systemDefault} label={labels.output} onChange={onOutput} />
        ) : null}
      </SettingsRow>
      <SettingsRow id={`${id}-mode`} label={labels.mode}>
        <Segmented id={`${id}-mode-group`} label={labels.mode} value={mode}
          options={[{ value: 'vad', label: labels.vad }, { value: 'ptt', label: labels.ptt }]}
          onChange={v => onMode(v === 'ptt' ? 'ptt' : 'vad')} />
      </SettingsRow>
      {mode === 'ptt' ? (
        <SettingsRow id={`${id}-ptt`} label={labels.pttKey}>
          <span className="d-voice-settings__key">
            <kbd className="d-voice-settings__kbd" data-empty={pttKey === null ? 'true' : undefined}>{pttKey ?? labels.pttNone}</kbd>
            <button ref={captureRef} type="button" className="d-btn d-voice-settings__capture" data-variant={capturing ? 'accent' : 'default'} data-size="md"
              aria-describedby={`${id}-prompt`} onKeyDown={onCaptureKeyDown} onBlur={() => { if (capturing) onCaptureKey('cancel'); }}
              onClick={() => { if (!capturing) onCaptureKey('start'); }}>{labels.pttSet}</button>
          </span>
        </SettingsRow>
      ) : null}
      <p id={`${id}-prompt`} className="d-voice-settings__prompt" role="status">{capturing ? labels.pttPrompt : null}</p>
      <SettingsRow id={`${id}-noise`} label={labels.noise}>
        <Toggle id={`${id}-noise-switch`} label={labels.noise} checked={noise} onChange={onNoise} />
      </SettingsRow>
      <SettingsRow id={`${id}-level`} label={labels.level}>
        <AudioMeter level={level} label={labels.level} />
      </SettingsRow>
    </div>
  );
}
