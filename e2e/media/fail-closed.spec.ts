// Task 17 fix round 1, C1 on real engines: the DillaE2EEManager and the dilla-media worker (real wasm) on a loopback
// PeerConnection pair in one page (packages/media/harness/failclosed.ts). Runs in both media projects: Firefox takes
// the RTCRtpScriptTransform path, Chromium the createEncodedStreams path under livekit's forced PC flag.
// - A sender labelled with a codec the SFU forced (AV1) still attaches and encrypts what it actually sends.
// - A sender whose frames really are AV1 (no prefix rule) sends 0 media bytes.
// - A sender with no slot (unknown source) is blocked: 0 media bytes, and unpublished.
// - A receiver whose transform cannot be attached renders and decodes 0 frames of a plaintext sender that a receiver
//   without any transform renders.
import { expect, test, type Page } from '@playwright/test';
import type { FailClosedResult, FailClosedScenario } from '../../packages/media/harness/failclosed.ts';
import type { HarnessWindow } from './support/lk.ts';

const MS = 4_000;

async function run(page: Page, sc: FailClosedScenario): Promise<FailClosedResult> {
  const r = await page.evaluate((s) => (window as unknown as HarnessWindow).harness.failClosed(s), sc);
  console.log(`FAILCLOSED ${JSON.stringify({ sc, ...r, sender: r.sender && { encrypted: r.sender.encrypted, dropped: nonZero(r.sender.dropped) }, receiver: r.receiver && { decrypted: r.receiver.decrypted, dropped: nonZero(r.receiver.dropped) } })}`);
  return r;
}

function nonZero(d: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(d).filter(([, n]) => n > 0));
}

const encrypted = (r: FailClosedResult): number => Object.values(r.sender?.encrypted ?? {}).reduce((a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0);
const decrypted = (r: FailClosedResult): number => Object.values(r.receiver?.decrypted ?? {}).reduce((a, b) => a + b, 0);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
});

test('control: a dilla sender and receiver carry video, and the path is the expected one', async ({ page, browserName }) => {
  const r = await run(page, { send: 'dilla', label: 'vp8', recv: 'dilla', ms: MS });
  expect(r.path).toBe(browserName === 'firefox' ? 'script-transform' : 'insertable-streams');
  expect(encrypted(r)).toBeGreaterThan(10);
  expect(decrypted(r)).toBeGreaterThan(10);
  expect(r.rendered).toBeGreaterThan(5);
  expect(r.errors).toEqual([]);
});

test('a sender labelled with a server-forced codec (AV1) still attaches and encrypts what it sends', async ({ page }) => {
  const r = await run(page, { send: 'dilla', label: 'av1', recv: 'dilla', ms: MS });
  expect(r.negotiatedCodec.toLowerCase()).toBe('video/vp8');
  expect(encrypted(r)).toBeGreaterThan(10);
  expect(decrypted(r)).toBeGreaterThan(10);
  expect(r.sender?.passedThrough).toBe(0);
  expect(r.errors).toEqual([]);
});

test('a sender whose frames have no prefix rule (AV1) sends 0 media bytes', async ({ page }) => {
  const r = await run(page, { send: 'dilla', label: 'av1', sendCodec: 'video/AV1', recv: 'dilla', ms: MS });
  expect(r.negotiatedCodec.toLowerCase()).toBe('video/av1');
  expect(r.bytesSent).toBe(0);
  expect(encrypted(r)).toBe(0);
  expect(r.sender?.dropped.unsupportedCodec).toBeGreaterThan(10);
  expect(r.rendered).toBe(0);
  expect(r.errors).toContainEqual(expect.stringContaining('unsupportedCodec'));
});

test('a sender with no slot (unknown source) is blocked: 0 media bytes, reported and unpublished', async ({ page }) => {
  const r = await run(page, { send: 'dilla', label: 'vp8', source: 'unknown', recv: 'dilla', ms: MS });
  expect(r.bytesSent).toBe(0);
  expect(encrypted(r)).toBe(0);
  expect(r.sender?.dropped.blocked).toBeGreaterThan(10);
  expect(r.unpublished).toHaveLength(1);
  expect(r.senderTrackEnded).toBe(true);
  expect(r.errors).toContainEqual(expect.stringContaining('E_BAD_OPTIONS'));
});

test('control: a receiver without any transform renders a plaintext sender', async ({ page }) => {
  const r = await run(page, { send: 'plain', recv: 'none', ms: MS });
  expect(r.bytesSent).toBeGreaterThan(1_000);
  expect(r.rendered).toBeGreaterThan(5);
});

// Measured (task 17 fix round 1): Chromium decodes nothing (no encoded streams under the forced flag). Firefox 155
// keeps decoding into the stopped track internally (inbound-rtp framesDecoded rises) but no frame reaches any sink:
// the track is ended, so the page can neither render nor read it.
test('a receiver whose transform cannot be attached at all renders 0 frames of that plaintext sender', async ({ page, browserName }) => {
  const r = await run(page, { send: 'plain', recv: 'dilla', recvFailure: 'all', ms: MS });
  expect(r.bytesSent).toBeGreaterThan(1_000);
  expect(r.rendered).toBe(0);
  if (browserName === 'chromium') expect(r.framesDecoded).toBe(0);
  expect(r.remoteTrackEnded).toBe(true);
  expect(r.errors).toContainEqual(expect.stringContaining('receiver'));
});

test('a receiver whose dilla options are refused gets a blocking transform and renders 0 frames', async ({ page, browserName }) => {
  test.skip(browserName !== 'firefox', 'options are a script-transform concept; Chromium has no options to refuse');
  const r = await run(page, { send: 'plain', recv: 'dilla', recvFailure: 'options', ms: MS });
  expect(r.bytesSent).toBeGreaterThan(1_000);
  expect(r.rendered).toBe(0);
  expect(r.remoteTrackEnded).toBe(false); // blocked by a transform, not stopped
  expect(r.receiver?.dropped.blocked).toBeGreaterThan(10);
});
