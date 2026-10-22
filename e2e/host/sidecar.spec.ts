import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DILLAD_BIN, buildDillad, buildTestHost, removeHostData, startMediaHost, startTestHost, swapWebRoot, type HostConfig } from '../web/support/host.ts';
import { writeFakeDist } from './fake-dist.ts';

// UP5 smoke: the SFU (`dillad media`) and the API (dilla-testhost -sfu-sidecar) are separate processes; each restarts on its own.
// Ports no other spec binds (UP9: 8491/8492/8497 were roles.spec's and passkey.spec's too). Nothing here waits on a room's
// departure: the rooms are opened by the control listener's token route and checked while they exist.
const PORT = 8541, CONTROL = 8542, SFU_PORT = 7914, SFU_UDP = 7916, WEBHOOK = 8547;

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
    // The media process wrote media.json into its own data directory (startMediaHost waited for it to name its pid).
    expect(existsSync(join(media.dataDir, 'media.json'))).toBe(true);
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
