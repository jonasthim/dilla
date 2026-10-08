import { describe, expect, it, vi } from 'vitest';
import { encode, type CborInput } from '../cbor';
import { readDeviceListHistory } from './trust';

const USER = new Uint8Array(16).fill(7);
const body = (version: number): Uint8Array => new Uint8Array([version]);
const row = (version: number): CborInput[] => [version, body(version), new Uint8Array(64), new Uint8Array(32)];

describe('readDeviceListHistory', () => {
  it('rejects a page whose advertised last version disagrees with its signed rows', async () => {
    const routes = {
      getDeviceList: vi.fn(() => Promise.resolve({ version: 1n, blob: body(1), raw: encode(row(1)) })),
      getDeviceListHistory: vi.fn(() => Promise.resolve({ raw: encode([row(1)]), count: 1, lastVersion: 2n })),
    };
    await expect(readDeviceListHistory(routes as never, USER, 0n)).rejects.toMatchObject({ code: 'E_DEVICE_LIST_STALE' });
  });
});
