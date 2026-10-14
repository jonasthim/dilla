import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'accent' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  /** A keybind shown after the label, e.g. "M" or "⌘↵". Decorative for assistive tech. */
  keyHint?: string;
  /**
   * For toggle buttons (mute, deafen): exposes aria-pressed and shows an aria-hidden `[x]` / `[ ]` mark, so the state
   * is never signalled by colour alone. The label stays the same in both states (the WAI-ARIA toggle pattern; WB a11y
   * I4, ruling 2026-10-14): "mute, toggle button, pressed" means muted, and a label that swapped to "unmute" while
   * pressed would contradict it (WCAG 2.5.3 label in name, 4.1.2).
   */
  pressed?: boolean;
  children: ReactNode;
};

export function Button({
  variant = 'default',
  size = 'md',
  keyHint,
  pressed,
  children,
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  const isToggle = pressed !== undefined;
  return (
    <button type={type} className={['d-btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size}
      aria-pressed={isToggle ? pressed : undefined} {...rest}>
      {isToggle ? (
        <span className="d-btn__pressed-mark" aria-hidden="true">{pressed ? '[x]' : '[ ]'}</span>
      ) : null}
      <span className="d-btn__label">{children}</span>
      {keyHint ? <kbd className="d-btn__kbd" aria-hidden="true">{keyHint}</kbd> : null}
    </button>
  );
}
