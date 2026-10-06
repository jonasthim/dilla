import { arr, bin, u53, u64, type CborValue } from '../cbor';
import { DillaHttpError } from '../http/errors';
import { encodeFrame, decodeFrame, Op, type Frame } from './frames';

export type GatewayStatus = 'idle' | 'connecting' | 'ready' | 'waiting';

export interface ReadyInfo {
  deviceId: Uint8Array;
  userId: Uint8Array;
  generation: bigint;
  keypackagesRemaining: number;
  groups: { groupId: Uint8Array; epoch: bigint; lastSeq: bigint; proposalsOutstanding: number }[];
  heartbeatMs: number;
  maxFrameBytes: number;
  backoffMs: number;
  backoffJitterMs: number;
}

export type GatewayEvent =
  | { type: 'status'; status: GatewayStatus; closeCode: number | null }
  | { type: 'ready'; info: ReadyInfo }
  | { type: 'frame'; frame: Frame }
  | { type: 'revoked' };

export interface GatewayDeps {
  url: string;
  mintTicket(): Promise<string>;
  WebSocket: typeof WebSocket;
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const GATEWAY = {
  heartbeatMaxMs: 15000, ackTimeoutMs: 10000, helloTimeoutMs: 15000,
  reconnectBaseMs: 500, reconnectCapMs: 30000, reconnectJitterMs: 500,
} as const;

export const CLIENT_CLOSE = {
  normal: 1000, version: 4006, helloTimeout: 4100, heartbeatTimeout: 4101,
  undecodable: 4102, tooLarge: 4109,
} as const;

const DEFAULT_MAX_FRAME_BYTES = 131584;
type TimerName = 'reconnectTimer' | 'handshakeTimer' | 'heartbeatTimer' | 'ackTimer';
type HelloInfo = Pick<ReadyInfo, 'heartbeatMs' | 'maxFrameBytes' | 'backoffMs' | 'backoffJitterMs'> & { versions: bigint[][] };

function readHello(payload: CborValue[]): HelloInfo {
  const p = arr(payload, 9);
  const versions = [arr(p[0]).map(u64), arr(p[1]).map(u64), arr(p[2]).map(u64)];
  const heartbeatMs = u53(p[3]);
  const maxFrameBytes = u53(p[4]);
  bin(p[5], 16);
  u64(p[6]);
  return { versions, heartbeatMs, maxFrameBytes, backoffMs: u53(p[7]), backoffJitterMs: u53(p[8]) };
}

function readReady(payload: CborValue[], hello: HelloInfo): ReadyInfo {
  const p = arr(payload, 9);
  const deviceId = bin(p[0], 16);
  const userId = bin(p[1], 16);
  const generation = u64(p[2]);
  bin(p[3], 32);
  u64(p[4]);
  u64(p[5]);
  u64(p[6]);
  const keypackagesRemaining = u53(p[7]);
  const groups = arr(p[8]).map((entry) => {
    const group = arr(entry, 4);
    return { groupId: bin(group[0], 16), epoch: u64(group[1]), lastSeq: u64(group[2]), proposalsOutstanding: u53(group[3]) };
  });
  return { deviceId, userId, generation, keypackagesRemaining, groups,
    heartbeatMs: hello.heartbeatMs, maxFrameBytes: hello.maxFrameBytes,
    backoffMs: hello.backoffMs, backoffJitterMs: hello.backoffJitterMs };
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly listeners = new Set<(e: GatewayEvent) => void>();
  private current: GatewayStatus = 'idle';
  private attempt = 0;
  private socket: WebSocket | null = null;
  private phase: 'minting' | 'hello' | 'ready-wait' | 'ready' = 'minting';
  private hello: HelloInfo | null = null;
  private lastN = 0n;
  private failures = 0;
  private afterMs = 0;
  private reconnectTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private ackTimer: number | null = null;

  constructor(deps: GatewayDeps) { this.deps = deps; }
  get status(): GatewayStatus { return this.current; }

  subscribe(listener: (e: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(e: GatewayEvent): void {
    for (const listener of this.listeners) {
      try { listener(e); }
      catch (err) { queueMicrotask(() => { throw err; }); }
    }
  }

  private setStatus(status: GatewayStatus, closeCode: number | null): void {
    this.current = status;
    this.emit({ type: 'status', status, closeCode });
  }

  private cancel(name: TimerName): void {
    const id = this[name];
    if (id !== null) this.deps.clearTimeout(id);
    this[name] = null;
  }

  private arm(name: TimerName, ms: number, fn: () => void): void {
    this.cancel(name);
    const id = this.attempt;
    const timer = this.deps.setTimeout(() => {
      if (this[name] !== timer || id !== this.attempt) return;
      this[name] = null;
      fn();
    }, ms);
    this[name] = timer;
  }

  start(): void {
    if (this.current !== 'idle') return;
    this.failures = 0;
    this.afterMs = 0;
    this.setStatus('connecting', null);
    this.connect();
  }

  private connect(): void {
    this.phase = 'minting';
    const id = ++this.attempt;
    // The mint is the first step of the handshake and is bounded like the others: a ticket request stalled
    // on a dead connection fails the attempt (the late ticket is then ignored by the attempt check).
    this.arm('handshakeTimer', GATEWAY.helloTimeoutMs, () => { this.fail(null); });
    void this.open(id);
  }

  private async open(id: number): Promise<void> {
    let ticket: string;
    try { ticket = await this.deps.mintTicket(); }
    catch (err) {
      if (id !== this.attempt) return;
      if (err instanceof DillaHttpError && err.status === 401) {
        this.goIdle();
        this.setStatus('idle', null);
        this.emit({ type: 'revoked' });
        return;
      }
      this.fail(null);
      return;
    }
    if (id !== this.attempt) return;
    let ws: WebSocket;
    try { ws = new this.deps.WebSocket(this.deps.url, ['dilla.v1', `dilla.ticket.${ticket}`]); }
    catch { this.fail(null); return; }
    this.socket = ws;
    ws.binaryType = 'arraybuffer';
    this.lastN = 0n;
    this.hello = null;
    this.phase = 'hello';
    ws.addEventListener('message', (event) => { if (id === this.attempt) this.onMessage(event); });
    ws.addEventListener('close', (event) => { if (id === this.attempt) this.onClose(event); });
    ws.addEventListener('error', () => { /* A close follows in a browser. */ });
    this.arm('handshakeTimer', GATEWAY.helloTimeoutMs, () => this.teardown(CLIENT_CLOSE.helloTimeout, true));
  }

  private onMessage(event: MessageEvent): void {
    if (!(event.data instanceof ArrayBuffer)) { this.teardown(CLIENT_CLOSE.undecodable, true); return; }
    if (event.data.byteLength > (this.hello?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)) {
      this.teardown(CLIENT_CLOSE.tooLarge, true);
      return;
    }
    let frame: Frame;
    try { frame = decodeFrame(new Uint8Array(event.data)); }
    catch { this.teardown(CLIENT_CLOSE.undecodable, true); return; }
    if (frame.n > this.lastN) this.lastN = frame.n;
    if (this.phase === 'hello') {
      if (frame.op !== Op.hello) { this.teardown(CLIENT_CLOSE.undecodable, true); return; }
      let hello: HelloInfo;
      try { hello = readHello(frame.payload); }
      catch { this.teardown(CLIENT_CLOSE.undecodable, true); return; }
      if (hello.versions.some((versions) => !versions.includes(1n))) {
        this.teardown(CLIENT_CLOSE.version, false);
        this.setStatus('idle', CLIENT_CLOSE.version);
        return;
      }
      this.hello = hello;
      this.send(encodeFrame(Op.identify, 1, null, ['', 1, 1, 1, 0]));
      this.phase = 'ready-wait';
      this.arm('handshakeTimer', GATEWAY.helloTimeoutMs, () => this.teardown(CLIENT_CLOSE.helloTimeout, true));
      return;
    }
    if (this.phase === 'ready-wait') {
      if (frame.op === Op.ready) {
        let info: ReadyInfo;
        try { info = readReady(frame.payload, this.hello!); }
        catch { this.teardown(CLIENT_CLOSE.undecodable, true); return; }
        this.cancel('handshakeTimer');
        this.failures = 0;
        this.phase = 'ready';
        this.setStatus('ready', null);
        this.emit({ type: 'ready', info });
        this.scheduleBeat();
      } else if (frame.op === Op.invalidSession || frame.op === Op.reconnect) this.reconnectFrame(frame);
      return;
    }
    if (this.phase === 'ready') {
      if (frame.op === Op.heartbeatAck) this.cancel('ackTimer');
      else if (frame.op >= Op.handshake && frame.op <= Op.messageDeleted) this.emit({ type: 'frame', frame });
      else if (frame.op === Op.invalidSession || frame.op === Op.reconnect) this.reconnectFrame(frame);
    }
  }

  private reconnectFrame(frame: Frame): void {
    if (frame.op === Op.reconnect) {
      try { this.afterMs = u53(frame.payload[1]); }
      catch { this.afterMs = 0; }
    } else this.afterMs = 0;
    this.teardown(CLIENT_CLOSE.normal, true);
  }

  private scheduleBeat(): void {
    if (this.current !== 'ready' || this.hello === null) return;
    const interval = Math.min(Math.floor(this.hello.heartbeatMs / 2), GATEWAY.heartbeatMaxMs);
    this.arm('heartbeatTimer', interval, () => {
      this.send(encodeFrame(Op.heartbeat, 0, null, [this.lastN, 1]));
      if (this.ackTimer === null) {
        this.arm('ackTimer', GATEWAY.ackTimeoutMs, () => this.teardown(CLIENT_CLOSE.heartbeatTimeout, true));
      }
      this.scheduleBeat();
    });
  }

  private send(bytes: Uint8Array): void {
    if (this.socket?.readyState === 1) this.socket.send(bytes);
  }

  private onClose(event: CloseEvent): void {
    if (event.code === 4004) {
      this.goIdle();
      this.setStatus('idle', 4004);
      this.emit({ type: 'revoked' });
      return;
    }
    this.fail(event.code);
  }

  private teardown(code: number, reconnect: boolean): void {
    const ws = this.socket;
    this.attempt += 1;
    this.cancel('handshakeTimer');
    this.cancel('heartbeatTimer');
    this.cancel('ackTimer');
    this.socket = null;
    try { ws?.close(code); }
    catch { /* A socket can already be gone. */ }
    if (reconnect) this.fail(code);
  }

  private fail(closeCode: number | null): void {
    this.attempt += 1;
    this.cancel('handshakeTimer');
    this.cancel('heartbeatTimer');
    this.cancel('ackTimer');
    this.socket = null;
    this.setStatus('waiting', closeCode);
    const delay = Math.floor(Math.max(this.afterMs,
      Math.min(GATEWAY.reconnectCapMs, GATEWAY.reconnectBaseMs * 2 ** this.failures)
      + this.deps.random() * GATEWAY.reconnectJitterMs));
    this.failures += 1;
    this.afterMs = 0;
    this.arm('reconnectTimer', delay, () => { this.setStatus('connecting', null); this.connect(); });
  }

  private goIdle(): void {
    this.attempt += 1;
    this.cancel('reconnectTimer');
    this.cancel('handshakeTimer');
    this.cancel('heartbeatTimer');
    this.cancel('ackTimer');
    this.socket = null;
    this.phase = 'minting';
  }

  stop(): void {
    if (this.current === 'idle') return;
    this.teardown(CLIENT_CLOSE.normal, false);
    this.goIdle();
    this.setStatus('idle', null);
  }

  commitAck(groupId: Uint8Array, round: bigint): void {
    if (this.current === 'ready' && this.socket?.readyState === 1) {
      this.send(encodeFrame(Op.commitAck, 0, groupId, [round]));
    }
  }
}
