/**
 * The wrapping arrow rule of single-select groups: the radio group (`Segmented`) and the tab list
 * (`SidebarTabs`). Given a key and the focused index, it answers the index to move to, or null when
 * the key is not one of the group's (a key pressed with Alt, Ctrl, Meta or Shift is never one: those
 * belong to the shell). `ArrowRight`/`ArrowLeft` wrap; with the `both` axis `ArrowDown`/`ArrowUp` do
 * the same; `Home`/`End` go to the ends. Pure: the caller moves focus and selects.
 */
export type ArrowAxis = 'horizontal' | 'both';

export function arrowIndex(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  from: number,
  count: number,
  axis: ArrowAxis,
): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (count <= 0) return null;
  let key = event.key;
  if (axis === 'both') {
    if (key === 'ArrowDown') key = 'ArrowRight';
    else if (key === 'ArrowUp') key = 'ArrowLeft';
  }
  switch (key) {
    case 'ArrowRight': return (from + 1) % count;
    case 'ArrowLeft': return (from - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}
