import { Dialog } from '../Dialog/Dialog.tsx';
import './AddServerDialog.css';

export interface AddServerDialogProps {
  open: boolean;
  /** `layout.add.title` ('add a server'). */
  title: string;
  /** `layout.add.join` ('join a server'): an invite link or code. */
  joinLabel: string;
  /** `layout.add.create` ('new server'). */
  createLabel: string;
  closeLabel?: string;
  /** The dialog asks to close (Escape, the close button, a click outside); the caller sets `open` false and focus goes back to the "+" tile. */
  onClose(): void;
  /** A choice: the dialog closes itself first (`onClose`), then the caller opens the existing join or create flow. */
  onJoin(): void;
  onCreate(): void;
}

/**
 * The "+" tile's one dialog: a native modal <dialog> (Dialog) with two choices. Focus starts on the first choice, Escape
 * closes, and focus returns to the opener (the "+" tile).
 */
export function AddServerDialog({ open, title, joinLabel, createLabel, closeLabel, onClose, onJoin, onCreate }: AddServerDialogProps) {
  return (
    <Dialog open={open} title={title} closeLabel={closeLabel} onClose={onClose}>
      <ul role="list" className="d-add-server">
        <li><button type="button" className="d-add-server__choice" data-autofocus onClick={() => { onClose(); onJoin(); }}>{joinLabel}</button></li>
        <li><button type="button" className="d-add-server__choice" onClick={() => { onClose(); onCreate(); }}>{createLabel}</button></li>
      </ul>
    </Dialog>
  );
}
