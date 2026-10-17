/* eslint-disable @typescript-eslint/require-await -- the doubles answer as the async functions they stand for do */
import { describe, expect, it, vi } from 'vitest';
import { acquireMic, acquireCamera, acquireScreen } from './devices.ts';

const track = (kind: string) => ({ kind, stop: vi.fn(), id: `${kind}-1` }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) => ({
  getTracks: () => tracks,
  getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
}) as unknown as MediaStream;
const named = (name: string) => Object.assign(new Error(name), { name });
const mic = { kind: 'audioinput', deviceId: 'default', groupId: '', label: '' } as MediaDeviceInfo;

function media(gum: () => Promise<MediaStream>, devices: MediaDeviceInfo[] = [mic]) {
  return { getUserMedia: vi.fn(gum), enumerateDevices: vi.fn(async () => devices) };
}

describe('the microphone (flow 06: listen-only states)', () => {
  it('returns the track, asking for the chosen input with the browser AEC/NS/AGC on', async () => {
    const t = track('audio');
    const m = media(async () => stream(t));
    expect(await acquireMic(m, 'abc')).toEqual({ track: t });
    expect(m.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'abc' }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  });

  it('the system default asks for no device id', async () => {
    const m = media(async () => stream(track('audio')));
    await acquireMic(m, '');
    expect(m.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  });

  it('NotAllowedError is "denied"', async () => {
    expect(await acquireMic(media(async () => { throw named('NotAllowedError'); }), '')).toEqual({ mic: 'denied' });
  });

  it('NotFoundError, or no audioinput listed, is "missing" (and getUserMedia is not asked then)', async () => {
    expect(await acquireMic(media(async () => { throw named('NotFoundError'); }), '')).toEqual({ mic: 'missing' });
    const none = media(async () => stream(track('audio')), []);
    expect(await acquireMic(none, '')).toEqual({ mic: 'missing' });
    expect(none.getUserMedia).not.toHaveBeenCalled();
  });

  it('a chosen input that is gone falls back to the system default once', async () => {
    const t = track('audio');
    let first = true;
    const m = media(async () => { if (first) { first = false; throw named('OverconstrainedError'); } return stream(t); });
    expect(await acquireMic(m, 'gone')).toEqual({ track: t });
    expect(m.getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('a stream without an audio track stops what it got and is "missing"', async () => {
    const v = track('video');
    expect(await acquireMic(media(async () => stream(v)), '')).toEqual({ mic: 'missing' });
    expect((v as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
  });
});

describe('camera and screen', () => {
  it('the camera returns its video track', async () => {
    const v = track('video');
    const m = media(async () => stream(v));
    expect(await acquireCamera(m)).toBe(v);
    expect(m.getUserMedia).toHaveBeenCalledWith({ audio: false, video: true });
  });

  it('the screen asks for tab audio and returns both tracks', async () => {
    const v = track('video');
    const a = track('audio');
    const getDisplayMedia = vi.fn(async () => stream(v, a));
    expect(await acquireScreen({ getDisplayMedia })).toEqual({ video: v, audio: a });
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: SCREEN_AUDIO_EXPECTED });
  });

  it('a screen without audio returns audio null', async () => {
    const v = track('video');
    expect(await acquireScreen({ getDisplayMedia: async () => stream(v) })).toEqual({ video: v, audio: null });
  });
});

const SCREEN_AUDIO_EXPECTED = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };

// Privacy preference must reach capture, not only the neural processor.
it('Off disables browser suppression at acquisition while retaining echo cancellation', async () => {
  const calls: MediaStreamConstraints[] = [];
  const track = { stop() {} } as MediaStreamTrack;
  const media = { enumerateDevices: async () => [{kind:'audioinput'} as MediaDeviceInfo], getUserMedia: async (c:MediaStreamConstraints) => {calls.push(c); return {getAudioTracks:()=>[track],getTracks:()=>[track]} as MediaStream;} };
  await acquireMic(media, '', false);
  expect(calls[0]).toMatchObject({audio:{noiseSuppression:false,echoCancellation:true,autoGainControl:true}});
});
