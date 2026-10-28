import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Segmented } from '../Segmented/Segmented.tsx';
import { AudioMeter } from '../AudioMeter/AudioMeter.tsx';
import '../Button/Button.css';
import './VoiceSettings.css';

/** A captured push-to-talk key: the KeyboardEvent.code and the modifiers held with it. */
export interface CapturedKey { code: string; ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }
export type CaptureKeyAction = 'start' | 'cancel' | CapturedKey;

/** Keys that never stand alone: they wait for the key pressed with them. */
const MODIFIERS = new Set(['Control', 'Alt', 'AltGraph', 'Meta', 'Shift', 'OS', 'Hyper', 'Super', 'CapsLock', 'NumLock', 'Fn', 'FnLock']);
/**
 * The keys push to talk may use (task-8b review I2, superseding the task-7 M9 ruling): non-text keys that neither move
 * focus nor have a browser function, pressed on their own. The voice.pttKey setting stores the KeyboardEvent.code
 * alone, so a combination with Control, Alt, Meta, Shift or AltGr could never be matched and is refused too.
 */
export const PUSH_TO_TALK_KEYS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 12 }, (_, i) => `F${i + 13}`), 'Pause', 'ScrollLock', 'Insert',
]);

/** Whether `code` (a KeyboardEvent.code) may be the push-to-talk key. */
export function isPushToTalkKey(code: string): boolean {
  return PUSH_TO_TALK_KEYS.has(code);
}

/**
 * Whether a captured key is refused as the push-to-talk key: anything but one of PUSH_TO_TALK_KEYS on its own. A key
 * that types text (AltGr included), moves focus or operates the page is refused with or without modifiers.
 */
export function typesOrOperates(e: {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey?: boolean;
  getModifierState?(key: 'AltGraph'): boolean;
}): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey === true || e.getModifierState?.('AltGraph') === true) return true;
  return !isPushToTalkKey(e.code !== undefined && e.code !== '' ? e.code : e.key);
}

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
  noise: 'automatic' | 'lightweight' | 'off';
  /** The input meter's level, 0..12. */
  level: number;
  /** Replaces the meter when capture is owned by a call or microphone test. */
  levelUnavailable?: string;
  labels: {
    input: string; output: string; systemDefault: string; outputUnsupported: string;
    mode: string; vad: string; ptt: string; pttKey: string; pttNone: string; pttSet: string; pttPrompt: string; pttRefused: string;
    noise: string; automatic: string; lightweight: string; off: string; level: string;
    /** The prototype's section headings (README §5.9): Devices, Mic test, Input mode, Processing. */
    devices?: string; test?: string; inputMode?: string; processing?: string;
    /** Under the push-to-talk key: where it works and which keys it takes. */
    pttHint?: string;
    /** The noise suppression row's description for each choice, and its tag (BETA) while Automatic is a beta. */
    noiseHints?: { automatic: string; lightweight: string; off: string };
    noiseTag?: string;
  };
  /** The microphone test (the app's own), drawn in the Mic test section with the level meter. */
  test?: ReactNode;
  onInput(id: string): void;
  onOutput(id: string): void;
  onMode(mode: 'vad' | 'ptt'): void;
  /**
   * 'start' from the set-key button; then the captured key (its KeyboardEvent.code and modifiers) for an accepted key,
   * or 'cancel' on Escape, Tab or leaving the button. A key that types text or operates the page is refused: the
   * prompt says why (`settings.voice.pttRefused`) and the capture goes on.
   */
  onCaptureKey(action: CaptureKeyAction): void;
  onNoise(mode: 'automatic' | 'lightweight' | 'off'): void;
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
 * the set-key button takes focus and the prompt is announced; the next accepted key is saved without typing anything;
 * a key that types text or operates the page is refused with a reason; Tab still leaves, which cancels; Escape cancels.
 */
