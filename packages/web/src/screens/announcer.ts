import { useCallback, useEffect, useRef, useState } from 'react';

/** How long one spoken text stays before the next one in the queue replaces it. */
const HOLD_MS = 200;

/**
 * The text of a polite live region and the function that speaks into it. Announcements queue: the region is emptied, the
 * head is set a tick later (so the same text twice in a row is announced twice), and the next follows after a short hold.
 * A text equal to the one queued last is dropped while that one is still waiting.
 */
export function useAnnouncer(): { text: string; announce: (text: string) => void } {
  const [text, setText] = useState('');
  const queue = useRef<string[]>([]);
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const drain = useCallback(() => {
    if (queue.current.length === 0) { busy.current = false; timer.current = null; return; }
    busy.current = true;
    setText('');
    timer.current = window.setTimeout(() => {
      setText(queue.current.shift() ?? '');
      timer.current = window.setTimeout(drain, HOLD_MS);
    }, 0);
  }, []);
  const announce = useCallback((next: string) => {
    if (queue.current.at(-1) === next) return;
    queue.current.push(next);
    if (!busy.current) drain();
  }, [drain]);
  useEffect(() => () => {
    queue.current = [];
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return { text, announce };
}
