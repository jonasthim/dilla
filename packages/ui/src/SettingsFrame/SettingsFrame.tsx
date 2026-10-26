import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import { Button } from '../Button/Button.tsx';
import { usePhoneLayout } from '../internal/phoneLayout.ts';
import './SettingsFrame.css';

export interface SettingsFrameProps {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose(): void;
  nav: ReactNode;
  children: ReactNode;
  /** @deprecated Settings workspaces are always modal. */
  modal?: boolean;
  /** The one sticky save footer of the section. */
  footer?: ReactNode;
  identity?: ReactNode;
  search?: ReactNode;
  /** Defaults to `section` for existing phone callers. */
  phonePage?: 'index' | 'section';
  sectionTitle?: string;
  backLabel?: string;
  /** Short visible text when the accessible back label names its destination. */
  backText?: string;
  onBack?: () => void;
  contentRef?: Ref<HTMLDivElement>;
  /** Gives list sections a wider content measure than normal forms. */
  wide?: boolean;
  /** Persistent call controls displayed inside the modal workspace. */
  activity?: ReactNode;
  /** Keeps idle connection announcements mounted without reserving visible header space. */
  activityVisible?: boolean;
  /** Nested dialogs remain available when the phone index hides section content. */
  overlays?: ReactNode;
}

function visibleFocusFallback(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>('[data-settings-focus-fallback], main, [role="main"]');
  for (const element of candidates) {
    let visible = element.isConnected;
    for (let node: HTMLElement | null = element; visible && node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      visible = !node.hidden && style.display !== 'none' && style.visibility !== 'hidden';
    }
    if (visible) return element;
  }
  return null;
}

/** A native modal workspace for settings; browser modal behavior keeps the mounted app inert. */
export function SettingsFrame({
  open, title, closeLabel, onClose, nav, children, footer, identity, search,
  phonePage = 'section', sectionTitle, backLabel = 'Back', backText, onBack, contentRef, wide, activity, activityVisible = true, overlays,
}: SettingsFrameProps) {
  const phone = usePhoneLayout();
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const previousPhonePage = useRef(phonePage);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body && !el.contains(active) ? active : null;
      el.showModal();
      titleRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
      const target = opener.current?.isConnected ? opener.current : visibleFocusFallback();
      opener.current = null;
      if (target) {
        if (!target.hasAttribute('tabindex') && !(target instanceof HTMLButtonElement || target instanceof HTMLInputElement || target instanceof HTMLAnchorElement)) target.tabIndex = -1;
        target.focus();
      }
    }
  }, [open]);

  useLayoutEffect(() => {
    const previous = previousPhonePage.current;
    previousPhonePage.current = phonePage;
    if (!open || !phone || previous === phonePage) return;
    const target = phonePage === 'section'
      ? ref.current?.querySelector<HTMLButtonElement>('[data-settings-back]')
      : ref.current?.querySelector<HTMLButtonElement>('.d-settings-nav__item[aria-current="page"]');
    target?.focus();
  }, [open, phone, phonePage]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el?.open) {
        el.close();
        const target = opener.current?.isConnected ? opener.current : visibleFocusFallback();
        if (target) {
          if (!target.hasAttribute('tabindex') && !(target instanceof HTMLButtonElement || target instanceof HTMLInputElement || target instanceof HTMLAnchorElement)) target.tabIndex = -1;
          target.focus();
        }
      }
    };
  }, []);

  const ownEvent = (target: EventTarget) => target instanceof Element && target.closest('dialog') === ref.current;
  const phoneIndex = phone && phonePage === 'index';
  const phoneSection = phone && phonePage === 'section';
  return (
    <dialog ref={ref} className="d-settings-frame" aria-labelledby={titleId} aria-modal="true" data-layout={phone ? 'phone' : undefined} data-phone-page={phone ? phonePage : undefined}
      onCancel={e => { if (!ownEvent(e.target)) return; e.preventDefault(); onCloseRef.current(); }}
      onKeyDown={e => {
        if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing && ownEvent(e.target)) {
          e.preventDefault(); onCloseRef.current();
        }
      }}>
      {open ? (
        <div className="d-settings-frame__panel">
          <div className="d-settings-frame__side">
            <h1 ref={titleRef} id={titleId} tabIndex={-1} className="d-settings-frame__title">{title}</h1>
            {identity ? <div className="d-settings-frame__identity">{identity}</div> : null}
            {search ? <div className="d-settings-frame__search">{search}</div> : null}
            <div className="d-settings-frame__nav" hidden={phoneSection}>{nav}</div>
          </div>
          <div className="d-settings-frame__pane">
            <div className="d-settings-frame__bar">
              {phoneSection ? <Button data-settings-back variant="ghost" aria-label={backLabel} onClick={onBack}>{backText ?? backLabel}</Button> : null}
              {phoneSection ? <div className="d-settings-frame__section-title">{sectionTitle}</div> : null}
              {activity ? <div className="d-settings-frame__activity" data-visible={activityVisible}>{activity}</div> : null}
              {!phoneSection ? <Button variant="ghost" keyHint="esc" onClick={() => onCloseRef.current()}>{closeLabel}</Button> : null}
            </div>
            <div ref={contentRef} className={`d-settings-frame__body${wide ? ' d-settings-frame__body--wide' : ''}`} hidden={phoneIndex}>
              {children}
            </div>
            {!phoneIndex && footer ? <div className="d-settings-frame__footer">{footer}</div> : null}
          </div>
          {overlays}
        </div>
      ) : null}
    </dialog>
  );
}
