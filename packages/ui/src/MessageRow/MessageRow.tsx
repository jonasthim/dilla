import { useId, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Tag } from '../Tag/Tag.tsx';
import { Button } from '../Button/Button.tsx';
import './MessageRow.css';

/** A piece of a message body: plain text, or a mention shown as a pill whose text is its `@` name. */
export type BodyPart = { kind: 'text'; text: string } | { kind: 'mention'; label: string; me: boolean; broadcast: boolean };

export interface MessageRowProps {
  author: string;
  time: string;
  body: string | readonly BodyPart[];
  own?: boolean;
  tag?: 'web' | 'bot';
  state: 'ok' | 'pending' | 'failed' | 'cannot-read' | 'deleted';
  stateLabel?: string;
  detail?: string;
  actions?: readonly { label: string; onAction(): void }[];
  active?: boolean;
  editedLabel?: string;
  pinnedLabel?: string;
  reply?: {
    label: string; author: string; excerpt: string; state: 'ok' | 'missing' | 'deleted'; stateText?: string; jumpLabel: string; onJump?(): void;
  };
  attachments?: ReactNode;
  reactions?: ReactNode;
  toolbar?: ReactNode;
  editor?: ReactNode;
  pendingAction?: { label: string; tone: 'pending' | 'failed'; actions?: readonly { label: string; onAction(): void }[] };
  flash?: boolean;
  mention?: boolean;
  onKeyDown?(e: KeyboardEvent): void;
  rowRef?: Ref<HTMLElement>;
  seq?: string | null;
  msgId?: string | null;
}

const flag = (on: boolean | undefined): 'true' | undefined => (on === true ? 'true' : undefined);

/** The body's parts as text children and mention pills: never HTML, never the raw token. */
function bodyChildren(body: string | readonly BodyPart[]): ReactNode {
  if (typeof body === 'string') return body;
  return body.map((part, i) => (part.kind === 'text'
    ? part.text
    : <span key={i} className="d-mention" data-me={flag(part.me)} data-broadcast={flag(part.broadcast)}>{part.label}</span>));
}

function ReplyLine({ reply, tabIndex }: { reply: NonNullable<MessageRowProps['reply']>; tabIndex: number }) {
  const labelId = useId();
  const jumpId = useId();
  const glyph = <span aria-hidden="true">↳</span>;
  const author = <span className="d-message-row__reply-author">{reply.author}</span>;
  const excerpt = <span className="d-message-row__reply-excerpt">{reply.excerpt}</span>;
  const stateText = <span className="d-message-row__reply-state">{reply.stateText}</span>;
  const canJump = reply.onJump !== undefined && (reply.state === 'ok' || reply.state === 'deleted');
  let line: ReactNode;
  if (canJump) {
    // Named by its visible text (WCAG 2.5.3), described by the label and the jump hint: no aria-label.
    line = (
      <button type="button" className="d-message-row__reply-jump" tabIndex={tabIndex} aria-describedby={`${labelId} ${jumpId}`}
        onClick={() => reply.onJump?.()}>
        {glyph}{author}{' '}{reply.state === 'ok' ? excerpt : stateText}
      </button>
    );
  } else if (reply.state === 'ok') {
    line = <>{glyph}{author}{' '}{excerpt}</>;
  } else {
    line = <>{glyph}{stateText}</>;
  }
  return (
    <div className="d-message-row__reply" data-state={reply.state}>
      <span className="d-sr-only" id={labelId}>{reply.label}</span>
      {canJump ? <span className="d-sr-only" id={jumpId}>{reply.jumpLabel}</span> : null}
      {line}
    </div>
  );
}

/**
 * One message, as an <article> named by its head. The body is shown for ok, pending and failed rows only: an
 * unreadable or deleted row shows its state label in the body's place, and never its body. The body is text
 * children and mention pills, never HTML. The row is a tab stop only while `active` (the log's roving row), and
 * every button it renders itself follows it; the slots (toolbar, attachments, reactions, editor) are the
 * caller's, who passes them `tabbable`. Escape inside the row brings focus back to the row; every other key,
 * and Escape on the row itself, goes to `onKeyDown`.
 */
export function MessageRow({
  author, time, body, own, tag, state, stateLabel, detail, actions, active, editedLabel, pinnedLabel, reply, attachments,
  reactions, toolbar, editor, pendingAction, flash, mention, onKeyDown, rowRef, seq, msgId,
}: MessageRowProps) {
  const headId = useId();
  const tabIndex = active === true ? 0 : -1;
  const showBody = state === 'ok' || state === 'pending' || state === 'failed';
  const headState = (state === 'pending' || state === 'failed') && !!stateLabel;
  const note = (state === 'cannot-read' || state === 'deleted') && !!stateLabel;
  const showDetail = (state === 'cannot-read' || state === 'failed') && !!detail;

  const onRowKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && e.target !== e.currentTarget) {
      e.preventDefault();
      e.currentTarget.focus();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <article ref={rowRef} className="d-message-row" tabIndex={tabIndex} aria-labelledby={headId} onKeyDown={onRowKeyDown}
      data-state={state} data-own={flag(own)} data-active={flag(active)}
      data-seq={seq ?? undefined} data-msg-id={msgId ?? undefined}
      data-edited={editedLabel !== undefined ? 'true' : undefined} data-pinned={pinnedLabel !== undefined ? 'true' : undefined}
      data-mention={flag(mention)} data-flash={flag(flash)}>
      <span className="d-message-row__avatar" aria-hidden="true"><Avatar name={author} /></span>
      <div className="d-message-row__main">
        <p className="d-message-row__head" id={headId}>
          <span className="d-message-row__author">{author}</span>
          {tag ? <Tag kind={tag} /> : null}
          <span className="d-message-row__time">{time}</span>
          {editedLabel !== undefined ? <span className="d-message-row__edited">{editedLabel}</span> : null}
          {pinnedLabel !== undefined ? <span className="d-message-row__pinned">{pinnedLabel}</span> : null}
          {headState ? <span className="d-message-row__state">{stateLabel}</span> : null}
        </p>
        {toolbar !== undefined ? <div className="d-message-row__toolbar">{toolbar}</div> : null}
        {reply !== undefined ? <ReplyLine reply={reply} tabIndex={tabIndex} /> : null}
        {editor !== undefined ? editor : showBody ? <p className="d-message-row__body">{bodyChildren(body)}</p> : null}
        {attachments !== undefined ? <div className="d-message-row__attachments">{attachments}</div> : null}
        {reactions !== undefined ? <div className="d-message-row__reactions">{reactions}</div> : null}
        {pendingAction !== undefined ? (
          <p className="d-message-row__pending" data-tone={pendingAction.tone}>
            <span className="d-message-row__pending-label">{pendingAction.label}</span>
            {pendingAction.actions?.map(a => (
              <Button key={a.label} variant="ghost" tabIndex={tabIndex} onClick={a.onAction}>{a.label}</Button>
            ))}
          </p>
        ) : null}
        {note ? <p className="d-message-row__note">{stateLabel}</p> : null}
        {showDetail ? <code className="d-message-row__detail">{detail}</code> : null}
        {actions && actions.length > 0 ? (
          <div className="d-message-row__actions">
            {actions.map(a => <Button key={a.label} variant="ghost" tabIndex={tabIndex} onClick={a.onAction}>{a.label}</Button>)}
          </div>
        ) : null}
      </div>
    </article>
  );
}
