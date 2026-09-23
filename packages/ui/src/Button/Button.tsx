import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'accent' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  /** A keybind shown after the label, e.g. "M" or "⌘↵". Decorative for assistive tech. */
  keyHint?: string;
  /** For toggle buttons (mute, deafen): exposes aria-pressed. */
  pressed?: boolean;
  /**
   * Visible label shown while `pressed` is true, e.g. "Unmute" for a
   * "Mute" button. Toggle buttons built on this primitive should pass this
   * so the pressed state is never signalled by colour alone: the label text
   * itself changes, for sighted and screen-reader users alike. When
   * omitted, `children` is shown in both states — callers that skip it
   * still get the non-colour bracket mark below, but a label swap is the
   * clearest cue and is preferred wherever the label makes sense (e.g.
   * "Mute"/"Unmute", not "Save changes").
   */
  pressedLabel?: ReactNode;
  children: ReactNode;
};

export function Button({
  variant = 'default',
  size = 'md',
  keyHint,
  pressed,
  pressedLabel,
  children,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const isToggle = pressed !== undefined;
  const label = isToggle && pressed && pressedLabel !== undefined ? pressedLabel : children;
  return (
    <button type={type} className={['d-btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size}
      aria-pressed={isToggle ? pressed : undefined} {...rest}>
      {isToggle ? (
        <span className="d-btn__pressed-mark" aria-hidden="true">{pressed ? '[x]' : '[ ]'}</span>
      ) : null}
      <span className="d-btn__label">{label}</span>
      {keyHint ? <kbd className="d-btn__kbd" aria-hidden="true">{keyHint}</kbd> : null}
    </button>
  );
}
