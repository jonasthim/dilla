import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent, SubscriptionError, type Room } from 'livekit-client';
import { VDEC_ATTRIBUTE, chooseVideoCodec, decodeListHas, localDecodeList, watchVideoCodec } from '../src/audio/codecs';
import type { CallCaps } from '../src/audio/presets';

type FakeParticipant = { identity: string; attributes: Record<string, string> };

function fakeRoom(participants: FakeParticipant[]): Room & EventEmitter {
  const room = new EventEmitter() as EventEmitter & { remoteParticipants: Map<string, FakeParticipant> };
  room.remoteParticipants = new Map(participants.map((p) => [p.identity, p]));
  return room as unknown as Room & EventEmitter;
}

const ON: CallCaps = { maxAudioBitrateBps: 64_000, maxShareBitrateBps: 2_500_000, vp9: true };
const OFF: CallCaps = { ...ON, vp9: false };
const yes = () => true;
const no = () => false;

describe('localDecodeList', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists vp8, h264 and vp9 in that order from the receiver capabilities', () => {
    vi.stubGlobal('RTCRtpReceiver', {
      getCapabilities: () => ({
        codecs: [{ mimeType: 'video/VP9' }, { mimeType: 'video/H264' }, { mimeType: 'video/rtx' }, { mimeType: 'video/VP8' }, { mimeType: 'video/AV1' }],
        headerExtensions: [],
      }),
    });
    expect(localDecodeList()).toBe('vp8,h264,vp9');
  });

  it('leaves out what the browser cannot decode', () => {
    vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }, { mimeType: 'video/H264' }], headerExtensions: [] }) });
    expect(localDecodeList()).toBe('vp8,h264');
  });

  it('is empty without WebRTC', () => {
    vi.stubGlobal('RTCRtpReceiver', undefined);
    expect(localDecodeList()).toBe('');
  });
});

describe('the VP9 publisher rule (DEV-07)', () => {
  it('decodeListHas reads the comma list exactly', () => {
    expect(decodeListHas('vp8,h264,vp9', 'vp9')).toBe(true);
    expect(decodeListHas('vp8,h264', 'vp9')).toBe(false);
    expect(decodeListHas(undefined, 'vp8')).toBe(false);
    expect(decodeListHas('vp8, vp9', 'vp9')).toBe(true);
  });

  // The truth table: instance flag × local encode × every remote decodes (a missing attribute is "no").
  const cases: Array<[string, CallCaps, () => boolean, FakeParticipant[], 'vp8' | 'vp9']> = [
    ['flag off', OFF, yes, [{ identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264,vp9' } }], 'vp8'],
    ['no local VP9 encoder', ON, no, [{ identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264,vp9' } }], 'vp8'],
    ['every remote decodes VP9', ON, yes, [
      { identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264,vp9' } },
      { identity: 'c', attributes: { [VDEC_ATTRIBUTE]: 'vp8,vp9' } },
    ], 'vp9'],
    ['one remote lacks VP9', ON, yes, [
      { identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264,vp9' } },
      { identity: 'c', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264' } },
    ], 'vp8'],
    ['one remote has no attribute', ON, yes, [
      { identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,h264,vp9' } },
      { identity: 'c', attributes: {} },
    ], 'vp8'],
    ['alone in the call', ON, yes, [], 'vp9'],
  ];
  for (const [name, caps, enc, remotes, want] of cases) {
    it(`${name} → ${want}`, () => {
      expect(chooseVideoCodec(fakeRoom(remotes), caps, enc)).toBe(want);
    });
  }

  it('a breaking join downgrades to VP8 once', () => {
    const room = fakeRoom([{ identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,vp9' } }]);
    const changes: string[] = [];
    const stop = watchVideoCodec(room, ON, (codec, why) => changes.push(`${codec}:${why}`), yes);
    const late: FakeParticipant = { identity: 'c', attributes: { [VDEC_ATTRIBUTE]: 'vp8' } };
    (room as unknown as { remoteParticipants: Map<string, FakeParticipant> }).remoteParticipants.set('c', late);
    room.emit(RoomEvent.ParticipantConnected, late);
    room.emit(RoomEvent.ParticipantConnected, late);
    expect(changes).toEqual(['vp8:join']);
    stop();
  });

  it('an attribute change that restores VP9 everywhere upgrades again', () => {
    const c: FakeParticipant = { identity: 'c', attributes: { [VDEC_ATTRIBUTE]: 'vp8' } };
    const room = fakeRoom([c]);
    const changes: string[] = [];
    const stop = watchVideoCodec(room, ON, (codec, why) => changes.push(`${codec}:${why}`), yes);
    c.attributes = { [VDEC_ATTRIBUTE]: 'vp8,vp9' };
    room.emit(RoomEvent.ParticipantAttributesChanged, { [VDEC_ATTRIBUTE]: 'vp8,vp9' }, c);
    expect(changes).toEqual(['vp9:attributes']);
    stop();
  });

  it('SE_CODEC_UNSUPPORTED from any subscriber forces VP8 even if every attribute says vp9 (backstop)', () => {
    const room = fakeRoom([{ identity: 'b', attributes: { [VDEC_ATTRIBUTE]: 'vp8,vp9' } }]);
    const changes: string[] = [];
    const stop = watchVideoCodec(room, ON, (codec, why) => changes.push(`${codec}:${why}`), yes);
    room.emit(RoomEvent.TrackSubscriptionFailed, 'TR_x', { identity: 'b' }, SubscriptionError.SE_CODEC_UNSUPPORTED);
    room.emit(RoomEvent.ParticipantAttributesChanged, {}, { identity: 'b' });
    expect(changes).toEqual(['vp8:subscription-failed']);
    stop();
  });
});
