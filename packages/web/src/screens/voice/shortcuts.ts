/**
 * The mute and deafen shortcuts as the voice tooltips show them (plan 2026-10-15). Control or ⌘ with Shift works on
 * every platform (flow 06, decision 1); the tooltip writes the one this platform's keyboard shows: ⌘⇧M on Apple
 * platforms, Ctrl+Shift+M elsewhere.
 */
export function voiceShortcutText(apple: boolean = isApplePlatform()): { mute: string; deafen: string } {
  return apple ? { mute: '⌘⇧M', deafen: '⌘⇧D' } : { mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' };
}

interface PlatformSource { userAgentData?: { platform?: string }; platform?: string }

/**
 * Whether this is macOS or iOS: userAgentData's platform where the browser has one, else navigator.platform. An
 * empty UA-CH platform (Chromium's "unknown") is no answer, so navigator.platform decides then.
 */
export function isApplePlatform(nav: PlatformSource | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const hinted = nav?.userAgentData?.platform;
  const name = hinted !== undefined && hinted !== '' ? hinted : nav?.platform ?? '';
  return /^(mac|iphone|ipad|ipod)/i.test(name);
}
