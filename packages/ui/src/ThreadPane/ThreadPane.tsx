import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from '../Button/Button.tsx';
import { PhoneHeader } from '../PhoneHeader/PhoneHeader.tsx';
import './ThreadPane.css';

export interface ThreadPaneProps {
  /** The pane's heading (a level-two heading). */
  title: string;
  closeLabel: string;
  onClose(): void;
  /** The root row (a MessageRow the caller renders) or the missing note. */
  root: ReactNode;
  /** The replies (a MessageLog). */
  children: ReactNode;
  /** The thread's Composer. */
  composer: ReactNode;
  /** True: a full-screen sheet with a PhoneHeader (back = close). False: a column in the shell's aside. */
  phone?: boolean;
}

/**
 * A public thread beside the channel: a heading with a close control, the root message, the replies, and the thread's
 * composer at the bottom. In the shell's aside it is a column that fits the aside's width. With `phone` it is a
 * full-screen sheet: a PhoneHeader whose back control closes it, the composer clearing the home indicator, and every
 * control 44 px. It is not a landmark of its own: the aside around it is named by the caller.
 *
 * Escape anywhere inside closes the thread and nothing more: the key is stopped here, so the drawer around it (which
 * closes on Escape too) never sees it, and a key that something inside already handled (an open mention list, a row
 * returning focus to itself) is left alone.
 */
export function ThreadPane({ title, closeLabel, onClose, root, children, composer, phone }: ThreadPaneProps) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };
  return (
    <div className="d-thread-pane" data-phone={phone === true ? 'true' : undefined} onKeyDown={onKeyDown}>
      {phone === true ? (
        <PhoneHeader title={title} backLabel={closeLabel} onBack={onClose} />
      ) : (
        <header className="d-thread-pane__head">
          <h2 className="d-thread-pane__title">{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>{closeLabel}</Button>
        </header>
      )}
      <div className="d-thread-pane__scroll">
        <div className="d-thread-pane__root">{root}</div>
        <div className="d-thread-pane__replies">{children}</div>
      </div>
      <div className="d-thread-pane__composer">{composer}</div>
    </div>
  );
}
