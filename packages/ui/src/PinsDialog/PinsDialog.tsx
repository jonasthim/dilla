import { useId } from 'react';
import { Button } from '../Button/Button.tsx';
import { Dialog } from '../Dialog/Dialog.tsx';
import './PinsDialog.css';

export interface PinsDialogProps {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose(): void;
  emptyLabel: string;
  items: readonly {
    id: string; author: string; time: string; excerpt: string; pinnedBy: string; jumpLabel: string; onJump(): void;
    unpinLabel: string; onUnpin(): void;
  }[];
}

function PinItem({ item }: { item: PinsDialogProps['items'][number] }) {
  const excerptId = useId();
  return (
    <li className="d-pins-dialog__item">
      <p className="d-pins-dialog__head">
        <span className="d-pins-dialog__author">{item.author}</span>
        <span className="d-pins-dialog__time">{item.time}</span>
      </p>
      <p id={excerptId} className="d-pins-dialog__excerpt">{item.excerpt}</p>
      <div className="d-pins-dialog__foot">
        <p className="d-pins-dialog__by">{item.pinnedBy}</p>
        <Button variant="default" aria-describedby={excerptId} onClick={() => item.onJump()}>{item.jumpLabel}</Button>
        <Button variant="ghost" aria-describedby={excerptId} onClick={() => item.onUnpin()}>{item.unpinLabel}</Button>
      </div>
    </li>
  );
}

/**
 * The pins of one conversation in a `Dialog` named by its title: each pin with its author, time, excerpt and who
 * pinned it, and the jump and unpin buttons, both described by the excerpt. A jump is the caller's to finish (it
 * closes the dialog and flashes the row).
 */
export function PinsDialog({ open, title, closeLabel, onClose, emptyLabel, items }: PinsDialogProps) {
  return (
    <Dialog open={open} title={title} onClose={onClose} closeLabel={closeLabel}>
      {items.length === 0 ? (
        <p className="d-pins-dialog__empty">{emptyLabel}</p>
      ) : (
        <ul className="d-pins-dialog__list">
          {items.map(item => <PinItem key={item.id} item={item} />)}
        </ul>
      )}
    </Dialog>
  );
}