export function VoiceSettings({
  inputs, outputs, input, output, canSelectOutput, mode, pttKey, capturing, noise, level, levelUnavailable, labels, test,
  onInput, onOutput, onMode, onCaptureKey, onNoise,
}: VoiceSettingsProps) {
  const id = useId();
  const captureRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (capturing) captureRef.current?.focus(); }, [capturing]);

  const [refused, setRefused] = useState(false);
  // WB a11y m7: a second refused key empties the region for a moment, so its text is said again.
  const [blank, setBlank] = useState(false);
  useEffect(() => { if (!capturing) { setRefused(false); setBlank(false); } }, [capturing]);
  useEffect(() => {
    if (!blank) return;
    const timer = setTimeout(() => setBlank(false), 100);
    return () => clearTimeout(timer);
  }, [blank]);

  const onCaptureKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing || e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { onCaptureKey('cancel'); return; }
    if (MODIFIERS.has(e.key)) return;
    if (typesOrOperates(e)) {
      if (refused) setBlank(true);
      setRefused(true);
      return;
    }
    onCaptureKey({ code: e.code !== '' ? e.code : e.key, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey });
  };

  const heading = (text: string | undefined, hid: string) => text ? <h3 id={hid} className="d-voice-settings__heading">{text}</h3> : null;
  const noiseHint = labels.noiseHints?.[noise];
  // README §5.9: four bordered groups (radius 10, 16px padding, 14px apart), each under a micro heading.
  return (
    <div className="d-voice-settings">
      <section className="d-voice-settings__group" aria-labelledby={labels.devices ? `${id}-devices` : undefined}>
        {heading(labels.devices, `${id}-devices`)}
        <div className="d-voice-settings__grid">
          <div className="d-voice-settings__field">
            <label className="d-voice-settings__label" htmlFor={`${id}-input-select`}>{labels.input}</label>
            <DeviceSelect id={`${id}-input-select`} value={input} devices={inputs} systemDefault={labels.systemDefault} label={labels.input} onChange={onInput} />
          </div>
          <div className="d-voice-settings__field">
            {canSelectOutput ? <label className="d-voice-settings__label" htmlFor={`${id}-output-select`}>{labels.output}</label>
              : <span className="d-voice-settings__label">{labels.output}</span>}
            {canSelectOutput ? (
              <DeviceSelect id={`${id}-output-select`} value={output} devices={outputs} systemDefault={labels.systemDefault} label={labels.output} onChange={onOutput} />
            ) : <p className="d-voice-settings__note">{labels.outputUnsupported}</p>}
          </div>
        </div>
      </section>
      <section className="d-voice-settings__group" aria-labelledby={labels.test ? `${id}-test` : undefined}>
        {heading(labels.test, `${id}-test`)}
        {test}
        <div className="d-voice-settings__level">
          <span className="d-voice-settings__label">{labels.level}</span>
          {levelUnavailable === undefined ? <AudioMeter level={level} label={labels.level} /> : <span className="d-voice-settings__note">{levelUnavailable}</span>}
        </div>
      </section>
      <section className="d-voice-settings__group" aria-labelledby={labels.inputMode ? `${id}-mode-heading` : undefined}>
        {heading(labels.inputMode, `${id}-mode-heading`)}
        <div className="d-voice-settings__mode">
          <Segmented id={`${id}-mode-group`} label={labels.mode} value={mode}
            options={[{ value: 'vad', label: labels.vad }, { value: 'ptt', label: labels.ptt }]}
            onChange={v => onMode(v === 'ptt' ? 'ptt' : 'vad')} />
        </div>
        {mode === 'ptt' ? (
          <div className="d-voice-settings__grid d-voice-settings__ptt">
            <div className="d-voice-settings__field">
              <span className="d-voice-settings__label" id={`${id}-ptt-label`}>{labels.pttKey}</span>
              <span className="d-voice-settings__key" role="group" aria-labelledby={`${id}-ptt-label`}>
                <kbd className="d-voice-settings__kbd" data-empty={pttKey === null ? 'true' : undefined} data-listening={capturing ? 'true' : undefined}>{pttKey ?? labels.pttNone}</kbd>
                <button ref={captureRef} type="button" className="d-btn d-voice-settings__capture" data-variant="default" data-size="md"
                  aria-describedby={`${id}-prompt`} onKeyDown={onCaptureKeyDown} onBlur={() => { if (capturing) onCaptureKey('cancel'); }}
                  onClick={() => { if (!capturing) onCaptureKey('start'); }}>{labels.pttSet}</button>
              </span>
              {labels.pttHint ? <span className="d-voice-settings__note">{labels.pttHint}</span> : null}
            </div>
          </div>
        ) : null}
        <p id={`${id}-prompt`} className="d-voice-settings__prompt" role="status">{capturing && !blank ? (refused ? labels.pttRefused : labels.pttPrompt) : null}</p>
      </section>
      <section className="d-voice-settings__group" aria-labelledby={labels.processing ? `${id}-processing` : undefined}>
        {heading(labels.processing, `${id}-processing`)}
        <div className="d-voice-settings__row" role="group" aria-labelledby={`${id}-noise-label`} aria-describedby={noiseHint ? `${id}-noise-hint` : undefined}>
          <span className="d-voice-settings__text">
            <span id={`${id}-noise-label`} className="d-voice-settings__row-label">{labels.noise}{labels.noiseTag ? <span className="d-voice-settings__tag">{labels.noiseTag}</span> : null}</span>
            {noiseHint ? <span id={`${id}-noise-hint`} className="d-voice-settings__row-hint">{noiseHint}</span> : null}
          </span>
          <Segmented id={`${id}-noise-group`} label={labels.noise} value={noise}
            options={[{ value: 'automatic', label: labels.automatic }, { value: 'lightweight', label: labels.lightweight }, { value: 'off', label: labels.off }]}
            onChange={v => onNoise(v === 'automatic' ? 'automatic' : v === 'off' ? 'off' : 'lightweight')} />
        </div>
      </section>
    </div>
  );
}
