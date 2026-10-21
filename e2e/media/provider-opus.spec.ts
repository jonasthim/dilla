import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { expect, test } from './support/test';
import { DS_URL, MediaDriver, epochWire, kidHex, testkitEnv, type CallToken, type MediaKey } from './support/driver';
import type { DillaHarness, DillaHarness21, DillaRemoteStats } from '../../packages/media/harness/main';

type W = { harness: DillaHarness & DillaHarness21 };
type BotReport = { published: Record<string, string>; decrypted: number; decrypted_by_kind: Record<string, number> };
const HARNESS = 'http://127.0.0.1:5179/';
const MAX_INPUT_BYTES = 1 << 20;
const sourcePath = process.env.DILLA_PROVIDER_OPUS_FILE;
const providerName = process.env.DILLA_PROVIDER_NAME;

async function stageInput(path: string, scratch: string): Promise<{ bytes: number; sha256: string }> {
  if (!isAbsolute(path)) throw new Error('provider input must be an absolute regular file');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) throw new Error('invalid provider input');
    const data = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length < 1 || length > MAX_INPUT_BYTES) throw new Error('invalid provider input');
    const content = data.subarray(0, length);
    const output = await open(join(scratch, 'tone.ogg'), 'wx', 0o600);
    try { await output.writeFile(content); } finally { await output.close(); }
    return { bytes: length, sha256: createHash('sha256').update(content).digest('hex') };
  } catch {
    throw new Error('provider input must be a readable, bounded regular file (symlinks are refused)');
  } finally {
    await handle?.close();
  }
}

function runEncryptedBot(args: string[], baseKey: string, timeoutMs: number): Promise<BotReport> {
  const bin = process.env.DILLA_MEDIABOT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'target', 'dilla-mediabot');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let finished = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 16_384) child.kill('SIGTERM');
    });
    // Do not forward child diagnostics: the room token and provider input must stay out of logs.
    child.stderr.on('data', () => {});
    child.once('error', () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error('dilla-mediabot could not be started'));
    });
    child.once('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0 || output.length > 16_384) {
        reject(new Error('dilla-mediabot did not complete successfully'));
        return;
      }
      try { resolve(JSON.parse(output.trim()) as BotReport); }
      catch { reject(new Error('dilla-mediabot returned an invalid report')); }
    });
    child.stdin.end(`${baseKey}\n`);
  });
}

const remoteAudio = async (page: import('@playwright/test').Page, identity: string) =>
  (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRemoteStats()))
    .filter((row) => row.participantIdentity === identity && row.kind === 'audio' && row.source === 'microphone');

