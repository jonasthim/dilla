import { Avatar } from '../Avatar/Avatar.tsx';
import { Tag } from '../Tag/Tag.tsx';
import { Button } from '../Button/Button.tsx';
import './MessageRow.css';

export interface MessageRowProps {
  author: string;
  time: string;
  body: string;
  own?: boolean;
  tag?: 'web' | 'bot';
  state: 'ok' | 'pending' | 'failed' | 'cannot-read' | 'deleted';
  stateLabel?: string;
  detail?: string;
  actions?: readonly { label: string; onAction(): void }[];
}

/**
 * One message. The body is shown for ok, pending and failed rows only: an
 * unreadable or deleted row shows its state label in the body's place, and
 * never its body. The body is a React text child, never HTML.
 */
export function MessageRow({ author, time, body, own, tag, state, stateLabel, detail, actions }: MessageRowProps) {
  const showBody = state === 'ok' || state === 'pending' || state === 'failed';
  const headState = (state === 'pending' || state === 'failed') && !!stateLabel;
  const note = (state === 'cannot-read' || state === 'deleted') && !!stateLabel;
  const showDetail = (state === 'cannot-read' || state === 'failed') && !!detail;
  return (
    <div className="d-message-row" data-state={state} data-own={own ? 'true' : undefined}>
      <span className="d-message-row__avatar" aria-hidden="true"><Avatar name={author} /></span>
      <div className="d-message-row__main">
        <p className="d-message-row__head">
          <span className="d-message-row__author">{author}</span>
          {tag ? <Tag kind={tag} /> : null}
          <span className="d-message-row__time">{time}</span>
          {headState ? <span className="d-message-row__state">{stateLabel}</span> : null}
        </p>
        {showBody ? <p className="d-message-row__body">{body}</p> : null}
        {note ? <p className="d-message-row__note">{stateLabel}</p> : null}
        {showDetail ? <code className="d-message-row__detail">{detail}</code> : null}
        {actions && actions.length > 0 ? (
          <div className="d-message-row__actions">{actions.map(a => <Button key={a.label} variant="ghost" onClick={a.onAction}>{a.label}</Button>)}</div>
        ) : null}
      </div>
    </div>
  );
}
