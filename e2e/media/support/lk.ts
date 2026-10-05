// LiveKit helpers for the media specs: the test host's SFU, raw debug tokens for a direct
// connection (plan MD-13), and polling the harness until remote tracks decode.
import type { Page } from '@playwright/test';
import type { HarnessApi, RemoteTrackStats } from '../../../packages/media/harness/main.ts';

export type { HarnessApi, RemoteTrackStats, RenderProbe, StubMode } from '../../../packages/media/harness/main.ts';
export type HarnessWindow = Window & { harness: HarnessApi };

export async function sfuInfo(control: string): Promise<{ url: string; httpUrl: string }> {
  const r = await fetch(`${control}/debug/sfu`);
  if (!r.ok) throw new Error(`GET /debug/sfu = ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { url: string; http_url: string };
  return { url: j.url, httpUrl: j.http_url };
}

export async function debugToken(control: string, room: string, identity: string, create = true): Promise<{ url: string; token: string }> {
  const r = await fetch(`${control}/debug/sfu/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room, identity, create }),
  });
  if (!r.ok) throw new Error(`POST /debug/sfu/token = ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { url: string; token: string };
  return { url: j.url, token: j.token };
}

/**
 * Gives the harness page transient user activation with a real click on its #activate button.
 * Chromium's getDisplayMedia (setScreenShareEnabled) rejects without it, and page.evaluate grants
 * none. Call it immediately before the evaluate that starts a screen share: the activation lasts
 * about 5 s.
 */
export async function activate(page: Page): Promise<void> {
  await page.click('#activate');
  const active = await page.evaluate(() => navigator.userActivation?.isActive ?? true);
  if (!active) throw new Error('the click on #activate left the page without transient user activation');
}

/** A fresh 32-lowercase-hex identity: what dillad mints for a device. */
export function deviceIdentity(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Polls remoteStats until there is at least one remote track and every remote video track has
 * decoded `minFrames` frames and every remote audio track has received samples (Chromium only:
 * Firefox resets inbound-rtp under a transform, use renderProbe there).
 */
/** Resolves once at least minTracks remote tracks are present and every one of them decodes. */
export async function waitForDecode(page: Page, minFrames: number, timeoutMs: number, minTracks = 1): Promise<RemoteTrackStats[]> {
  const deadline = Date.now() + timeoutMs;
  let last: RemoteTrackStats[] = [];
  for (;;) {
    last = await page.evaluate(() => (window as unknown as HarnessWindow).harness.remoteStats());
    const ok = last.length >= minTracks && last.every((s) => (s.kind === 'video' ? s.framesDecoded >= minFrames : s.totalSamplesReceived > 0));
    if (ok) return last;
    if (Date.now() > deadline) throw new Error(`remote tracks did not decode within ${timeoutMs} ms: ${JSON.stringify(last)}`);
    await page.waitForTimeout(250);
  }
}
