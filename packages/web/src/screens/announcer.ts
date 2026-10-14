import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The text of a polite live region and the function that speaks into it. The region is emptied first and filled a tick
 * later, so the same text twice in a row ("Saved." twice) is announced twice.
 */
export function useAnnouncer(): { text: string; announce: (text: string) => void } {
  const [text, setText] = useState('');
  const pending = useRef<number | null>(null);
  const cancel = () => {
    if (pending.current !== null) { window.clearTimeout(pending.current); pending.current = null; }
  };
  const announce = useCallback((next: string) => {
    cancel();
    setText('');
    pending.current = window.setTimeout(() => { pending.current = null; setText(next); }, 0);
  }, []);
  useEffect(() => cancel, []);
  return { text, announce };
}
