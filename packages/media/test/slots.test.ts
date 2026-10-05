import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Track } from 'livekit-client';
import {
  CODEC_NUMBER, codecFromMime, codecKind, hexToBytes, isDeviceIdentity, kindMatchesSource, slotKind, sourceToSlot, trackSourceToSlot,
} from '../src/slots';
import { isVoiceSupported } from '../src/support';

const src = (s: string): Track.Source => s as Track.Source;
const DEVICE = 'a1'.repeat(16);

describe('slots', () => {
  it('maps Track.Source to the dilla-sframe/1 slot and refuses unknown', () => {
    expect(sourceToSlot(src('microphone'))).toBe(0);
    expect(sourceToSlot(src('camera'))).toBe(1);
    expect(sourceToSlot(src('screen_share'))).toBe(2);
    expect(sourceToSlot(src('screen_share_audio'))).toBe(3);
    expect(() => sourceToSlot(src('unknown'))).toThrow('E_BAD_OPTIONS');
  });

  it('maps the LiveKit TrackSource enum and rejects UNKNOWN', () => {
    expect(trackSourceToSlot(2)).toBe(0);
    expect(trackSourceToSlot(1)).toBe(1);
    expect(trackSourceToSlot(3)).toBe(2);
    expect(trackSourceToSlot(4)).toBe(3);
    expect(() => trackSourceToSlot(0)).toThrow('E_BAD_OPTIONS');
    expect(() => trackSourceToSlot(5)).toThrow('E_BAD_OPTIONS');
  });

  it('accepts only 32 lowercase hex as a device identity', () => {
    expect(isDeviceIdentity(DEVICE)).toBe(true);
    expect(isDeviceIdentity(DEVICE.toUpperCase())).toBe(false);
    expect(isDeviceIdentity(DEVICE.slice(1))).toBe(false);
    expect(isDeviceIdentity(`${DEVICE}#rig`)).toBe(false);
    expect(isDeviceIdentity('')).toBe(false);
  });

  it('matches track kind to source: audio ⇔ microphone or screen-share audio, video ⇔ camera or screen share', () => {
    expect(kindMatchesSource('audio', src('microphone'))).toBe(true);
    expect(kindMatchesSource('audio', src('screen_share_audio'))).toBe(true);
    expect(kindMatchesSource('audio', src('camera'))).toBe(false);
    expect(kindMatchesSource('video', src('camera'))).toBe(true);
    expect(kindMatchesSource('video', src('screen_share'))).toBe(true);
    expect(kindMatchesSource('video', src('microphone'))).toBe(false);
  });

  it('reads the codec from a MIME type and refuses AV1, H.265 and a kind mismatch', () => {
    expect(codecFromMime('video/VP8', 'video')).toBe('vp8');
    expect(codecFromMime('video/H264', 'video')).toBe('h264');
    expect(codecFromMime('video/vp9', 'video')).toBe('vp9');
    expect(codecFromMime('audio/opus', 'audio')).toBe('opus');
    expect(codecFromMime('video/AV1', 'video')).toBeNull();
    expect(codecFromMime('video/H265', 'video')).toBeNull();
    expect(codecFromMime('audio/opus', 'video')).toBeNull();
    expect(codecFromMime(undefined, 'video')).toBeNull();
  });

  it('knows the kind of every slot and codec and the codec numbers of the wasm surface', () => {
    expect([0, 1, 2, 3].map((s) => slotKind(s as 0 | 1 | 2 | 3))).toEqual(['audio', 'video', 'video', 'audio']);
    expect(codecKind('opus')).toBe('audio');
    expect(codecKind('h264')).toBe('video');
    expect(CODEC_NUMBER).toEqual({ opus: 0, vp8: 1, vp9: 2, h264: 3 });
  });

  it('decodes hex and refuses malformed hex', () => {
    expect(hexToBytes('00ff10')).toEqual(Uint8Array.from([0, 255, 16]));
    expect(() => hexToBytes('0')).toThrow('E_BAD_OPTIONS');
    expect(() => hexToBytes('zz')).toThrow('E_BAD_OPTIONS');
  });
});

describe('the voice gate (DEV-28)', () => {
  const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0';
  afterEach(() => vi.unstubAllGlobals());

  it('Chromium with createEncodedStreams uses insertable streams', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    vi.stubGlobal('RTCRtpSender', class { createEncodedStreams(): void {} });
    vi.stubGlobal('RTCRtpScriptTransform', class {});
    expect(isVoiceSupported()).toEqual({ ok: true, path: 'insertable-streams' });
  });

  it('Chromium without createEncodedStreams is refused even with RTCRtpScriptTransform', () => {
    vi.stubGlobal('navigator', { userAgent: CHROME });
    vi.stubGlobal('RTCRtpSender', class {});
    vi.stubGlobal('RTCRtpScriptTransform', class {});
    expect(isVoiceSupported()).toEqual({ ok: false, reason: 'chromium-flag-missing' });
  });

  it('Firefox with RTCRtpScriptTransform uses script transforms', () => {
    vi.stubGlobal('navigator', { userAgent: FIREFOX });
    vi.stubGlobal('RTCRtpSender', class {});
    vi.stubGlobal('RTCRtpScriptTransform', class {});
    expect(isVoiceSupported()).toEqual({ ok: true, path: 'script-transform' });
  });

  it('a browser with neither API is refused', () => {
    vi.stubGlobal('navigator', { userAgent: FIREFOX });
    vi.stubGlobal('RTCRtpSender', class {});
    vi.stubGlobal('RTCRtpScriptTransform', undefined);
    expect(isVoiceSupported()).toEqual({ ok: false, reason: 'no-transform-api' });
  });
});
