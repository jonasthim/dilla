import { useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { Icon, type IconName } from '../Icon/Icon.tsx';
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
 * The glyphs of the five voice controls (plan 2026-10-15). A toggle's glyph is its state, never colour alone: muted is
 * mic-off, deafened headphone-off, a live camera video (video-off while off), sharing monitor-x (monitor-up to start).
 */
export const VOICE_ICONS = {
  mute: { icon: 'mic', iconOn: 'mic-off', tint: 'danger' },
  deafen: { icon: 'headphones', iconOn: 'headphone-off', tint: 'danger' },
  camera: { icon: 'video-off', iconOn: 'video', tint: 'accent' },
  share: { icon: 'monitor-up', iconOn: 'monitor-x', tint: 'accent' },
  leave: { icon: 'phone-off' },
} as const satisfies Record<string, Pick<ToolbarControl, 'icon' | 'iconOn' | 'tint'>>;

/**
 * One control of a voice toolbar: an icon button named by `label` (`aria-label`). A toggle (`on` given) keeps one
 * label in both states with `aria-pressed` (WB a11y I4); its glyph swaps to `iconOn` while on, and it takes the `tint`
 * colour. An inert control is aria-disabled.
 */
export interface ToolbarControl {
  id: string; label: string; on?: boolean; inert?: boolean; danger?: boolean;
  icon: IconName;
  /** The glyph while `on`; `icon` when absent. */
  iconOn?: IconName;
  /** The colour of the on state: `danger` (mute, deafen; the default) or `accent` (camera, share). */
  tint?: 'danger' | 'accent';
  /** `aria-keyshortcuts`, e.g. VOICE_SHORTCUTS.mute. */
  keys?: string;
  /** The shortcut as shown in the tooltip, formatted for the platform by the caller, e.g. "Ctrl+Shift+M" or "⌘⇧M". */
  shortcut?: string;
  onAction(): void;
}

/**
 * A voice toolbar: the controls as one roving tab stop, named by `label`. Each control shows a tooltip, its label and
 * any shortcut, on hover and on keyboard focus (WCAG 1.4.13): the pointer can move onto it, it stays until the pointer
 * or focus leaves, and Escape hides it without moving focus. It is never a `title`. Only the shortcut describes the
 * control (`aria-describedby`), so the name is not read twice.
 */
export function VoiceToolbar({ label, controls, className }: { label: string; controls: readonly ToolbarControl[]; className?: string }): ReactNode {
  const bar = useToolbarFocus(controls.length);
  const uid = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const shown = hovered ?? focused;
  const tip = shown !== null && shown !== dismissed ? shown : null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && tip !== null) setDismissed(tip);
    bar.onKeyDown(e);
  };
  const focusVisible = (el: HTMLElement): boolean => {
    try { return el.matches(':focus-visible'); } catch { return true; }
  };
  return (
    <div ref={bar.ref} role="toolbar" aria-label={label} aria-orientation="horizontal"
      className={['d-voice-toolbar', className].filter(Boolean).join(' ')} onKeyDown={onKeyDown} onFocus={bar.onFocus}>
      {controls.map((c, i) => {
        const shortcutId = `${uid}-${c.id}-keys`;
        const onClick = (e: MouseEvent<HTMLButtonElement>) => {
          // The tooltip sits inside the button so the pointer can rest on it; a click there is not a press.
          if (e.target instanceof Element && e.target.closest('.d-voice-toolbar__tip') !== null) return;
          if (c.inert !== true) c.onAction();
        };
        return (
          <Button key={c.id} variant={c.danger === true ? 'danger' : 'default'} className="d-voice-toolbar__control" data-control={c.id}
            data-tint={c.on === undefined ? undefined : (c.tint ?? 'danger')} pressed={c.on} mark={false} aria-label={c.label}
            aria-keyshortcuts={c.keys} aria-describedby={c.shortcut !== undefined ? shortcutId : undefined}
            aria-disabled={c.inert === true ? true : undefined} tabIndex={bar.tabIndex(i)}
            onFocus={e => { setDismissed(null); setFocused(focusVisible(e.currentTarget) ? c.id : null); }}
            onBlur={() => { setFocused(f => (f === c.id ? null : f)); }}
            onMouseEnter={() => { setDismissed(null); setHovered(c.id); }}
            onMouseLeave={() => { setHovered(h => (h === c.id ? null : h)); }}
            onClick={onClick}>
            <Icon name={c.on === true ? c.iconOn ?? c.icon : c.icon} />
            <span className="d-voice-toolbar__tip" role="tooltip" hidden={tip !== c.id}>
              <span>{c.label}</span>
              {c.shortcut !== undefined ? <kbd id={shortcutId} className="d-voice-toolbar__keys">{c.shortcut}</kbd> : null}
            </span>
          </Button>
        );
      })}
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
  labels: { region: string; mute: string; deafen: string; camera: string; share: string; leave: string };
  /** Optional: the mute and deafen shortcuts as the tooltips show them, formatted per platform by the caller. */
  shortcuts?: { mute: string; deafen: string };
  onMute(): void; onDeafen(): void; onCamera(): void; onShare(): void; onLeave(): void;
}

/**
 * The call stage's controls (`role="toolbar"`): mute, deafen, camera, share screen and leave, as icon buttons. The
 * toggles keep one label with `aria-pressed`, and their glyph swaps with the state, never colour alone (WB a11y I4).
 * Mute and deafen carry their shortcuts. Busy (joining) makes every control aria-disabled; it stays focusable.
 */
export function CallControls({
  muted, deafened, camera, sharing, canCamera, canShare, busy, labels, shortcuts, onMute, onDeafen, onCamera, onShare, onLeave,
}: CallControlsProps) {
  const controls: ToolbarControl[] = [
    { id: 'mute', label: labels.mute, on: muted, inert: busy, keys: VOICE_SHORTCUTS.mute, shortcut: shortcuts?.mute, ...VOICE_ICONS.mute, onAction: onMute },
    { id: 'deafen', label: labels.deafen, on: deafened, inert: busy, keys: VOICE_SHORTCUTS.deafen, shortcut: shortcuts?.deafen, ...VOICE_ICONS.deafen, onAction: onDeafen },
    { id: 'camera', label: labels.camera, on: camera, inert: busy || !canCamera, ...VOICE_ICONS.camera, onAction: onCamera },
    { id: 'share', label: labels.share, on: sharing, inert: busy || !canShare, ...VOICE_ICONS.share, onAction: onShare },
    { id: 'leave', label: labels.leave, inert: busy, danger: true, ...VOICE_ICONS.leave, onAction: onLeave },
  ];
  return <VoiceToolbar label={labels.region} controls={controls} className="d-call-controls" />;
}

