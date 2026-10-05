import { Children, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import './MessageLog.css';

export interface MessageLogProps {
  label: string;
  children: ReactNode;
  earlier?: { label: string; onLoad(): void };
  emptyLabel: string;
  busy?: boolean;
}

/** How far from the end, in CSS px, the reader may be and still count as reading the end. */
export const PIN_SLACK_PX = 24;

/**
 * The message feed: a polite, named log that is a keyboard-reachable scroll
 * region. It stays pinned to the end while the reader is there, keeps the
 * reader's place when rows arrive or earlier rows are put in front, and never
 * moves focus. `busy` is held by the caller while history is loading.
 */
export function MessageLog({ label, children, earlier, emptyLabel, busy }: MessageLogProps) {
  // Scrolling must not re-render: all of the pinning state lives in refs.
  const logRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<Element | null>(null);

  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
  };

  // No dependency list: runs after every render.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const first = rowsRef.current?.firstElementChild ?? null;
    if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    } else if (prevFirst.current !== null && first !== prevFirst.current) {
      // Earlier rows were put in front: move by the added height so the rows in view stay put.
      el.scrollTop = el.scrollTop + (el.scrollHeight - prevHeight.current);
    }
    prevHeight.current = el.scrollHeight;
    prevFirst.current = first;
  });

  return (
    <div ref={logRef} className="d-message-log" role="log" aria-live="polite" aria-label={label} aria-busy={busy ? true : undefined} tabIndex={0} onScroll={onScroll}>
      {earlier ? <Button className="d-message-log__earlier" variant="ghost" onClick={earlier.onLoad}>{earlier.label}</Button> : null}
      {Children.count(children) === 0 ? <p className="d-message-log__empty">{emptyLabel}</p> : null}
      <div ref={rowsRef} className="d-message-log__rows">{children}</div>
    </div>
  );
}
