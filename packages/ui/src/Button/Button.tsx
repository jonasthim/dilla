import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'accent' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  /** A keybind shown after the label, e.g. "M" or "⌘↵". Decorative for assistive tech. */
  keyHint?: string;
  /** For toggle buttons (mute, deafen): exposes aria-pressed. */
  pressed?: boolean;
  children: ReactNode;
};

export function Button({ variant = 'default', size = 'md', keyHint, pressed, children, type = 'button', className, ...rest }: ButtonProps) {
  return (
    <button type={type} className={['d-btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size}
      aria-pressed={pressed === undefined ? undefined : pressed} {...rest}>
      <span className="d-btn__label">{children}</span>
      {keyHint ? <kbd className="d-btn__kbd" aria-hidden="true">{keyHint}</kbd> : null}
    </button>
  );
}
