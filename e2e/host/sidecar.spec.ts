import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DILLAD_BIN, buildDillad, buildTestHost, removeHostData, startMediaHost, startTestHost, swapWebRoot, type HostConfig } from '../web/support/host.ts';
import { writeFakeDist } from './fake-dist.ts';

// UP5 smoke: the SFU (`dillad media`) and the API (dilla-testhost -sfu-sidecar) are separate processes; each restarts on its own.
const PORT = 8491, CONTROL = 8492, SFU_PORT = 7894, SFU_UDP = 7896, WEBHOOK = 8497;

test.beforeAll(() => { buildTestHost(); buildDillad(); });

async function openRoom(control: string, room: string): Promise<{ url: string }> {
  const res = await fetch(`${control}/debug/sfu/token`, { method: 'POST', body: JSON.stringify({ room, identity: '0123456789abcdef0123456789abcdef', create: true }) });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { url: string };
}

function liveRooms(configPath: string): string {
  return execFileSync(DILLAD_BIN, ['media', '--rooms', '--config', configPath], { encoding: 'utf8' });
}

test('the SFU and the API start, stop and restart as separate processes', async () => {
  removeHostData(PORT);
  const media = await startMediaHost({ port: SFU_PORT, udpPort: SFU_UDP, webhookURL: `http://127.0.0.1:${WEBHOOK}` });
  const hostConfig: HostConfig = { port: PORT, control: CONTROL, webRoot: null, keepData: true, sfu: { port: SFU_PORT, udpPort: SFU_UDP }, sidecar: media.sidecar };
  let host = await startTestHost(hostConfig);
  try {
    // The media process wrote media.json into its own data directory, for its own pid.
    const state = JSON.parse(readFileSync(join(media.dataDir, 'media.json'), 'utf8')) as { pid: number };
    expect(state.pid).toBe(media.pid());
    expect(media.dataDir).not.toContain('/var/lib/dillad');

    expect((await openRoom(host.control, 'sidecar-smoke')).url).toBe(`ws://127.0.0.1:${SFU_PORT}`);
    expect(liveRooms(media.configPath)).toContain('sidecar-smoke');

    // The API restarts alone: the SFU keeps its pid and its room.
    const sfuPid = media.pid();
    await host.stop();
    expect(liveRooms(media.configPath)).toContain('sidecar-smoke');
    host = await startTestHost(hostConfig);
    expect(media.pid()).toBe(sfuPid);
    await openRoom(host.control, 'sidecar-smoke-2');

    // The SFU restarts alone: a new pid, the API host untouched and still serving it.
    await media.restartMedia();
    expect(media.pid()).not.toBe(sfuPid);
    const after = JSON.parse(readFileSync(join(media.dataDir, 'media.json'), 'utf8')) as { pid: number };
    expect(after.pid).toBe(media.pid());
    expect(liveRooms(media.configPath)).not.toContain('sidecar-smoke');
    await openRoom(host.control, 'sidecar-smoke-3');
    expect(liveRooms(media.configPath)).toContain('sidecar-smoke-3');
  } finally {
    await host.stop();
    await media.stop();
    removeHostData(PORT);
  }
  expect(existsSync(media.dataDir)).toBe(false);
});

test('a swapped web root changes /app-version.json and nothing else a page needs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dilla-swap-smoke-'));
  const dist = join(dir, 'dist');
  writeFakeDist(dist);
  const version = async (root: string) => {
    const h = await startTestHost({ port: PORT + 10, control: CONTROL + 10, webRoot: root });
    try {
      const url = `${h.url}/app-version.json`;
      return (await (await fetch(url)).json()) as { entry: string };
    } finally { await h.stop(); }
  };
  expect((await version(dist)).entry).toBe('/assets/index-AbC123.js');
  expect((await version(swapWebRoot(dist, join(dir, 'swapped')))).entry).toBe('/assets/index-AbC123-next.js');
});
