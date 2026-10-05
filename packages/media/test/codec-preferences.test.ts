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

it('rejects AV1, H265, VP9 and VP9 profile 2 in local preferences', () => {
  expect(dillaVideoCodecs(['VP8', 'AV1', 'H265', 'VP9'].map((name) => ({ mimeType: `video/${name}` })))).toEqual([{ mimeType: 'video/VP8' }]);
});

it('preserves prototype description getters through an ICE rollback', async () => {
  class Description {
    get type() { return 'offer' as const; }
    get sdp() { return 'v=0\r\n'; }
  }
  class Native {
    received?: RTCSessionDescriptionInit;
    async setRemoteDescription(d: RTCSessionDescriptionInit) { this.received = d; }
  }
  vi.stubGlobal('RTCPeerConnection', Native);
  const release = installDillaCodecPreferences();
  try {
    const pc = new RTCPeerConnection() as unknown as Native;
    await pc.setRemoteDescription(new Description());
    expect(pc.received).toEqual({ type: 'offer', sdp: 'v=0\r\n' });
  } finally { release(); vi.unstubAllGlobals(); }
});

it('removes AV1, H265 and VP9 payloads and their RTX from a remote offer', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 AV1/90000\r\na=rtpmap:98 rtx/90000\r\na=fmtp:98 apt=97\r\na=rtpmap:99 H265/90000\r\na=rtpmap:100 VP9/90000\r\n';
  expect(restrictH264Sdp(sdp)).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96\r\n');
});

it('uses receiver capabilities on recvonly and survives a preference failure', async () => {
  const seen: string[][] = [];
  class Native {
    getTransceivers() { return [
      { direction: 'recvonly', currentDirection: 'recvonly', receiver: { track: { kind: 'video' } }, setCodecPreferences: (codecs: Array<{ mimeType: string }>) => { seen.push(codecs.map((c) => c.mimeType)); throw new Error('stopped'); } },
      { direction: 'sendonly', currentDirection: 'sendonly', receiver: { track: { kind: 'video' } }, setCodecPreferences: (codecs: Array<{ mimeType: string }>) => seen.push(codecs.map((c) => c.mimeType)) },
    ]; }
    async createOffer() { return { type: 'offer' as const, sdp: 'v=0' }; }
  }
  vi.stubGlobal('RTCPeerConnection', Native);
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8' }] }) });
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' }] }) });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const release = installDillaCodecPreferences();
  try {
    await expect(new RTCPeerConnection().createOffer()).resolves.toMatchObject({ type: 'offer' });
    expect(seen).toEqual([['video/VP8'], ['video/H264']]);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { release(); warn.mockRestore(); vi.unstubAllGlobals(); }
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
  expect(parts[2]).toContain('0 UDP/TLS/RTP/SAVPF 108\r\n');
  expect(parts[2]).toContain('a=inactive');
});

it('rejects an AV1-only video section with a parseable format and no playable direction', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 97\r\na=mid:1\r\na=sendrecv\r\na=rtpmap:97 AV1/90000\r\n';
  const filtered = restrictH264Sdp(sdp);
  expect(filtered).toContain('m=video 0 UDP/TLS/RTP/SAVPF 97\r\n');
  expect(filtered).toContain('a=inactive\r\n');
});

it('rejects a video section when only RTX and FEC refer to removed codecs', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 97 98 99 100\r\na=mid:1\r\na=rtpmap:97 AV1/90000\r\na=rtpmap:98 rtx/90000\r\na=fmtp:98 apt=97\r\na=rtpmap:99 red/90000\r\na=fmtp:99 apt=97\r\na=rtpmap:100 ulpfec/90000\r\na=fmtp:100 apt=97\r\n';
  const filtered = restrictH264Sdp(sdp);
  expect(filtered).toContain('m=video 0 UDP/TLS/RTP/SAVPF 97\r\n');
  expect(filtered).not.toContain('a=rtpmap:99');
  expect(filtered).not.toContain('a=rtpmap:100');
});

it('removes RTX and FEC with apt to AV1 even if VP8 remains playable', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:97 AV1/90000\r\na=rtpmap:98 rtx/90000\r\na=fmtp:98 apt=97\r\na=rtpmap:99 flexfec-03/90000\r\na=fmtp:99 apt=97\r\n';
  const filtered = restrictH264Sdp(sdp);
  expect(filtered).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96\r\n');
  expect(filtered).not.toContain('a=rtpmap:99');
});
