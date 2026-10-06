import { describe, expect, it } from 'vitest';
import { toHex } from '../hex';
import { FakeCore } from '../testing/fake-core';
import { FakeServer, sessionFor } from '../testing/fake-server';
import { refillKeyPackages } from './keypackages';

const DEVICE = new Uint8Array(16).fill(0xa1);
const LIMITS = { perDevice: 32, threshold: 8 };

async function setup() {
  const server = new FakeServer();
  const userId = server.register('ada', DEVICE);
  const core = FakeCore.identified({ instanceId: new Uint8Array(16).fill(0xab), userId, deviceId: DEVICE, username: 'ada' });
  const { routes, session } = sessionFor(server, core);
  await session.establish();
  return { server, core, routes };
}

describe('refillKeyPackages', () => {
  it('does nothing at or above the threshold', async () => {
    const { server, core, routes } = await setup();
    expect(await refillKeyPackages(core, routes, 8, LIMITS)).toBe(0);
    expect(server.count('POST', '/v1/keypackages')).toBe(0);
  });

  it('tops up to the per-device count without a last-resort package', async () => {
    const { server, core, routes } = await setup();
    expect(await refillKeyPackages(core, routes, 7, LIMITS)).toBe(25);
    expect(server.keyPackages).toEqual([{ device: toHex(DEVICE), count: 25, lastResort: false }]);
  });

  it('publishes the full set and a last-resort package from zero', async () => {
    const { server, core, routes } = await setup();
    expect(await refillKeyPackages(core, routes, 0, LIMITS)).toBe(32);
    expect(server.keyPackages).toEqual([{ device: toHex(DEVICE), count: 32, lastResort: true }]);
  });

  it('never asks the core for more than 32', async () => {
    const { server, core, routes } = await setup();
    expect(await refillKeyPackages(core, routes, 0, { perDevice: 40, threshold: 8 })).toBe(32);
    expect(server.keyPackages[0]?.count).toBe(32);
  });
});
