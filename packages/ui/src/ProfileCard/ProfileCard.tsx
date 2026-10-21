import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ActionMenuItem } from '../ActionMenu/ActionMenu.tsx';
import { Avatar, type Presence } from '../Avatar/Avatar.tsx';
import { focusReturnTarget } from '../Dialog/Dialog.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { RoleDot } from '../internal/RoleDot.tsx';
import { usePhoneLayout } from '../internal/phoneLayout.ts';
import { PRESENCE_WORD } from '../internal/presenceWord.ts';
import './ProfileCard.css';

export interface ProfileCardRole { name: string; /** 0xRRGGBB; null, 0 or left out: no swatch. */ color?: number | null }

export interface ProfileCardProps {
  /** The display name, which also names the dialog. */
  name: string;
  username: string;
  presence?: Presence;
  /** A custom status, drawn after the presence word. */
  status?: string;
  isOwner?: boolean;
  isYou?: boolean;
  roles: readonly ProfileCardRole[];
  /** Message, compare safety numbers, and kick and ban when the viewer may: the caller decides which. */
  actions: readonly ActionMenuItem[];
  onAction(actionId: string): void;
  onClose(): void;
  /** The row the card was opened from: the popover sits beside it and focus returns to it on close. */
  anchor?: HTMLElement | null;
  /** `popover` beside the row (desktop) or `sheet` from the bottom (phone). Default: a sheet inside a phone shell, else a popover. */
  layout?: 'popover' | 'sheet';
  /** A popover's side: `side` (default) beside a member row, `below` under a mention or an author name (above when there is no room below). */
  placement?: 'side' | 'below';
  ownerLabel?: string;
  youLabel?: string;
  rolesLabel?: string;
  closeLabel?: string;
  /** The words for the presence states; each defaults to the English word. */
  presenceLabels?: Partial<Record<Presence, string>>;
}

const GAP = 8;
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A member's profile: avatar, display name, @username, presence and status, an owner and "you" line, the roles as
 * chips and the actions as buttons. It is a `dialog` the caller mounts while it is open. Focus moves in (the first
 * action, else the close button), Tab stays inside, Escape and the close button call `onClose`, and on unmount focus
 * goes back to the row it was opened from. On a desktop it is a popover fixed beside the row (left of it when there is
 * room, else right); on a phone it is a modal sheet from the bottom over a scrim.
 */
export function ProfileCard({
  name, username, presence, status, isOwner = false, isYou = false, roles, actions, onAction, onClose, anchor, layout, placement = 'side',
  ownerLabel = 'owner', youLabel = 'you', rolesLabel = 'roles', closeLabel = 'Close', presenceLabels,
}: ProfileCardProps) {
  const phone = usePhoneLayout();
  const mode = layout ?? (phone ? 'sheet' : 'popover');
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The row to return to is read before focus moves in: the anchor, else whatever had focus.
  useLayoutEffect(() => {
    const active = document.activeElement;
    opener.current = anchor ?? (active instanceof HTMLElement && active !== document.body ? active : null);
  }, [anchor]);

  // Focus moves in on open and back to the row on close (resolved then: the row may have been re-mounted meanwhile).
  useEffect(() => {
    const el = ref.current;
    (el?.querySelector<HTMLElement>('.d-profile-card__action') ?? el?.querySelector<HTMLElement>('.d-profile-card__close'))?.focus();
    return () => {
      const active = document.activeElement;
      const inside = active === null || active === document.body || el?.contains(active) === true;
      if (!inside) return;
      focusReturnTarget(opener.current)?.focus();
    };
  }, []);

  // A popover sits beside its row, inside the viewport (or inside the app shell, a size container and so the containing block of a fixed element).
  // It follows the row: re-placed on a window resize and on a scroll of any container.
  useLayoutEffect(() => {
    if (mode !== 'popover' || !anchor || !ref.current) { setAt(null); return; }
    const place = () => {
      if (!ref.current) return;
      // The row went away (a re-mount, a kick): close; the unmount returns focus to that member's row if it is back, else the list.
      if (!anchor.isConnected) { onCloseRef.current(); return; }
      const w = ref.current.offsetWidth;
      const h = ref.current.offsetHeight;
      const shell = anchor.closest('.d-app-shell')?.getBoundingClientRect();
      const box = shell ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const a = anchor.getBoundingClientRect();
      let x: number;
      let y: number;
      if (placement === 'below') {
        // Under the anchor at its left edge (a mention, an author name), above it when there is no room below.
        x = a.left - box.left;
        y = a.bottom - box.top + GAP;
        if (y + h > box.height) y = Math.max(0, a.top - box.top - GAP - h);
      } else {
        const leftOfRow = a.left - box.left - GAP - w;
        x = leftOfRow >= GAP ? leftOfRow : a.right - box.left + GAP;
        y = Math.max(0, Math.min(a.top - box.top, box.height - h));
      }
      const next = { x: Math.max(0, Math.min(x, box.width - w)), y };
      setAt(cur => (cur !== null && cur.x === next.x && cur.y === next.y ? cur : next));
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); };
  }, [mode, anchor, placement]);

  // A pointerdown outside the popover (and its own row, which decides for itself) closes it.
  useEffect(() => {
    if (mode !== 'popover') return;
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (ref.current?.contains(e.target) || anchor?.contains(e.target)) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [mode, anchor]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = list[0]; const last = list[list.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const style: CSSProperties | undefined = mode === 'popover' ? { position: 'fixed', left: `${at?.x ?? 0}px`, top: `${at?.y ?? 0}px` } : undefined;
  const card = (
    <div ref={ref} className="d-profile-card" role="dialog" aria-modal={mode === 'sheet' ? true : undefined} aria-labelledby={titleId} data-layout={mode} style={style}
      tabIndex={-1} onKeyDown={onKeyDown} onClick={e => e.stopPropagation()}>
      <div className="d-profile-card__head">
        <Avatar name={name} size="lg" />
        <div className="d-profile-card__who">
          <h2 id={titleId} className="d-profile-card__name">{name}</h2>
          {username === '' ? null : <p className="d-profile-card__username">@{username}</p>}
          {presence !== undefined || status ? (
            <p className="d-profile-card__status" data-presence={presence}>{presence === undefined ? null : <span>{presenceLabels?.[presence] ?? PRESENCE_WORD[presence]}</span>}{presence !== undefined && status ? ' · ' : null}{status ? <span>{status}</span> : null}</p>
          ) : null}
        </div>
        <button type="button" className="d-profile-card__close" aria-label={closeLabel} onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      {isOwner || isYou ? (
        <p className="d-profile-card__marks">
          {isOwner ? <span className="d-profile-card__mark"><Icon name="crown" size={14} />{ownerLabel}</span> : null}
          {isYou ? <span className="d-profile-card__mark">{youLabel}</span> : null}
        </p>
      ) : null}
      {roles.length > 0 ? (
        <ul className="d-profile-card__roles" role="list" aria-label={rolesLabel}>
          {roles.map(r => <li key={r.name} className="d-profile-card__role">{r.color ? <RoleDot color={r.color} /> : null}{r.name}</li>)}
        </ul>
      ) : null}
      {actions.length > 0 ? (
        <div className="d-profile-card__actions" role="group" aria-label={name}>
          {actions.map(a => (
            <button key={a.id} type="button" className="d-profile-card__action" data-danger={a.danger ? 'true' : undefined} onClick={() => onAction(a.id)}>{a.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
  return mode === 'sheet' ? <div className="d-profile-card__scrim" onClick={onClose}>{card}</div> : card;
}
