// UP7 (R-UP8): the signalling resume keeps trying for 90 s, with a delay capped at 5 s. An API restart drops LiveKit's
// signalling (it goes through the API's /rtc gate) while the media to the SFU flows on; livekit-server v1.13.7 keeps such
// a participant for as long as its ICE stays connected (participant.go:1039-1044), so the client may keep resuming.
import { describe, expect, it } from 'vitest';
import { Room } from 'livekit-client';
import { DillaReconnectPolicy, RECONNECT_DELAY_CAP_MS, RECONNECT_WINDOW_MS, ROOM_DEFAULTS, dillaRoomOptions } from '../src/connect';
import { DillaE2EEManager } from '../src/manager';

class FakeWorker extends EventTarget {
  postMessage(): void {}
  terminate(): void {}
}

describe('UP7: the reconnect policy', () => {
  it('keeps trying through 90 s with no delay over 5 s, then gives up', () => {
    const p = new DillaReconnectPolicy();
    expect(RECONNECT_WINDOW_MS).toBe(90_000);
    expect(RECONNECT_DELAY_CAP_MS).toBe(5_000);
    let elapsed = 0;
    let count = 0;
    for (;;) {
      const d = p.nextRetryDelayInMs({ retryCount: count, elapsedMs: elapsed });
      if (d === null) break;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(5_000);
      elapsed += d + 1_000; // each attempt itself takes time
      count += 1;
    }
    expect(elapsed).toBeGreaterThanOrEqual(90_000);
    expect(count).toBeGreaterThan(10);
    expect(p.nextRetryDelayInMs({ retryCount: 30, elapsedMs: 89_000 })).toBeLessThanOrEqual(1_000);
    expect(p.nextRetryDelayInMs({ retryCount: 50, elapsedMs: 90_000 })).toBeNull();
    // The first two retries are at once and after 300 ms, as LiveKit's own.
    expect(p.nextRetryDelayInMs({ retryCount: 0, elapsedMs: 0 })).toBe(0);
    expect(p.nextRetryDelayInMs({ retryCount: 1, elapsedMs: 100 })).toBe(300);
  });

  it('is the Room default and reaches the real Room', () => {
    expect(ROOM_DEFAULTS.reconnectPolicy).toBeInstanceOf(DillaReconnectPolicy);
    const m = new DillaE2EEManager(new FakeWorker() as unknown as Worker, { initTimeoutMs: 60_000 });
    const room = new Room(dillaRoomOptions(m));
    expect(room.options.reconnectPolicy).toBeInstanceOf(DillaReconnectPolicy);
  });
});
