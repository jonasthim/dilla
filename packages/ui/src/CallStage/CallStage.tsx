import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { CallTile, type CallTileProps } from '../CallTile/CallTile.tsx';
import '../Button/Button.css';
import './CallStage.css';

export interface CallStageNotice {
  /**
   * `paused` is the RV-3 pause banner and `blocked` a block notice (`voice.blocked`, `voice.blockedJoin`,
   * `voice.blockedChanged`): while either shows, no tile renders a media element. `info` is a transient notice
   * (`voice.full`, `voice.micDenied` and the like) that leaves the tiles as they are.
   */
  kind: 'paused' | 'blocked' | 'info';
  text: string;
  action: { label: string; onAction(): void } | null;
  /** Move focus to the notice (its action, or the notice itself) once, when this text first shows. */
  focusOnce: boolean;
}

export interface CallStageProps {
  /** The stage's heading, e.g. 'voice harbour' or the DM's name. */
  title: string;
  tiles: readonly CallTileProps[];
  /** The call code, 30 digits (spaces are ignored), or null when there is none yet. */
  code: string | null;
  /** A notice on the stage: the RV-3 pause banner (with its `voice.pausedAction`), a block notice or a transient one. */
  notice: CallStageNotice | null;
  /** The call controls (a `CallControls`). */
  controls: ReactNode;
  /** The DM call strip while this device's call rings others ('ringing {names}', '{name} declined.', 'No answer.'). */
  outgoing: { text: string } | null;
  labels: { code: string; codeHelp: string; empty: string; tiles: string };
}

const NOTICE_GLYPH = { paused: '‖', blocked: '!', info: '›' } as const;

/** Six groups of five digits; anything that is not 30 digits is shown as given. */
function groupCode(code: string): string {
  const digits = code.replace(/\s+/g, '');
  return /^\d{30}$/.test(digits) ? (digits.match(/\d{5}/g) ?? []).join(' ') : code;
}

/**
 * The call stage: the heading, the outgoing ring, the call code behind a closed disclosure (Escape closes it and
 * returns focus to it), a notice region, the tiles as a list named `voice.tiles` (or `voice.empty`), and the
 * controls. The notice region is a `role="status"` that is always present, so its text is announced; a notice
 * with `focusOnce` takes focus once per text. While a pause or block notice shows, no tile renders media; while any
 * notice shows, the stage does not also say that nobody is in voice.
 */
export function CallStage({ title, tiles, code, notice, controls, outgoing, labels }: CallStageProps) {
  const titleId = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const focusedFor = useRef<string | null>(null);
  const noticeText = notice?.text ?? null;
  const focusOnce = notice?.focusOnce ?? false;

  useEffect(() => {
    if (noticeText === null) { focusedFor.current = null; return; }
    if (!focusOnce || focusedFor.current === noticeText) return;
    focusedFor.current = noticeText;
    (actionRef.current ?? noticeRef.current)?.focus();
  }, [noticeText, focusOnce]);

  const onCodeKey = (e: KeyboardEvent<HTMLDetailsElement>) => {
    const details = detailsRef.current;
    if (e.key !== 'Escape' || !details?.open) return;
    e.preventDefault();
    e.stopPropagation();
    details.open = false;
    details.querySelector('summary')?.focus();
  };

  const hideMedia = notice !== null && notice.kind !== 'info';
  return (
    <section className="d-call-stage" aria-labelledby={titleId} data-media-hidden={hideMedia ? 'true' : undefined}>
      <header className="d-call-stage__head">
        <h2 id={titleId} className="d-call-stage__title">{title}</h2>
        {outgoing !== null ? <p className="d-call-stage__outgoing">{outgoing.text}</p> : null}
        {code !== null ? (
          <details ref={detailsRef} className="d-call-stage__code" onKeyDown={onCodeKey}>
            <summary className="d-call-stage__summary">{labels.code}</summary>
            <div className="d-call-stage__code-body">
              <p className="d-call-stage__digits">{groupCode(code)}</p>
              <p className="d-call-stage__help">{labels.codeHelp}</p>
            </div>
          </details>
        ) : null}
      </header>
      <div ref={noticeRef} role="status" className="d-call-stage__notice" data-empty={notice === null ? 'true' : undefined} data-kind={notice?.kind}
        tabIndex={notice !== null && notice.action === null ? -1 : undefined}>
        {notice !== null ? (
          <>
            <span className="d-call-stage__notice-glyph" aria-hidden="true">{NOTICE_GLYPH[notice.kind]}</span>
            <p className="d-call-stage__notice-text">{notice.text}</p>
            {notice.action !== null ? (
              <button ref={actionRef} type="button" className="d-btn d-call-stage__notice-action" data-variant="default" data-size="md"
                onClick={notice.action.onAction}>{notice.action.label}</button>
            ) : null}
          </>
        ) : null}
      </div>
      {tiles.length === 0 ? (
        notice === null ? <p className="d-call-stage__empty">{labels.empty}</p> : null
      ) : (
        <ul role="list" aria-label={labels.tiles} className="d-call-stage__tiles">
          {tiles.map(t => (
            <li key={t.view.deviceId} className="d-call-stage__tile">
              <CallTile {...t} media={hideMedia ? null : t.media} inset={hideMedia ? null : t.inset ?? null} />
            </li>
          ))}
        </ul>
      )}
      <div className="d-call-stage__controls">{controls}</div>
    </section>
  );
}
