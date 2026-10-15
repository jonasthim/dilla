/**
 * The mute and deafen shortcuts as the voice tooltips show them (plan 2026-10-15). Control or ⌘ with Shift works on
 * every platform (flow 06, decision 1); the tooltip writes the one this platform's keyboard shows: ⌘⇧M on Apple
 * platforms, Ctrl+Shift+M elsewhere.
 */
export function voiceShortcutText(apple: boolean = isApplePlatform()): { mute: string; deafen: string } {
  return apple ? { mute: '⌘⇧M', deafen: '⌘⇧D' } : { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' };
}

interface PlatformSource { userAgentData?: { platform?: string }; platform?: string }

/** Whether this is macOS or iOS: userAgentData's platform where the browser has it, else navigator.platform. */
export function isApplePlatform(nav: PlatformSource | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const name = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /^(mac|iphone|ipad|ipod)/i.test(name);
}
