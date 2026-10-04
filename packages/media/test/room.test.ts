// I1 against the real livekit-client 2.22.3 Room (it constructs under Node; nothing connects): the options joinCall
// builds make Room use the dilla manager, whatever the caller passes, and assertDillaManager refuses any other Room.
import { describe, expect, it } from 'vitest';
import { Room } from 'livekit-client';
import { assertDillaManager, dillaRoomOptions } from '../src/connect';
import { DATA_CHANNEL_ERROR, DillaE2EEManager } from '../src/manager';

class FakeWorker extends EventTarget {
  postMessage(): void {}
  terminate(): void {}
}

const manager = (): DillaE2EEManager => new DillaE2EEManager(new FakeWorker() as unknown as Worker, { initTimeoutMs: 60_000 });

describe('the real Room uses the dilla manager (I1)', () => {
  it('with dillaRoomOptions, even when the caller passes encryption, e2ee or frameMetadata', () => {
    const m = manager();
    const other = manager();
    const room = new Room(dillaRoomOptions(m, { encryption: { e2eeManager: other }, e2ee: { e2eeManager: other }, frameMetadata: {} } as never));
    expect(room.hasE2EESetup).toBe(true);
    expect(() => assertDillaManager(room, m)).not.toThrow();
    expect(() => assertDillaManager(room, other)).toThrow('E_E2EE_REQUIRED');
    expect(m.isDataChannelEncryptionEnabled).toBe(false);
  });

  it('a Room without the dilla manager is refused; `encryption:` cannot even construct one around it', () => {
    const m = manager();
    expect(() => assertDillaManager(new Room({}), m)).toThrow('E_E2EE_REQUIRED');
    // Room.setupE2EE assigns isDataChannelEncryptionEnabled = !!options.encryption (Room.ts:509-515); the setter refuses true.
    expect(() => new Room({ encryption: { e2eeManager: m } })).toThrow(DATA_CHANNEL_ERROR);
  });
});
