// SP-04 (task 3): is the canonical H.264 prefix (NALs before the first slice, its header and the
// slice header through pic_parameter_set_id, every start code 00 00 00 01) byte-identical on the
// sending and the receiving transform through LiveKit v1.13.7, so it can be AAD? Two Chromium 153
// peers, H.264 (packetization-mode 1, 42e01f), the stub worker in log-h264 mode on both sides.
// Spike code: spike-chromium only, never in CI (plan MD-17).
import { chromium, expect, test, type Browser, type Page, type Worker } from '@playwright/test';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumMediaArgs, writeFixtures } from '../media/support/fixtures.ts';
import { CONTROL, HARNESS } from '../media/support/testhost.ts';
import { activate, debugToken, deviceIdentity, sfuInfo, type HarnessWindow } from '../media/support/lk.ts';

test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium peers only');
test.setTimeout(900_000);

const KEY_TARGET = 100;
const DELTA_TARGET = 1_000;
const CHROME_LOG = join(tmpdir(), 'dilla-sp04-chrome.log');

interface Entry {
  side: 'encode' | 'decode'; rtpTimestamp: number; type: string; prefixLen: number; prefixHex: string; prefixSha256: string;
  sps: Array<{ vui: boolean; bitstreamRestriction: boolean; maxNumReorderFrames: number; maxDecFrameBuffering: number; maxNumRefFrames: number }>;
}

