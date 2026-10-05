import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DillaHttpError } from '../http/errors';
import { decodeFrame, encodeFrame, Op, type Frame } from './frames';
import { CLIENT_CLOSE, GATEWAY, Gateway, type GatewayDeps, type GatewayEvent } from './gateway';

const INSTANCE = new Uint8Array(16).fill(0x01);
const DEVICE = new Uint8Array(16).fill(0x08);
const USER = new Uint8Array(16).fill(0x09);
const GROUP = new Uint8Array(16).fill(0x07);

function hello(over: { wire?: number[]; heartbeatMs?: number; maxFrameBytes?: number } = {}): Uint8Array {
  return encodeFrame(Op.hello, 0, null, [over.wire ?? [1], [1], [1], over.heartbeatMs ?? 30000,
    over.maxFrameBytes ?? 131584, INSTANCE, 1, 300, 300]);
}

function ready(): Uint8Array {
  return encodeFrame(Op.ready, 1, null, [DEVICE, USER, 7, new Uint8Array(32).fill(0x0b), 1, 1, 1, 32, [[GROUP, 6, 4127, 2]]]);
}

/** A manual clock: timers run only inside advance(), in deadline order, ties in creation order. */
class FakeClock {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  readonly setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  readonly clearTimeout = (id: number): void => {
    this.timers.delete(id);
  };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= end && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
  /** Delays of the pending timers from now, ascending. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }
}

type Listener = (event: unknown) => void;

/** A WebSocket double with the browser's close-code rule. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readonly protocols: string[];
  binaryType = 'blob';
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string, protocols: string | string[]) {
    this.url = url;
    this.protocols = typeof protocols === 'string' ? [protocols] : [...protocols];
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  send(data: Uint8Array | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data instanceof Uint8Array ? data.slice() : new Uint8Array(data));
  }
  close(code?: number, reason = ''): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException(`close code ${code} is not allowed`, 'InvalidAccessError');
    }
    if (this.readyState === 3) return;
    this.closedWith = { code: code ?? 1005, reason };
    this.readyState = 3;
    this.emit('close', { code: code ?? 1005, reason, wasClean: true });
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  receive(data: Uint8Array | string): void {
    this.emit('message', { data: typeof data === 'string' ? data : data.slice().buffer });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.emit('close', { code, reason: '', wasClean: true });
  }
  sentFrames(): Frame[] {
    return this.sent.map((b) => decodeFrame(b));
  }
  private emit(type: string, event: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function harness(opts: { random?: number; mint?: () => Promise<string> } = {}) {
  const clock = new FakeClock();
  const events: GatewayEvent[] = [];
  let minted = 0;
  const deps: GatewayDeps = {
    url: 'ws://127.0.0.1:8453/gateway',
    mintTicket: opts.mint ?? (() => {
      minted += 1;
      return Promise.resolve(`t${minted}`);
    }),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    now: () => clock.now,
    random: () => opts.random ?? 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  const gw = new Gateway(deps);
  gw.subscribe((e) => events.push(e));
  const last = (): FakeSocket => {
    const s = FakeSocket.instances.at(-1);
    if (s === undefined) throw new Error('no socket was opened');
    return s;
  };
  return { gw, clock, events, last, minted: () => minted };
}

async function connected(h: ReturnType<typeof harness>, helloFrame = hello()): Promise<FakeSocket> {
  h.gw.start();
  await flush();
  const s = h.last();
  s.open();
  s.receive(helloFrame);
  s.receive(ready());
  return s;
}

const statuses = (events: GatewayEvent[]) =>
  events.flatMap((e) => (e.type === 'status' ? [`${e.status}:${String(e.closeCode)}`] : []));

beforeEach(() => {
  FakeSocket.instances = [];
});

describe('Gateway connect', () => {
  it('pins the timing constants', () => {
    expect(GATEWAY).toEqual({ heartbeatMaxMs: 15000, ackTimeoutMs: 10000, helloTimeoutMs: 15000,
      reconnectBaseMs: 500, reconnectCapMs: 30000, reconnectJitterMs: 500 });
    expect(CLIENT_CLOSE).toEqual({ normal: 1000, version: 4006, helloTimeout: 4100, heartbeatTimeout: 4101,
      undecodable: 4102, tooLarge: 4109 });
  });

  it('offers dilla.v1 and the ticket as subprotocols and reads binary frames', async () => {
    const h = harness();
    h.gw.start();
    expect(h.gw.status).toBe('connecting');
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    const s = h.last();
    expect(s.url).toBe('ws://127.0.0.1:8453/gateway');
    expect(s.protocols).toEqual(['dilla.v1', 'dilla.ticket.t1']);
    expect(s.binaryType).toBe('arraybuffer');
    expect(h.events[0]).toEqual({ type: 'status', status: 'connecting', closeCode: null });
  });

  it('answers hello with a fresh identify and reports ready', async () => {
    const h = harness();
    h.gw.start();
    await flush();
    const s = h.last();
    s.open();
    expect(s.sent).toHaveLength(0);
    s.receive(hello());
    expect(s.sent).toEqual([encodeFrame(Op.identify, 1, null, ['', 1, 1, 1, 0])]);
    s.receive(ready());
    expect(h.gw.status).toBe('ready');
    expect(h.events.find((e) => e.type === 'ready')).toEqual({
      type: 'ready',
      info: {
        deviceId: DEVICE, userId: USER, generation: 7n, keypackagesRemaining: 32,
        groups: [{ groupId: GROUP, epoch: 6n, lastSeq: 4127n, proposalsOutstanding: 2 }],
        heartbeatMs: 30000, maxFrameBytes: 131584, backoffMs: 300, backoffJitterMs: 300,
      },
    });
    expect(statuses(h.events)).toEqual(['connecting:null', 'ready:null']);
  });

  it('refuses a hello without version 1 and stays down', async () => {
    const h = harness();
    h.gw.start();
    await flush();
    const s = h.last();
    s.open();
    s.receive(hello({ wire: [2] }));
    expect(s.closedWith?.code).toBe(4006);
    expect(s.sent).toHaveLength(0);
    expect(h.gw.status).toBe('idle');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle', closeCode: 4006 });
    expect(h.clock.pending()).toEqual([]);
    h.clock.advance(600_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.minted()).toBe(1);
  });

  it('gives up on a socket that sends no hello, and on one that sends no ready', async () => {
    const h = harness();
    h.gw.start();
    await flush();
    const first = h.last();
    first.open();
    h.clock.advance(14_999);
    expect(first.closedWith).toBeNull();
    h.clock.advance(1);
    expect(first.closedWith?.code).toBe(CLIENT_CLOSE.helloTimeout);
    expect(h.gw.status).toBe('waiting');
    h.clock.advance(h.clock.pending()[0] ?? 0);
    await flush();
    const second = h.last();
    second.open();
    second.receive(hello());
    h.clock.advance(15_000);
    expect(second.closedWith?.code).toBe(CLIENT_CLOSE.helloTimeout);
  });
});

describe('Gateway heartbeat', () => {
  it('beats every min(heartbeat_ms / 2, 15 s) with the highest n seen', async () => {
    const h = harness();
    const s = await connected(h);
    const beats = () => s.sentFrames().filter((f) => f.op === Op.heartbeat);
    h.clock.advance(14_999);
    expect(beats()).toHaveLength(0);
    h.clock.advance(1);
    expect(beats()).toEqual([{ op: Op.heartbeat, n: 0n, groupId: null, payload: [1n, 1n] }]);
    s.receive(encodeFrame(Op.heartbeatAck, 0, null, [1_700_000_000]));
    s.receive(encodeFrame(Op.messageCt, 5, GROUP, [9, 6, DEVICE, new Uint8Array([1]), new Uint8Array(32), 1_700_000_000]));
    h.clock.advance(15_000);
    expect(beats()[1]?.payload).toEqual([5n, 1n]);
  });

  it('uses half of a short heartbeat_ms', async () => {
    const h = harness();
    const s = await connected(h, hello({ heartbeatMs: 10_000 }));
    h.clock.advance(4_999);
    expect(s.sentFrames().filter((f) => f.op === Op.heartbeat)).toHaveLength(0);
    h.clock.advance(1);
    expect(s.sentFrames().filter((f) => f.op === Op.heartbeat)).toHaveLength(1);
  });

  it('keeps a socket whose beats are acknowledged', async () => {
    const h = harness();
    const s = await connected(h);
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(15_000);
      s.receive(encodeFrame(Op.heartbeatAck, 0, null, [1_700_000_000 + i]));
    }
    expect(s.closedWith).toBeNull();
    expect(h.gw.status).toBe('ready');
  });

  it('closes a socket whose beat is not acknowledged within 10 s', async () => {
    const h = harness();
    const s = await connected(h);
    h.clock.advance(15_000);
    h.clock.advance(9_999);
    expect(s.closedWith).toBeNull();
    h.clock.advance(1);
    expect(s.closedWith?.code).toBe(CLIENT_CLOSE.heartbeatTimeout);
    expect(h.gw.status).toBe('waiting');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: CLIENT_CLOSE.heartbeatTimeout });
    expect(h.clock.pending()).toEqual([500]);
  });

  it('closes at the first unanswered beat deadline when beats are 5 s apart', async () => {
    const h = harness();
    const s = await connected(h, hello({ heartbeatMs: 10_000 }));
    h.clock.advance(14_999);
    expect(s.sentFrames().filter((f) => f.op === Op.heartbeat)).toHaveLength(2);
    expect(s.closedWith).toBeNull();
    h.clock.advance(1);
    expect(s.closedWith?.code).toBe(CLIENT_CLOSE.heartbeatTimeout);
    expect(h.gw.status).toBe('waiting');
  });
});

describe('Gateway input checks', () => {
  it('closes on a frame larger than max_frame_bytes, and accepts one of exactly that size', async () => {
    const big = encodeFrame(Op.messageCt, 2, GROUP, [9, 6, DEVICE, new Uint8Array(200), new Uint8Array(32), 1]);
    const h1 = harness();
    const s1 = await connected(h1, hello({ maxFrameBytes: big.length }));
    s1.receive(big);
    expect(s1.closedWith).toBeNull();
    FakeSocket.instances = [];
    const h2 = harness();
    const s2 = await connected(h2, hello({ maxFrameBytes: big.length - 1 }));
    s2.receive(big);
    expect(s2.closedWith?.code).toBe(CLIENT_CLOSE.tooLarge);
    expect(h2.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: CLIENT_CLOSE.tooLarge });
    expect(h2.clock.pending()).toEqual([500]);
  });

  it('closes on undecodable bytes and on a text frame', async () => {
    const h1 = harness();
    const s1 = await connected(h1);
    s1.receive(new Uint8Array([0xa1, 0x00, 0xf6]));
    expect(s1.closedWith?.code).toBe(CLIENT_CLOSE.undecodable);
    expect(h1.clock.pending()).toEqual([500]);
    FakeSocket.instances = [];
    const h2 = harness();
    const s2 = await connected(h2);
    s2.receive('{"op":0}');
    expect(s2.closedWith?.code).toBe(CLIENT_CLOSE.undecodable);
  });

  it('closes when the first frame is not hello', async () => {
    const h = harness();
    h.gw.start();
    await flush();
    const s = h.last();
    s.open();
    s.receive(ready());
    expect(s.closedWith?.code).toBe(CLIENT_CLOSE.undecodable);
  });

  it('emits ops 16 to 21 and nothing else', async () => {
    const h = harness();
    const s = await connected(h);
    const wanted = [
      encodeFrame(Op.handshake, 2, GROUP, [10, 6, 1, 3, new Uint8Array([0xde])]),
      encodeFrame(Op.commitNeeded, 0, GROUP, [6, [new Uint8Array(32)], 2000, 1]),
      encodeFrame(Op.epochChanged, 3, GROUP, [7, 10]),
      encodeFrame(Op.messageCt, 4, GROUP, [11, 7, DEVICE, new Uint8Array([1]), new Uint8Array(32), 1_700_000_000]),
      encodeFrame(Op.welcome, 5, GROUP, [4, 7, 10, new Uint8Array([2]), new Uint8Array([3]), new Uint8Array(32)]),
      encodeFrame(Op.messageDeleted, 6, GROUP, [11, 1_700_000_100]),
    ];
    const ignored = [
      encodeFrame(32, 7, null, [GROUP, 1, USER, new Uint8Array(0), new Uint8Array(32), 0, 0]),
      encodeFrame(50, 0, null, [USER, DEVICE, GROUP, 1]),
      encodeFrame(Op.error, 0, null, [0, 'E_FRAME_SHAPE', 'x']),
      encodeFrame(63, 8, null, []),
    ];
    for (const f of [...wanted, ...ignored]) s.receive(f);
    const got = h.events.flatMap((e) => (e.type === 'frame' ? [e.frame] : []));
    expect(got).toEqual(wanted.map((b) => decodeFrame(b)));
    expect(h.gw.status).toBe('ready');
    expect(s.closedWith).toBeNull();
  });
});

describe('Gateway reconnect', () => {
  it('backs off 500 ms doubling to a 30 s cap, without jitter when random() is 0', async () => {
    const h = harness();
    const s = await connected(h);
    s.serverClose(1006);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: 1006 });
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const delay = h.clock.pending()[0] ?? -1;
      delays.push(delay);
      h.clock.advance(delay);
      await flush();
      h.last().serverClose(1006);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('adds random() * 500 ms of jitter', async () => {
    const h = harness({ random: 0.5 });
    const s = await connected(h);
    s.serverClose(1006);
    expect(h.clock.pending()).toEqual([750]);
  });

  it('resets the back-off on ready', async () => {
    const h = harness();
    h.gw.start();
    await flush();
    h.last().serverClose(1006);
    h.clock.advance(500);
    await flush();
    h.last().serverClose(1006);
    expect(h.clock.pending()).toEqual([1000]);
    h.clock.advance(1000);
    await flush();
    const s = h.last();
    s.open();
    s.receive(hello());
    s.receive(ready());
    s.serverClose(1006);
    expect(h.clock.pending()).toEqual([500]);
  });

  it('honours reconnect.after_ms and treats invalid_session as a reconnect', async () => {
    const h = harness();
    const s1 = await connected(h);
    s1.receive(encodeFrame(Op.reconnect, 0, null, ['going away', 2500]));
    expect(s1.closedWith?.code).toBe(1000);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: 1000 });
    expect(h.clock.pending()).toEqual([2500]);
    h.clock.advance(2500);
    await flush();
    const s2 = h.last();
    s2.open();
    s2.receive(hello());
    s2.receive(ready());
    s2.receive(encodeFrame(Op.invalidSession, 0, null, [0, 'unknown resume token']));
    expect(s2.closedWith?.code).toBe(1000);
    expect(h.clock.pending()).toEqual([500]);
  });

  it('treats a failed ticket mint as a failure and retries it', async () => {
    let calls = 0;
    const h = harness({
      mint: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(new Error('E_NETWORK')) : Promise.resolve('t');
      },
    });
    h.gw.start();
    await flush();
    expect(h.gw.status).toBe('waiting');
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: null });
    expect(h.clock.pending()).toEqual([500]);
    h.clock.advance(500);
    await flush();
    expect(h.clock.pending()).toEqual([1000]);
    h.clock.advance(1000);
    await flush();
    expect(calls).toBe(3);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.last().protocols).toEqual(['dilla.v1', 'dilla.ticket.t']);
  });

  it('never sends resume, subscribe or unsubscribe, and identifies afresh on every connect', async () => {
    const h = harness();
    const s1 = await connected(h);
    h.clock.advance(15_000);
    s1.serverClose(4010);
    h.clock.advance(h.clock.pending()[0] ?? 0);
    await flush();
    const s2 = h.last();
    s2.open();
    s2.receive(hello());
    s2.receive(ready());
    h.gw.commitAck(GROUP, 3n);
    const ops = [...s1.sentFrames(), ...s2.sentFrames()].map((f) => f.op);
    expect(ops).toEqual([Op.identify, Op.heartbeat, Op.identify, Op.commitAck]);
    expect(s2.sent[0]).toEqual(encodeFrame(Op.identify, 1, null, ['', 1, 1, 1, 0]));
    expect(s2.protocols).toEqual(['dilla.v1', 'dilla.ticket.t2']);
  });
});

describe('Gateway revocation and stop', () => {
  it('reports revoked on close 4004 and does not reconnect by itself', async () => {
    const h = harness();
    const s = await connected(h);
    s.serverClose(4004);
    expect(h.events.slice(-2)).toEqual([{ type: 'status', status: 'idle', closeCode: 4004 }, { type: 'revoked' }]);
    expect(h.gw.status).toBe('idle');
    expect(h.clock.pending()).toEqual([]);
    h.clock.advance(120_000);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.minted()).toBe(1);
    h.gw.start();
    await flush();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  /** A mint that succeeds until `refuseWith` is set, then rejects with a DillaHttpError of that status. */
  function refusingMint() {
    const m = { calls: 0, refuseWith: null as number | null };
    const mint = (): Promise<string> => {
      m.calls += 1;
      if (m.refuseWith === null) return Promise.resolve(`t${m.calls}`);
      return Promise.reject(new DillaHttpError({
        status: m.refuseWith, code: m.refuseWith === 401 ? 'E_UNAUTHENTICATED' : 'E_HTTP', detail: '', retryAfterMs: null, extra: [],
      }));
    };
    return { m, mint };
  }

