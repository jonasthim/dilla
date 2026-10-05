// A BaseE2EEManager that attaches every transform at the two synchronous hooks the real manager
// will use (interfaces.md c.4): receivers inside EngineEvent.MediaTrackAdded, senders inside
// ParticipantEvent.LocalSenderCreated, with no await in between. It holds no keys; the stub worker
// runs whatever frame operation the spike asked for. It is not the real manager (task 17).
import {
  EncryptionEvent,
  EngineEvent,
  ParticipantEvent,
  RoomEvent,
  type BaseE2EEManager,
  type E2EEManagerCallbacks,
  type Track,
} from 'livekit-client';

type LkRoom = Parameters<BaseE2EEManager['setup']>[0];
type LkEngine = Parameters<BaseE2EEManager['setupEngine']>[0];
export type AttachPath = 'streams' | 'script';

interface Attachable { createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream }; transform: RTCRtpTransform | null }

export class StubE2EEManager implements BaseE2EEManager {
  isEnabled = false;
  private room?: LkRoom;
  private readonly engines = new WeakSet<object>();
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(private readonly worker: Worker, private readonly attach: AttachPath) {}

  get isDataChannelEncryptionEnabled(): boolean {
    return false;
  }

  set isDataChannelEncryptionEnabled(v: boolean) {
    if (v) throw new Error('stub: data-channel encryption is not supported; construct Room with e2ee:, not encryption:');
  }

  on<E extends keyof E2EEManagerCallbacks>(event: E, listener: E2EEManagerCallbacks[E]): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as unknown as (...args: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }

  private emit(event: EncryptionEvent, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  setup(room: LkRoom): void {
    this.room = room;
    room.localParticipant.on(ParticipantEvent.LocalSenderCreated, (sender: RTCRtpSender, track: Track) => {
      this.attachTo(sender, { side: 'encode', kind: track.kind === 'audio' ? 'audio' : 'video', participantIdentity: room.localParticipant.identity, trackId: track.mediaStreamID });
    });
    // setE2EEEnabled(true) before connect() reaches no manager (the local identity is still ''),
    // so the manager enables itself once signalling is up, as livekit-client's own does.
    room.on(RoomEvent.SignalConnected, () => this.setParticipantCryptorEnabled(true, room.localParticipant.identity));
  }

  setupEngine(engine: LkEngine): void {
    if (this.engines.has(engine)) return;
    this.engines.add(engine);
    engine.on(EngineEvent.MediaTrackAdded, (track: MediaStreamTrack, stream: MediaStream, receiver: RTCRtpReceiver) => {
      this.attachTo(receiver, { side: 'decode', kind: track.kind === 'audio' ? 'audio' : 'video', participantIdentity: stream.id, trackId: track.id });
    });
  }

  private attachTo(target: RTCRtpSender | RTCRtpReceiver, options: { side: 'encode' | 'decode'; kind: 'audio' | 'video'; participantIdentity: string; trackId: string }): void {
    const t = target as unknown as Attachable;
    if (this.attach === 'streams' && typeof t.createEncodedStreams === 'function') {
      const { readable, writable } = t.createEncodedStreams();
      this.worker.postMessage({ kind: 'attach', readable, writable, options }, [readable as unknown as Transferable, writable as unknown as Transferable]);
      return;
    }
    t.transform = new RTCRtpScriptTransform(this.worker, options);
  }

  setParticipantCryptorEnabled(enabled: boolean, participantIdentity: string): void {
    const local = this.room?.localParticipant;
    if (enabled && local && participantIdentity === local.identity && participantIdentity !== '' && !this.isEnabled) {
      this.isEnabled = true;
      this.emit(EncryptionEvent.ParticipantEncryptionStatusChanged, true, local);
    }
  }

  setSifTrailer(trailer: Uint8Array): void {
    if (trailer.length > 0) this.worker.postMessage({ kind: 'setSifTrailer', trailer: trailer.slice() });
  }

  async encryptData(): Promise<never> {
    throw new Error('stub: data encryption is not supported');
  }

  async handleEncryptedData(): Promise<never> {
    throw new Error('stub: data encryption is not supported');
  }

  dispose(): void {
    this.listeners.clear();
  }
}
