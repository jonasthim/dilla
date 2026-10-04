/** Dilla's H.264 SFrame prefix requires Constrained Baseline and packetization mode 1. */
export function dillaVideoCodecs<T extends { mimeType: string; sdpFmtpLine?: string }>(codecs: T[]): T[] {
  return codecs.filter((codec) => {
    if (codec.mimeType.toLowerCase() !== 'video/h264') return true;
    const fmtp = codec.sdpFmtpLine?.toLowerCase() ?? '';
    return /(?:^|;)\s*packetization-mode=1(?:;|$)/.test(fmtp)
      && /(?:^|;)\s*profile-level-id=42e01f(?:;|$)/.test(fmtp);
  });
}

/** The SFU sends a broad H.264 offer; remove payloads this call must not negotiate. */
export function restrictH264Sdp(sdp: string): string {
  return sdp.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith('m=video ')) return section;
    const lines = section.split('\r\n');
    const removed = new Set<string>();
    const fmtp = new Map<string, string>();
    const codecs = new Map<string, string>();
    for (const line of lines) {
      const map = /^a=rtpmap:(\d+) ([^/]+)/.exec(line);
      if (map) codecs.set(map[1], map[2].toLowerCase());
      const f = /^a=fmtp:(\d+) (.*)/.exec(line);
      if (f) fmtp.set(f[1], f[2].toLowerCase());
    }
    for (const [pt, name] of codecs) {
      if (name === 'h264' && dillaVideoCodecs([{ mimeType: 'video/H264', sdpFmtpLine: fmtp.get(pt) }]).length === 0) removed.add(pt);
    }
    for (const [pt, name] of codecs) {
      if (name === 'rtx' && removed.has(/(?:^|;)\s*apt=(\d+)/.exec(fmtp.get(pt) ?? '')?.[1] ?? '')) removed.add(pt);
    }
    return lines.filter((line) => {
      const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/.exec(line)?.[1];
      return pt === undefined || !removed.has(pt);
    }).map((line) => {
      if (!line.startsWith('m=video ')) return line;
      const fields = line.split(' ');
      return fields.slice(0, 3).concat(fields.slice(3).filter((pt) => !removed.has(pt))).join(' ');
    }).join('\r\n');
  }).join('');
}

/** Install on the PeerConnections LiveKit constructs during this call, including reconnections. */
let activeCalls = 0;
let restoreConstructor: (() => void) | undefined;
export function installDillaCodecPreferences(): () => void {
  if (activeCalls > 0) {
    activeCalls++;
    let released = false;
    return () => { if (!released) { released = true; if (--activeCalls === 0) restoreConstructor?.(); } };
  }
  const Native = globalThis.RTCPeerConnection;
  class DillaPeerConnection extends Native {
    private preferVideo(): void {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs;
      if (!codecs) return;
      const preferred = dillaVideoCodecs(codecs);
      for (const tx of this.getTransceivers()) {
        if (tx.receiver.track.kind === 'video') tx.setCodecPreferences(preferred);
      }
    }
    override createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
    override createOffer(successCallback: RTCSessionDescriptionCallback, failureCallback: RTCPeerConnectionErrorCallback, options?: RTCOfferOptions): Promise<void>;
    override createOffer(arg?: RTCOfferOptions | RTCSessionDescriptionCallback, failure?: RTCPeerConnectionErrorCallback, options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit | void> {
      this.preferVideo();
      return typeof arg === 'function' ? super.createOffer(arg, failure!, options) : super.createOffer(arg);
    }
    override createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
    override createAnswer(successCallback: RTCSessionDescriptionCallback, failureCallback: RTCPeerConnectionErrorCallback): Promise<void>;
    override createAnswer(arg?: RTCAnswerOptions | RTCSessionDescriptionCallback, failure?: RTCPeerConnectionErrorCallback): Promise<RTCSessionDescriptionInit | void> {
      this.preferVideo();
      return typeof arg === 'function' ? super.createAnswer(arg as RTCSessionDescriptionCallback, failure!) : super.createAnswer(arg);
    }
    override async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      const safe = description.sdp === undefined ? description : { ...description, sdp: restrictH264Sdp(description.sdp) };
      return super.setRemoteDescription(safe);
    }
  }
  globalThis.RTCPeerConnection = DillaPeerConnection;
  activeCalls = 1;
  restoreConstructor = () => {
    if (globalThis.RTCPeerConnection === DillaPeerConnection) globalThis.RTCPeerConnection = Native;
    restoreConstructor = undefined;
  };
  let released = false;
  return () => { if (!released) { released = true; if (--activeCalls === 0) restoreConstructor?.(); } };
}
