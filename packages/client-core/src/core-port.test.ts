import { describe, expect, it } from 'vitest';
import { decode, encode } from './cbor';
import { CoreError, wrapCore, type CoreHandle } from './core-port';
import { fromHex } from './hex';

const G = new Uint8Array(16).fill(0x67);
const COMM = new Uint8Array(16).fill(0xc1);
const CHAN = new Uint8Array(16).fill(0xc2);
const INST = new Uint8Array(16).fill(0xab);
const USER = new Uint8Array(16).fill(0xa2);
const DEV = new Uint8Array(16).fill(0xa1);
const MSG = new Uint8Array(16).fill(0x11);

type Impl = Partial<Record<keyof CoreHandle, (...args: never[]) => unknown>>;

function stub(impl: Impl) {
  const calls: { method: string; args: unknown[] }[] = [];
  const handle = new Proxy({}, {
    get(_target, prop) {
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        const f = impl[prop as keyof CoreHandle] as ((...a: unknown[]) => unknown) | undefined;
        if (f === undefined) throw new Error(`stub: ${String(prop)} is not stubbed`);
        return f(...args);
      };
    },
  }) as unknown as CoreHandle;
  return { port: wrapCore(handle), calls };
}

function caught(fn: () => unknown): CoreError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CoreError) return err;
    throw err;
  }
  throw new Error('nothing was thrown');
}

describe('wrapCore decoding', () => {
  it('reads identity in every phase', () => {
    expect(stub({ identity: () => encode([0, null, null, null, '', 0]) }).port.identity())
      .toEqual({ phase: 0, instanceId: null, userId: null, deviceId: null, username: '', listPublished: false });
    expect(stub({ identity: () => encode([2, INST, USER, DEV, 'ada', 1]) }).port.identity())
      .toEqual({ phase: 2, instanceId: INST, userId: USER, deviceId: DEV, username: 'ada', listPublished: true });
  });

  it('reads and writes the session record', () => {
    expect(stub({ session: () => encode(null) }).port.session()).toBeNull();
    expect(stub({ session: () => encode(['tok', 10, 5]) }).port.session()).toEqual({ token: 'tok', expires: 10n, idleExpires: 5n });
    const s = stub({ session_store: () => undefined });
    s.port.sessionStore({ token: 'tok', expires: 10n, idleExpires: 5n });
    expect(s.calls).toEqual([{ method: 'session_store', args: ['tok', 10n, 5n] }]);
  });

  it('reads groups', () => {
    const { port } = stub({ groups: () => encode([[G, 0, COMM, CHAN, 2, 7, 12, 1, 1], [MSG, 0, null, CHAN, 4, 0, 3, 0, 0]]) });
    expect(port.groups()).toEqual([
      { groupId: G, kind: 0, communityId: COMM, targetId: CHAN, state: 2, epoch: 7n, nextSeq: 12n, proposalsPending: 1, pendingCommit: true },
      { groupId: MSG, kind: 0, communityId: null, targetId: CHAN, state: 4, epoch: 0n, nextSeq: 3n, proposalsPending: 0, pendingCommit: false },
    ]);
  });

  it('reads apply results and both flag bits', () => {
    const s = stub({ group_apply: () => encode([2, 7, 12, [10, 11], 1, 3]), commit_confirm: () => encode([2, 8, 12, [], 0, 1]) });
    const h = new Uint8Array([1]);
    const m = new Uint8Array([2]);
    expect(s.port.groupApply(G, h, m, 9n)).toEqual({ state: 2, epoch: 7n, nextSeq: 12n, newSeqs: [10n, 11n], proposalsPending: 1, epochChanged: true, ownAdopted: true });
    expect(s.calls[0]).toEqual({ method: 'group_apply', args: [G, h, m, 9n] });
    expect(s.port.commitConfirm(G)).toEqual({ state: 2, epoch: 8n, nextSeq: 12n, newSeqs: [], proposalsPending: 0, epochChanged: true, ownAdopted: false });
  });

  it('reads the result of a deletion with the apply decoder', () => {
    // [2, 1, 3, [2], 0, 0]: state 2, epoch 1, next_seq 3, new_seqs [2], no proposals, no flags
    const s = stub({ message_deleted: () => fromHex('8602010381020000') });
    expect(s.port.messageDeleted(G, 2n)).toEqual({ state: 2, epoch: 1n, nextSeq: 3n, newSeqs: [2n], proposalsPending: 0, epochChanged: false, ownAdopted: false });
    expect(s.calls).toEqual([{ method: 'message_deleted', args: [G, 2n] }]);
  });

  it('passes the expected groups as CBOR and reads welcome outcomes', () => {
    const s = stub({ welcomes_apply: () => encode([[4, G, 0, ''], [5, MSG, 2, 'E_BINDING']]) });
    const out = s.port.welcomesApply(new Uint8Array([9]), [{ groupId: G, communityId: COMM, channelId: CHAN, policyVersion: 3n }]);
    expect(out).toEqual([
      { welcomeId: 4n, groupId: G, outcome: 0, reason: '' },
      { welcomeId: 5n, groupId: MSG, outcome: 2, reason: 'E_BINDING' },
    ]);
    expect(decode(s.calls[0]?.args[1] as Uint8Array)).toEqual([[G, COMM, CHAN, 3n]]);
  });

  it('forwards the external join in ledger order', () => {
    const body = new Uint8Array([7, 7]);
    const s = stub({ group_join_external: () => body });
    const info = new Uint8Array([1]);
    const tree = new Uint8Array([2]);
    expect(s.port.groupJoinExternal({ groupId: G, communityId: COMM, channelId: CHAN, policyVersion: 3n }, info, tree)).toBe(body);
    expect(s.calls[0]?.args).toEqual([G, COMM, CHAN, 3n, info, tree]);
  });

  it('reads the send results, the outbox and the timeline', () => {
    const { port } = stub({
      send_prepare: () => encode([MSG]),
      send_encrypt: () => encode([G, new Uint8Array([5, 6])]),
      send_confirm: () => encode([G, 42]),
      outbox: () => encode([[MSG, 2, 'E_TOO_LARGE', 1_700_000_000, 'hi']]),
      timeline: () => encode([
        [5, 7, 1_700_000_000, 0, '', USER, DEV, 0, 1, MSG, 0, 'hi'],
        [6, 7, 1_700_000_001, 1, 'E_PRUNED', null, DEV, null, null, null, null, ''],
      ]),
    });
    expect(port.sendPrepare(G, 'hi', 1n)).toEqual(MSG);
    expect(port.sendEncrypt(MSG)).toEqual({ groupId: G, messageBody: new Uint8Array([5, 6]) });
    expect(port.sendConfirm(MSG, new Uint8Array([1]))).toEqual({ groupId: G, seq: 42n });
    expect(port.outbox(G)).toEqual([{ msgId: MSG, state: 2, error: 'E_TOO_LARGE', created: 1_700_000_000n, body: 'hi' }]);
    expect(port.timeline(G, 0n, 100)).toEqual([
      { seq: 5n, epoch: 7n, recvTs: 1_700_000_000n, status: 0, reason: '', senderUser: USER, senderDevice: DEV, senderKind: 0, senderTier: 1, msgId: MSG, type: 0, body: 'hi' },
      { seq: 6n, epoch: 7n, recvTs: 1_700_000_001n, status: 1, reason: 'E_PRUNED', senderUser: null, senderDevice: DEV, senderKind: null, senderTier: null, msgId: null, type: null, body: '' },
    ]);
  });

  it('returns request bodies and cursor bodies unchanged, and null for a CBOR null cursor', () => {
    const req = new Uint8Array([0x88, 1]);
    const s = stub({ signup_request: () => req, cursor_body: () => encode(null) });
    expect(s.port.signupRequest('INV', 'ada', 'Ada', null)).toBe(req);
    expect(s.calls[0]?.args).toEqual(['INV', 'ada', 'Ada', null]);
    expect(s.port.cursorBody(G)).toBeNull();
    const cursor = encode([4, 2]);
    expect(stub({ cursor_body: () => cursor }).port.cursorBody(G)).toBe(cursor);
  });
});

