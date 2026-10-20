// Display key names (what a KeyHint chip shows) to the key names `aria-keyshortcuts` takes (WAI-ARIA 1.2, UI Events KeyboardEvent.key).
const NAMES: Record<string, string> = {
  ctrl: 'Control', control: 'Control', '⌃': 'Control',
  cmd: 'Meta', command: 'Meta', '⌘': 'Meta', meta: 'Meta', win: 'Meta',
  alt: 'Alt', option: 'Alt', opt: 'Alt', '⌥': 'Alt',
  shift: 'Shift', '⇧': 'Shift',
  esc: 'Escape', escape: 'Escape',
  '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight',
  '↵': 'Enter', return: 'Enter', enter: 'Enter',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', '⌫': 'Backspace',
  pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
  space: 'Space', tab: 'Tab', '⇥': 'Tab', home: 'Home', end: 'End',
};

export function ariaKeyshortcuts(keys: readonly string[]): string {
  return keys.map(k => NAMES[k.toLowerCase()] ?? k).join('+');
}
