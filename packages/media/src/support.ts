// The voice gate (DEV-28): "(script transform or insertable streams) AND, on Chromium, the PC flag".
// livekit-client forces encodedInsertableStreams: true whenever a manager exists and
// RTCRtpSender.prototype.createEncodedStreams exists (RTCEngine.ts:794-809), so on Chromium the presence of
// createEncodedStreams is what makes the pipeline fail closed. A Chromium without it would build PCs without
// the flag, and a script transform there is silently bypassed (gap G1).

export type VoiceSupport =
  | { ok: true; path: 'insertable-streams' | 'script-transform' }
  | { ok: false; reason: 'no-transform-api' | 'chromium-flag-missing' };

export function isChromium(ua: string = globalThis.navigator?.userAgent ?? ''): boolean {
  return /\bChrom(?:e|ium)\//.test(ua) && !/\bCriOS\//.test(ua);
}

export function isVoiceSupported(): VoiceSupport {
  const g = globalThis as { RTCRtpScriptTransform?: unknown; RTCRtpSender?: { prototype: object } };
  const streams = typeof g.RTCRtpSender !== 'undefined' && 'createEncodedStreams' in g.RTCRtpSender.prototype;
  const script = typeof g.RTCRtpScriptTransform !== 'undefined';
  if (isChromium()) {
    // SP-01 (task 14, measured): Chromium stays on livekit-client's own createEncodedStreams path (DEV-28 (a));
    // the script path logged 6-30 InvalidStateError pipe errors per run on Chromium 153 and Electron 44.
    if (streams) return { ok: true, path: 'insertable-streams' };
    return { ok: false, reason: script ? 'chromium-flag-missing' : 'no-transform-api' };
  }
  if (script) return { ok: true, path: 'script-transform' };
  if (streams) return { ok: true, path: 'insertable-streams' };
  return { ok: false, reason: 'no-transform-api' };
}