  it('a revoked device with a dead socket reaches revoked', async () => {
    const { m, mint } = refusingMint();
    const h = harness({ mint });
    const s = await connected(h);
    expect(h.gw.status).toBe('ready');
    s.serverClose(1006);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'waiting', closeCode: 1006 });
    expect(h.clock.pending()).toEqual([500]);
    m.refuseWith = 401;
    const seen = h.events.length;
    h.clock.advance(500);
    await flush();
    expect(h.events.slice(seen)).toEqual([
      { type: 'status', status: 'connecting', closeCode: null },
      { type: 'status', status: 'idle', closeCode: null },
      { type: 'revoked' },
    ]);
    expect(h.gw.status).toBe('idle');
    expect(m.calls).toBe(2);
    expect(h.clock.pending()).toEqual([]);
    h.clock.advance(120_000);
    await flush();
    expect(m.calls).toBe(2);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('a mint that fails for another reason is retried', async () => {
    const { m, mint } = refusingMint();
    const h = harness({ mint });
    const s = await connected(h);
    s.serverClose(1006);
    m.refuseWith = 503;
    const seen = h.events.length;
    h.clock.advance(500);
    await flush();
    expect(h.events.slice(seen)).toEqual([
      { type: 'status', status: 'connecting', closeCode: null },
      { type: 'status', status: 'waiting', closeCode: null },
    ]);
    expect(h.gw.status).toBe('waiting');
    expect(h.events.some((e) => e.type === 'revoked')).toBe(false);
    expect(m.calls).toBe(2);
    expect(h.clock.pending()).toEqual([1000]);
    h.clock.advance(1000);
    await flush();
    expect(m.calls).toBe(3);
  });

