import {
  ScreenSharePresets,
  Track,
  type AudioCaptureOptions,
  type TrackPublishDefaults,
  type TrackPublishOptions,
} from 'livekit-client';

/** The mic's Opus target (spec "Opus 48 kHz, 20 ms, DTX, FEC, 64 kbps"; livekit-client's default is 48 000). */
export const MIC_BITRATE_BPS = 64_000;
/** Ruling F2: screen-share audio is 96 000 bit/s. */
export const SCREEN_AUDIO_BITRATE_BPS = 96_000;

/**
 * Every field explicit (DEV-08, G40 e). `forceStereo: false` and `dtx: true` matter most: once the
 * RNNoise processor is attached, `mediaStreamTrack` is the processed track. SP-09 measured that
 * Chromium's source channel count can determine stereo despite `forceStereo: false`; these publish
 * values still express the intended mic preset.
 */
export const MIC: TrackPublishOptions = {
  source: Track.Source.Microphone,
  dtx: true,
  red: false,
  forceStereo: false,
};

export const SCREEN_AUDIO: TrackPublishOptions = {
  source: Track.Source.ScreenShareAudio,
  forceStereo: true,
  dtx: false,
  red: false,
};

/** Per-publish options must carry the instance cap because LiveKit merges them over room defaults. */
export function micOptions(caps: CallCaps): TrackPublishOptions {
  return { ...MIC, audioPreset: { maxBitrate: Math.min(MIC_BITRATE_BPS, caps.maxAudioBitrateBps), priority: 'high' } };
}

export function screenAudioOptions(caps: CallCaps): TrackPublishOptions {
  return { ...SCREEN_AUDIO, audioPreset: { maxBitrate: Math.min(SCREEN_AUDIO_BITRATE_BPS, caps.maxAudioBitrateBps) } };
}

/** Shared audio is content, not speech: no voice processing, both channels. */
export const SCREEN_AUDIO_CAPTURE: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};

/** The mic capture: the browser's own AEC/NS/AGC stay on; RNNoise runs after them. */
export const MIC_CAPTURE: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Element 5 of the calls response, decoded (MD-10). */
export interface CallCaps {
  maxAudioBitrateBps: number;
  maxShareBitrateBps: number;
  vp9: boolean;
}

function positiveInt(v: number, what: string): number {
  if (!Number.isSafeInteger(v) || v < 1) throw new Error(`E_BAD_OPTIONS: ${what} must be a positive integer, got ${v}`);
  return v;
}

export function decodeCaps(caps: [number, number, number]): CallCaps {
  const [audio, share, vp9] = caps;
  if (vp9 !== 0 && vp9 !== 1) throw new Error(`E_BAD_OPTIONS: caps vp9 must be 0 or 1, got ${vp9}`);
  return {
    maxAudioBitrateBps: positiveInt(audio, 'caps max_audio_bitrate_bps'),
    maxShareBitrateBps: positiveInt(share, 'caps max_share_bitrate_bps'),
    vp9: vp9 === 1,
  };
}

/**
 * The Room's `publishDefaults` under an instance's caps (DEV-26): the server cannot enforce a
 * bitrate, so the client applies `livekit.max_audio_bitrate_kbps` to the mic preset and
 * `livekit.max_share_bitrate_kbps` to the screen-share encoding, and never raises either preset.
 * `backupCodec: false` and `red: false` are what E2EE forces anyway (DEV-09); they are written so the
 * defaults read the same before and after `setE2EEEnabled(true)`.
 */
export function publishDefaults(caps: CallCaps): TrackPublishDefaults {
  const screen = ScreenSharePresets.h1080fps15.encoding;
  return {
    audioPreset: { maxBitrate: Math.min(MIC_BITRATE_BPS, caps.maxAudioBitrateBps), priority: 'high' },
    dtx: true,
    red: false,
    forceStereo: false,
    videoCodec: 'vp8',
    simulcast: true,
    backupCodec: false,
    screenShareEncoding: { ...screen, maxBitrate: Math.min(screen.maxBitrate, caps.maxShareBitrateBps) },
  };
}