describe('wrapCore errors', () => {
  it('turns "<code>: <detail>" into a CoreError', () => {
    const e = caught(() => stub({ identity: () => { throw new Error('E_CORE_STATE: signup pending'); } }).port.identity());
    expect([e.code, e.detail, e.message]).toEqual(['E_CORE_STATE', 'signup pending', 'E_CORE_STATE: signup pending']);
    const bare = caught(() => stub({ groups: () => { throw new Error('E_CORE_NOT_FOUND'); } }).port.groups());
    expect([bare.code, bare.detail, bare.message]).toEqual(['E_CORE_NOT_FOUND', '', 'E_CORE_NOT_FOUND']);
  });

  it('maps a glue or panic error to E_CORE_WASM', () => {
    const e = caught(() => stub({ session_clear: () => { throw new TypeError('null pointer passed to rust'); } }).port.sessionClear());
    expect([e.code, e.detail]).toEqual(['E_CORE_WASM', 'null pointer passed to rust']);
  });

  it('maps a result of the wrong shape to E_CORE_DECODE', () => {
    expect(caught(() => stub({ identity: () => encode([0]) }).port.identity()).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ identity: () => encode([7, null, null, null, '', 0]) }).port.identity()).code).toBe('E_CORE_DECODE');
  });

  it('keeps an existing CoreError', () => {
    const original = new CoreError('E_CORE_MLS', 'x');
    expect(CoreError.from(original)).toBe(original);
    expect(CoreError.from('boom')).toMatchObject({ code: 'E_CORE_WASM', detail: 'boom' });
  });
});