let browser: Browser | undefined;
test.beforeAll(async () => {
  rmSync(CHROME_LOG, { force: true });
  // A dedicated Chromium so its libwebrtc log can be grepped for "Failed to parse PPS id".
  // libwebrtc runs in the renderer, and a renderer never writes to --log-file (measured: the file
  // holds browser-process lines only), so Chromium logs to stderr and a wrapper appends its stderr
  // to CHROME_LOG; h264SourceLines below is the positive control that the log is not empty.
  const wrapper = join(tmpdir(), 'dilla-sp04-chrome.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec '${chromium.executablePath()}' "$@" 2>>'${CHROME_LOG}'\n`);
  chmodSync(wrapper, 0o755);
  browser = await chromium.launch({
    executablePath: wrapper,
    args: [...chromiumMediaArgs(writeFixtures(join(tmpdir(), 'dilla-media-fixtures'))),
      '--enable-logging=stderr', '--vmodule=*h264*=3'],
  });
});
test.afterAll(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  if (!browser) throw new Error('no browser');
  const page = await (await browser.newContext({ permissions: ['camera', 'microphone'], baseURL: HARNESS })).newPage();
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  return page;
}

async function connect(page: Page, url: string, room: string): Promise<void> {
  const { token } = await debugToken(CONTROL, room, deviceIdentity());
  await page.evaluate(([u, t]) => (window as unknown as HarnessWindow).harness.connect(u, t, { e2ee: 'stub', stub: { kind: 'log-h264' } }), [url, token] as const);
}

function stubWorker(page: Page): Worker {
  const w = page.workers().find((x) => x.url().includes('stub-worker'));
  if (!w) throw new Error('no stub worker');
  return w;
}

const log = (page: Page) => stubWorker(page).evaluate(() => (globalThis as unknown as { __stubLog: Entry[] }).__stubLog);

/**
 * Pairs decode entries with encode entries by RTP timestamp. LiveKit rewrites timestamps per
 * downtrack by a constant offset, which is the difference every received key frame shares with
 * the key frame that was sent: the most frequent key-to-key difference.
 */
function compare(enc: Entry[], dec: Entry[]) {
  const encKeys = enc.filter((e) => e.type === 'key');
  const votes = new Map<number, number>();
  for (const d of dec.filter((x) => x.type === 'key')) {
    for (const e of encKeys) { const o = (d.rtpTimestamp - e.rtpTimestamp) >>> 0; votes.set(o, (votes.get(o) ?? 0) + 1); }
  }
  const offset = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const byTs = new Map(enc.map((e) => [e.rtpTimestamp, e]));
  let keyIdentical = 0, deltaIdentical = 0, unmatched = 0;
  const differing: Array<{ rtp: number; type: string; sent: string; received: string }> = [];
  for (const d of dec) {
    const e = byTs.get((d.rtpTimestamp - offset) >>> 0);
    if (!e) { unmatched++; continue; }
    if (e.prefixHex === d.prefixHex) { if (d.type === 'key') keyIdentical++; else deltaIdentical++; }
    else if (differing.length < 20) differing.push({ rtp: d.rtpTimestamp, type: d.type, sent: e.prefixHex, received: d.prefixHex });
  }
  const spsInDelta = enc.filter((e) => e.type === 'delta' && e.sps.length > 0).length;
  const spsNotStable = enc.flatMap((e) => e.sps).filter((s) => !s.vui || !s.bitstreamRestriction || s.maxNumReorderFrames !== 0 || s.maxDecFrameBuffering > s.maxNumRefFrames).length;
  const prefixLens = [...new Set(enc.map((e) => e.prefixLen))].sort((a, b) => a - b);
  return { offset, encoded: enc.length, decoded: dec.length, keyIdentical, deltaIdentical, unmatched, differing, spsInDelta, spsNotStable, prefixLens, sampleKeyPrefix: encKeys[0]?.prefixHex ?? '' };
}

async function measure(source: 'camera' | 'screen') {
  const { url } = await sfuInfo(CONTROL);
  const room = `sp04-${source}-${Date.now()}`;
  const sender = await open();
  const receiver = await open();
  await connect(receiver, url, room);
  await connect(sender, url, room);
  if (source === 'screen') await activate(sender); // getDisplayMedia needs a real click first (fact 24)
  await sender.evaluate((s) => (window as unknown as HarnessWindow).harness.publish(s === 'camera' ? { camera: true, videoCodec: 'h264' } : { screen: true, videoCodec: 'h264' }), source);
  // Every new subscription makes the SFU ask the publisher for a key frame: a second receiver that
  // joins and leaves in a loop drives the key-frame count while the first collects delta frames.
  const churn = await open();
  const deadline = Date.now() + 600_000;
  for (;;) {
    const keys = (await log(receiver)).filter((e) => e.side === 'decode' && e.type === 'key').length;
    const deltas = (await log(receiver)).filter((e) => e.side === 'decode' && e.type === 'delta').length;
    if ((keys >= KEY_TARGET && deltas >= DELTA_TARGET) || Date.now() > deadline) break;
    await connect(churn, url, room);
    await churn.waitForTimeout(1_200);
    await churn.evaluate(() => (window as unknown as HarnessWindow).harness.disconnect());
  }
  const enc = (await log(sender)).filter((e) => e.side === 'encode');
  const dec = (await log(receiver)).filter((e) => e.side === 'decode');
  const remote = await receiver.evaluate(() => (window as unknown as HarnessWindow).harness.remoteStats());
  const chromeLog = existsSync(CHROME_LOG) ? readFileSync(CHROME_LOG, 'utf8') : '';
  const result = {
    source, chromium: browser?.version(), ...compare(enc, dec), remote,
    chromeLogBytes: chromeLog.length,
    h264SourceLines: (chromeLog.match(/^\[[^\]]*:third_party\/webrtc\/[^\]]*h264[^\]]*\]/gm) ?? []).length,
    failedToParsePpsId: (chromeLog.match(/Failed to parse PPS id/g) ?? []).length,
    noPpsWithId: (chromeLog.match(/No PPS with id/g) ?? []).length,
  };
  console.log(`SP-04 RESULT ${JSON.stringify(result)}`);
  await test.info().attach(`sp04-${source}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  for (const p of [sender, receiver, churn]) await p.context().close();
  return result;
}

test('the canonical camera H.264 prefix is identical on send and receive (100 key + 1 000 delta)', async () => {
  const r = await measure('camera');
  expect(r.differing).toEqual([]);
  expect(r.keyIdentical).toBeGreaterThanOrEqual(KEY_TARGET);
  expect(r.deltaIdentical).toBeGreaterThanOrEqual(DELTA_TARGET);
  expect(r.h264SourceLines).toBeGreaterThan(0); // the renderer's libwebrtc log was captured
  expect(r.failedToParsePpsId).toBe(0);
  expect(r.remote.find((s) => s.kind === 'video')?.framesDecoded ?? 0).toBeGreaterThan(DELTA_TARGET);
});

test('the screen-share (contentHint detail) H.264 prefix is identical on send and receive', async () => {
  const r = await measure('screen');
  expect(r.differing).toEqual([]);
  expect(r.keyIdentical + r.deltaIdentical).toBeGreaterThan(0);
  expect(r.h264SourceLines).toBeGreaterThan(0);
  expect(r.failedToParsePpsId).toBe(0);
});
