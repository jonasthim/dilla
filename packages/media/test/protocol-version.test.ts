import { describe, expect, it } from 'vitest';
import { protocolVersion } from 'livekit-client';

// dillad's /rtc gate admits exactly one LiveKit signalling protocol: ClientProtocol in
// internal/sfu/rtcjoin.go (17, branch review SFU-1), because LiveKit labels metric series with the
// number a client sends. livekit-client exports the number it sends as `protocolVersion`
// (src/version.ts). A bump of livekit-client that changes it makes every call 400 at /rtc until
// ClientProtocol moves with it: change both together, and TestTheGoSDKSpeaksTheAdmittedProtocol
// pins the Go SDK's side.
describe('the LiveKit signalling protocol', () => {
  it('is the one the /rtc gate admits (internal/sfu/rtcjoin.go ClientProtocol)', () => {
    expect(protocolVersion).toBe(17);
  });
});