test('external Ogg Opus is encrypted by the Go peer and authenticated by Chromium and Firefox', async ({ browser, browserName }, info) => {
  test.setTimeout(120_000);
  test.skip(!sourcePath, 'unqualified: set DILLA_PROVIDER_OPUS_FILE to a captured Ogg Opus file');
  test.skip(!providerName, 'unqualified: set DILLA_PROVIDER_NAME to youtube or spotify');
  test.skip(providerName === 'synthetic', 'synthetic Opus is a harness smoke only and cannot qualify a provider');
  if (providerName !== 'youtube' && providerName !== 'spotify') throw new Error('DILLA_PROVIDER_NAME must be youtube or spotify');

  const scratch = await mkdtemp(join(tmpdir(), 'dilla-provider-opus-'));
  await chmod(scratch, 0o700);
  const tokenPath = join(scratch, 'room-token');
  let driver: MediaDriver | undefined;
  let bot: Promise<BotReport> | undefined;
  try {
    const input = await stageInput(sourcePath!, scratch);
    driver = await MediaDriver.start(DS_URL, testkitEnv());
    await driver.request('setup', { actors: ['alice', 'erin'] });
    await driver.request('open_call', { actor: 'alice' });
    await driver.request('join', { actor: 'erin' });
    await driver.request('sync', { actor: 'alice' });

    const page = await (await browser.newContext()).newPage();
    await page.goto(HARNESS);
    const aliceKey = await driver.request<MediaKey>('media_key', { actor: 'alice' });
    const aliceToken = await driver.request<CallToken>('call_token', { actor: 'alice', vdec: 'vp8' });
    await page.evaluate((o) => (globalThis as unknown as W).harness.dillaJoin(o), {
      livekitUrl: aliceToken.livekitUrl, token: aliceToken.token, iceServers: aliceToken.iceServers,
      epoch: epochWire(aliceKey, aliceKey.epoch), caps: aliceToken.caps,
    });

    const publisher = await driver.request<{ deviceId: string }>('device', { actor: 'erin' });
    const publisherKey = await driver.request<MediaKey>('media_key', { actor: 'erin' });
    const publisherToken = await driver.request<CallToken>('call_token', { actor: 'erin', vdec: 'vp8' });
    const tokenFile = await open(tokenPath, 'wx', 0o600);
    try { await tokenFile.writeFile(publisherToken.token); } finally { await tokenFile.close(); }

    bot = runEncryptedBot([
      '-url', publisherToken.livekitUrl, '-token-file', tokenPath, '-base-key-file', '-',
      '-leaf', String(publisherKey.selfLeaf), '-epoch', publisherKey.epoch,
      '-roster', publisherKey.roster.map((r) => `${r.leaf}:${r.deviceId}`).join(','),
      '-publish', 'opus', '-duration', '15s', '-media', scratch,
    ], publisherKey.baseKey, 40_000);
    const kid = kidHex(publisherKey.selfLeaf, publisherKey.epoch);

    let matched: DillaRemoteStats | undefined;
    await expect.poll(async () => {
      const tracks = await remoteAudio(page, publisher.deviceId);
      if (tracks.length === 1) matched = tracks[0];
      return tracks.length === 1 && tracks[0].packetsReceived > 0;
    }, { timeout: 25_000, message: 'one microphone track from the expected provider peer reaches the SFU receiver' }).toBe(true);

    const trackId = matched!.trackId;
    const authenticated = async () => {
      const stats = await page.evaluate(() => (globalThis as unknown as W).harness.dillaStats());
      return stats.decryptedByTrackKid[trackId]?.[kid] ?? 0;
    };
    await expect.poll(authenticated, { timeout: 20_000 }).toBeGreaterThan(0);
    const first = await authenticated();
    await expect.poll(authenticated, { timeout: 5_000 }).toBeGreaterThan(first);
    await expect.poll(async () => {
      const tracks = await remoteAudio(page, publisher.deviceId);
      return tracks.length === 1 ? tracks[0].totalSamplesReceived : 0;
    }, { timeout: 10_000 }).toBeGreaterThan(0);

    const probes = (await page.evaluate(() => (globalThis as unknown as W).harness.dillaRenderProbe(1_000)))
      .filter((row) => row.participantIdentity === publisher.deviceId && row.kind === 'audio');
    expect(probes).toHaveLength(1);
    expect(probes[0].rms).toBeGreaterThan(0.001);
    const botReport = await bot;
    expect(botReport.published.opus).toMatch(/^TR_/);
    expect(botReport.decrypted).toBe(0);
    expect((await authenticated())).toBeGreaterThan(first);

    const finalTracks = await remoteAudio(page, publisher.deviceId);
    expect(finalTracks).toHaveLength(1);
    const evidence = {
      provider: providerName,
      browser: browserName,
      sha256: input.sha256,
      input_bytes: input.bytes,
      audio_tracks: 1,
      authenticated_frames: await authenticated(),
      samples_received: finalTracks[0].totalSamplesReceived,
      rms: probes[0].rms,
    };
    await info.attach('provider-opus-evidence.json', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(`PROVIDER_OPUS ${JSON.stringify(evidence)}`);
  } finally {
    await bot?.catch(() => undefined);
    await driver?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
