import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { arrowIndex } from '../internal/arrow-select.ts';
import './CallControls.css';

/**
 * Roving focus for a horizontal `role="toolbar"` of buttons (the voice dock and the call controls). One button holds
 * the tab stop: the one that last had focus, initially the first. ArrowLeft and ArrowRight move with wrap, Home and
 * End go to the ends; a key with Alt, Ctrl, Meta or Shift is left alone (Ctrl/⌘+Shift+M and D belong to the shell).
 * An `aria-disabled` button stays in the roving order, so it can be found and read.
 */
export function useToolbarFocus(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [stop, setStop] = useState(0);
  const current = stop < count ? stop : 0;
  const buttons = (): HTMLButtonElement[] => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons();
    const target: EventTarget = e.target;
    const from = target instanceof HTMLButtonElement ? list.indexOf(target) : -1;
    if (from < 0) return;
    const next = arrowIndex(e, from, list.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    setStop(next);
    list[next].focus();
  };
  // A click or a programmatic focus moves the stop too.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const target: EventTarget = e.target;
    const i = target instanceof HTMLButtonElement ? buttons().indexOf(target) : -1;
    if (i >= 0) setStop(i);
  };
  return { ref, onKeyDown, onFocus, tabIndex: (i: number) => (i === current ? 0 : -1) };
}

/**
 * The mute and deafen shortcuts as `aria-keyshortcuts` (flow 06, decision 1): Control or ⌘ with Shift, the web-2c
 * convention of Control/⌘+K, where either modifier works on every platform.
 */
export const VOICE_SHORTCUTS = { mute: 'Control+Shift+M Meta+Shift+M', deafen: 'Control+Shift+D Meta+Shift+D' } as const;

/**
 * One control of a voice toolbar. A toggle (`on` given) is the Button primitive's toggle: `aria-pressed`, the `[x]`
 * mark and the pressed style, with `onLabel` shown while on (mute / unmute). An inert control is aria-disabled.
 */
export interface ToolbarControl {
  id: string; label: string; on?: boolean; onLabel?: string; inert?: boolean; danger?: boolean;
  /** `aria-keyshortcuts`, e.g. VOICE_SHORTCUTS.mute. */
  keys?: string;
  onAction(): void;
}

/** A voice toolbar: the controls as one roving tab stop, named by `label`. */
export function VoiceToolbar({ label, controls, className }: { label: string; controls: readonly ToolbarControl[]; className?: string }): ReactNode {
  const bar = useToolbarFocus(controls.length);
  return (
    <div ref={bar.ref} role="toolbar" aria-label={label} aria-orientation="horizontal"
      className={['d-voice-toolbar', className].filter(Boolean).join(' ')} onKeyDown={bar.onKeyDown} onFocus={bar.onFocus}>
      {controls.map((c, i) => (
        <Button key={c.id} variant={c.danger === true ? 'danger' : 'default'} className="d-voice-toolbar__control" data-control={c.id}
          pressed={c.on} pressedLabel={c.onLabel} aria-keyshortcuts={c.keys}
          aria-disabled={c.inert === true ? true : undefined} tabIndex={bar.tabIndex(i)}
          onClick={() => { if (c.inert !== true) c.onAction(); }}>
          {c.label}
        </Button>
      ))}
    </div>
  );
}

export interface CallControlsProps {
  muted: boolean; deafened: boolean; camera: boolean; sharing: boolean;
  /** False while there is no camera, or while the call is paused (RV-3): the camera control is aria-disabled. */
  canCamera: boolean;
  /** False without screen capture, or while the call is paused (RV-3): the share control is aria-disabled. */
  canShare: boolean;
  /** True while joining: every control is aria-disabled. */
  busy: boolean;
  labels: {
    region: string; mute: string; unmute: string; deafen: string; undeafen: string;
    cameraOn: string; cameraOff: string; shareOn: string; shareOff: string; leave: string;
  };
  onMute(): void; onDeafen(): void; onCamera(): void; onShare(): void; onLeave(): void;
}

/**
 * The call stage's controls (`role="toolbar"`, `voice.controls.region`): mute, deafen, camera, share screen and
 * leave. The toggles are the Button primitive's: `aria-pressed`, the label of what it does next (mute / unmute) and
 * the `[x]` mark, never colour alone. Mute and deafen carry their shortcuts. Busy (joining) makes every control
 * aria-disabled; it stays focusable.
 */
export function CallControls({
  muted, deafened, camera, sharing, canCamera, canShare, busy, labels, onMute, onDeafen, onCamera, onShare, onLeave,
}: CallControlsProps) {
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, onLabel: labels.unmute, on: muted, inert: busy, keys: VOICE_SHORTCUTS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, onLabel: labels.undeafen, on: deafened, inert: busy, keys: VOICE_SHORTCUTS.deafen, onAction: onDeafen },
    { id: 'camera', label: labels.cameraOn, onLabel: labels.cameraOff, on: camera, inert: busy || !canCamera, onAction: onCamera },
    { id: 'share', label: labels.shareOn, onLabel: labels.shareOff, on: sharing, inert: busy || !canShare, onAction: onShare },
    { id: 'leave', label: labels.leave, inert: busy, danger: true, onAction: onLeave },
  ];
  return <VoiceToolbar label={labels.region} controls={controls} className="d-call-controls" />;
}
