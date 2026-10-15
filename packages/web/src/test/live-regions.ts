// Helpers for the announcer contract: one polite live region per screen, and one speaking per action.

/** Every live region under `root` (an explicit role=status or aria-live). */
export function liveRegions(root: ParentNode = document): Element[] {
  return Array.from(root.querySelectorAll('[role="status"], [aria-live]'));
}

/** Records every non-empty text the region holds, in order (the announcer empties the region between two texts, so the
 *  same text twice in a row is two entries). Call `stop()` when done. */
export function watchRegion(region: Element): { history: string[]; stop(): void } {
  const history: string[] = [];
  let last = '';
  const read = () => {
    const text = region.textContent ?? '';
    if (text !== '' && text !== last) history.push(text);
    last = text;
  };
  read();
  const observer = new MutationObserver(read);
  observer.observe(region, { childList: true, characterData: true, subtree: true });
  return { history, stop: () => { observer.disconnect(); } };
}
