import './ReplyChip.css';

export interface ReplyChipProps {
  label: string;
  excerpt: string;
  cancelLabel: string;
  onCancel(): void;
}

/** Above the composer while a reply is being written: who is replied to, one line of the original, and cancel. */
export function ReplyChip({ label, excerpt, cancelLabel, onCancel }: ReplyChipProps) {
  return (
    <div className="d-reply-chip">
      <span className="d-reply-chip__label">{label}</span>
      <span className="d-reply-chip__excerpt">{excerpt}</span>
      <button type="button" className="d-reply-chip__cancel" aria-label={cancelLabel} onClick={() => onCancel()}>
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
