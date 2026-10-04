import { expect, it, vi } from 'vitest';
import { dillaVideoCodecs, installDillaCodecPreferences, restrictH264Sdp } from '../src/codec-preferences';

it('keeps only Constrained Baseline H.264 mode 1 while preserving VP8 and RTX', () => {
  const caps = [
    { mimeType: 'video/VP8', clockRate: 90000 },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
    { mimeType: 'video/rtx', clockRate: 90000 },
  ];
  expect(dillaVideoCodecs(caps).map((c) => c.sdpFmtpLine ?? c.mimeType)).toEqual([
    'video/VP8', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', 'video/rtx',
  ]);
});

it('restores the native PeerConnection after overlapping dilla calls release out of order', () => {
  class Native {}
  vi.stubGlobal('RTCPeerConnection', Native);
  const releaseA = installDillaCodecPreferences();
  const releaseB = installDillaCodecPreferences();
  releaseA();
  releaseB();
  expect(globalThis.RTCPeerConnection).toBe(Native);
  vi.unstubAllGlobals();
});

it('removes mode 0 and other H.264 profiles from a server offer, including their RTX payloads', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 108 109 114 115\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\na=rtpmap:109 rtx/90000\r\na=fmtp:109 apt=108\r\na=rtpmap:114 H264/90000\r\na=fmtp:114 packetization-mode=0;profile-level-id=42e01f\r\na=rtpmap:115 rtx/90000\r\na=fmtp:115 apt=114\r\na=rtcp-fb:114 nack\r\n';
  const filtered = restrictH264Sdp(sdp);
  expect(filtered).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96 97 108 109');
  expect(filtered).not.toMatch(/(?:rtpmap|fmtp|rtcp-fb):11[45]/);
  expect(filtered).toContain('a=fmtp:108 packetization-mode=1;profile-level-id=42e01f');
});

it('keeps payload decisions local to each video media section', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=1;profile-level-id=42e01f\r\nm=video 9 UDP/TLS/RTP/SAVPF 108\r\na=rtpmap:108 H264/90000\r\na=fmtp:108 packetization-mode=0;profile-level-id=42e01f\r\n';
  const parts = restrictH264Sdp(sdp).split('m=video ');
  expect(parts[1]).toContain('108');
  expect(parts[1]).toContain('a=rtpmap:108 H264/90000');
  expect(parts[2]).not.toContain('a=rtpmap:108 H264/90000');
});
