import { Dialog } from '../Dialog/Dialog.tsx';
import './UnsupportedVoice.css';

export interface UnsupportedVoiceProps {
  open: boolean;
  labels: { title: string; body: string; close: string };
  /** The caller returns focus to the join button (flow 06). */
  onClose(): void;
}

/** The unsupported-browser dialog (`voice.unsupported.*`): a modal Dialog that Escape and its close button close. */
export function UnsupportedVoice({ open, labels, onClose }: UnsupportedVoiceProps) {
  return (
    <Dialog open={open} title={labels.title} onClose={onClose} closeLabel={labels.close}>
      <p className="d-unsupported-voice__body">{labels.body}</p>
    </Dialog>
  );
}
