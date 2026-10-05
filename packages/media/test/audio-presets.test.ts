import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import {
  MIC,
  MIC_BITRATE_BPS,
  SCREEN_AUDIO,
  SCREEN_AUDIO_BITRATE_BPS,
  SCREEN_AUDIO_CAPTURE,
  micOptions,
  screenAudioOptions,
  decodeCaps,
  publishDefaults,
} from '../src/audio/presets';

describe('publish presets', () => {
  it('the mic is 64 kbit/s, DTX, no RED, mono — every value explicit (DEV-08)', () => {
    // forceStereo and dtx are passed explicitly. livekit-client derives TF_STEREO from the source
    // track's channel count, not a processor's destination node.
    expect(MIC).toEqual({
      source: Track.Source.Microphone,
      dtx: true,
      red: false,
      forceStereo: false,
    });
    expect(MIC_BITRATE_BPS).toBe(64_000);
  });

  it('screen audio is 96 kbit/s stereo without DTX or RED (F2)', () => {
    expect(SCREEN_AUDIO).toEqual({
      source: Track.Source.ScreenShareAudio,
      forceStereo: true,
      dtx: false,
      red: false,
    });
    expect(SCREEN_AUDIO_BITRATE_BPS).toBe(96_000);
    expect(SCREEN_AUDIO_CAPTURE).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    });
  });
});

describe('caps', () => {
  it('bare publish constants cannot override the instance bitrate cap', () => {
    expect(MIC.audioPreset).toBeUndefined();
    expect(SCREEN_AUDIO.audioPreset).toBeUndefined();
  });
  it('a 32 kbit/s cap binds both per-publish audio presets after LiveKit merges options', () => {
    const caps = { maxAudioBitrateBps: 32_000, maxShareBitrateBps: 1_000_000, vp9: false };
    expect(({ ...publishDefaults(caps), ...micOptions(caps) }).audioPreset?.maxBitrate).toBe(32_000);
    expect(({ ...publishDefaults(caps), ...screenAudioOptions(caps) }).audioPreset?.maxBitrate).toBe(32_000);
  });
  it('decodes the calls response element 5 (MD-10)', () => {
    expect(decodeCaps([64_000, 2_500_000, 0])).toEqual({ maxAudioBitrateBps: 64_000, maxShareBitrateBps: 2_500_000, vp9: false });
    expect(decodeCaps([32_000, 1_000_000, 1]).vp9).toBe(true);
  });

  it('refuses a cap that is not a positive integer or a vp9 flag that is not 0 or 1', () => {
    expect(() => decodeCaps([0, 2_500_000, 0])).toThrow('E_BAD_OPTIONS');
    expect(() => decodeCaps([64_000, 1.5, 0])).toThrow('E_BAD_OPTIONS');
    expect(() => decodeCaps([64_000, 2_500_000, 2])).toThrow('E_BAD_OPTIONS');
  });

  it('publish defaults carry the dilla audio shape and clamp both bitrates to the caps (DEV-26)', () => {
    const d = publishDefaults({ maxAudioBitrateBps: 32_000, maxShareBitrateBps: 1_000_000, vp9: false });
    expect(d.audioPreset).toEqual({ maxBitrate: 32_000, priority: 'high' });
    expect(d.dtx).toBe(true);
    expect(d.red).toBe(false);
    expect(d.forceStereo).toBe(false);
    expect(d.videoCodec).toBe('vp8');
    expect(d.simulcast).toBe(true);
    expect(d.backupCodec).toBe(false);
    expect(d.screenShareEncoding?.maxBitrate).toBe(1_000_000);
    expect(d.screenShareEncoding?.maxFramerate).toBe(15);
  });

  it('a cap above the preset never raises it', () => {
    const d = publishDefaults({ maxAudioBitrateBps: 510_000, maxShareBitrateBps: 20_000_000, vp9: true });
    expect(d.audioPreset?.maxBitrate).toBe(64_000);
    expect(d.screenShareEncoding?.maxBitrate).toBe(2_500_000);
  });
});