  it('stop closes with 1000, cancels every timer and reports idle', async () => {
    const h = harness();
    const s = await connected(h);
    h.gw.stop();
    expect(s.closedWith?.code).toBe(1000);
    expect(h.gw.status).toBe('idle');
    expect(h.clock.pending()).toEqual([]);
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle', closeCode: null });
    h.gw.stop();
    expect(statuses(h.events).filter((x) => x === 'idle:null')).toHaveLength(1);
  });

  it('opens no socket for a ticket that arrives after stop', async () => {
    let release: (ticket: string) => void = () => undefined;
    const h = harness({ mint: () => new Promise<string>((resolve) => { release = resolve; }) });
    h.gw.start();
    h.gw.stop();
    release('late');
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(h.gw.status).toBe('idle');
  });

  it('drops commitAck unless ready', async () => {
    const h = harness();
    h.gw.commitAck(GROUP, 1n);
    h.gw.start();
    await flush();
    const s = h.last();
    s.open();
    s.receive(hello());
    h.gw.commitAck(GROUP, 2n);
    expect(s.sentFrames().map((f) => f.op)).toEqual([Op.identify]);
    s.receive(ready());
    h.gw.commitAck(GROUP, 9n);
    expect(s.sent.at(-1)).toEqual(encodeFrame(Op.commitAck, 0, GROUP, [9n]));
  });

  it('keeps running when a listener throws, and rethrows the error from a microtask', async () => {
    const deferred: (() => void)[] = [];
    const spy = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb: () => void) => {
      deferred.push(cb);
    });
    try {
      const h = harness();
      h.gw.subscribe(() => {
        throw new Error('listener failed');
      });
      const s = await connected(h);
      expect(h.gw.status).toBe('ready');
      expect(s.closedWith).toBeNull();
      expect(h.events.map((e) => e.type)).toEqual(['status', 'status', 'ready']);
      expect(deferred.length).toBe(3);
      expect(() => deferred[0]?.()).toThrow('listener failed');
    } finally {
      spy.mockRestore();
    }
  });
});
