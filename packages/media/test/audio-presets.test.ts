import { describe, expect, it } from 'vitest';
import { Track } from 'livekit-client';
import {
  MIC,
  MIC_BITRATE_BPS,
  SCREEN_AUDIO,
  SCREEN_AUDIO_BITRATE_BPS,
  SCREEN_AUDIO_CAPTURE,
  decodeCaps,
  publishDefaults,
} from '../src/audio/presets';

describe('publish presets', () => {
  it('the mic is 64 kbit/s, DTX, no RED, mono — every value explicit (DEV-08)', () => {
    // forceStereo and dtx are passed explicitly: a MediaStreamAudioDestinationNode track defaults to
    // two channels, which livekit-client would otherwise classify as stereo (DTX off, stereo=1).
    expect(MIC).toEqual({
      source: Track.Source.Microphone,
      audioPreset: { maxBitrate: 64_000, priority: 'high' },
      dtx: true,
      red: false,
      forceStereo: false,
    });
    expect(MIC_BITRATE_BPS).toBe(64_000);
  });

  it('screen audio is 96 kbit/s stereo without DTX or RED (F2)', () => {
    expect(SCREEN_AUDIO).toEqual({
      source: Track.Source.ScreenShareAudio,
      audioPreset: { maxBitrate: 96_000 },
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
