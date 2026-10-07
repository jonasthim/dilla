import './DropOverlay.css';

export interface DropOverlayProps {
  active: boolean;
  title: string;
  body: string;
}

/**
 * Over the main pane while files are dragged over it: a dashed frame and a panel with its title and body. Dropping
 * is pointer-only (the attach button and paste are the keyboard paths), so the overlay is hidden from assistive
 * technology. It covers its positioned parent; nothing renders while it is not active.
 */
export function DropOverlay({ active, title, body }: DropOverlayProps) {
  if (!active) return null;
  return (
    <div className="d-drop-overlay" aria-hidden="true">
      <div className="d-drop-overlay__panel">
        <p className="d-drop-overlay__title">{title}</p>
        <p className="d-drop-overlay__body">{body}</p>
      </div>
    </div>
  );
}
