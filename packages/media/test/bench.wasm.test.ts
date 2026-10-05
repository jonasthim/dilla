import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { initSync, MediaReceiver, MediaSender } from '../wasm/dilla_core_wasm.js';
import { hexToBytes } from '../src/slots';

// SP-08 (folded into task 17): soft-AES aes-gcm 0.10.3 compiled to wasm, per frame, under Node. The budget is
// one 4 Mbps screen share (30 frames/s of 17 000 bytes) plus 24 Opus receivers (24 × 50 frames/s of 160 bytes,
// 64 kbps / 20 ms) decrypted by one device, which must stay under 25 % of one core (250 ms per second).

const DEV_A = hexToBytes('a1'.repeat(16));
const DEV_B = hexToBytes('b2'.repeat(16));
const BASE = new Uint8Array(16).fill(0x0a);
const SIZES = [160, 1_000, 10_000, 17_000, 100_000];

beforeAll(() => {
  initSync({ module: readFileSync(new URL('../wasm/dilla_core_wasm_bg.wasm', import.meta.url)) });
});

function bench(size: number): { encryptUs: number; decryptUs: number } {
  const n = size >= 100_000 ? 200 : 2_000;
  const opus = size <= 160;
  const codec = opus ? 0 : 2; // opus on the microphone slot; vp9 (0-byte prefix) on the screen-video slot
  const slot = opus ? 0 : 2;
  const sender = new MediaSender(BASE, 0, 1n, 1n);
  const receiver = new MediaReceiver();
  const devices = new Uint8Array(32);
  devices.set(DEV_A, 0);
  devices.set(DEV_B, 16);
  receiver.install_epoch(1n, BASE, Uint32Array.from([0, 1]), devices, 1, 0);
  const plain = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
  const frames: Uint8Array[] = [];
  let t0 = performance.now();
  for (let i = 0; i < n; i++) frames.push(sender.encrypt(codec, slot, 0, plain));
  const encryptUs = ((performance.now() - t0) * 1_000) / n;
  t0 = performance.now();
  for (const f of frames) receiver.decrypt(codec, f, DEV_A, slot, 0);
  const decryptUs = ((performance.now() - t0) * 1_000) / n;
  sender.free();
  receiver.free();
  return { encryptUs, decryptUs };
}

it('records µs per frame and keeps one 4 Mbps share plus 24 Opus receivers under 25 % of one core', () => {
  const r = Object.fromEntries(SIZES.map((s) => [s, bench(s)]));
  console.log(`BENCH ${JSON.stringify(r)}`);
  const msPerSecond = (30 * r[17_000].decryptUs + 24 * 50 * r[160].decryptUs) / 1_000;
  console.log(`BENCH budget_ms_per_s=${msPerSecond.toFixed(2)}`);
  expect(msPerSecond).toBeLessThan(250);
});
