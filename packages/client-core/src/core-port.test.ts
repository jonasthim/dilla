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

const DSK = new Uint8Array(32).fill(0xd5);

describe('wrapCore web-2a', () => {
  it('reads phase 3 in identity', () => {
    expect(stub({ identity: () => encode([3, INST, null, DEV, '', 0]) }).port.identity())
      .toEqual({ phase: 3, instanceId: INST, userId: null, deviceId: DEV, username: '', listPublished: false });
  });

  it('passes a null community to group_create and group_join_external and into the expected groups', () => {
    const body = new Uint8Array([3]);
    const s = stub({ group_create: () => body, group_join_external: () => body, welcomes_apply: () => encode([]) });
    expect(s.port.groupCreate(G, null, CHAN, 1n, new Uint8Array(32))).toBe(body);
    expect(s.port.groupJoinExternal({ groupId: G, communityId: null, channelId: CHAN, policyVersion: 1n }, new Uint8Array([1]), new Uint8Array([2]))).toBe(body);
    s.port.welcomesApply(new Uint8Array([9]), [{ groupId: G, communityId: null, channelId: CHAN, policyVersion: 1n }]);
    expect(s.calls[0]?.args[1]).toBeNull();
    expect(s.calls[1]?.args[1]).toBeNull();
    expect(decode(s.calls[2]?.args[1] as Uint8Array)).toEqual([[G, null, CHAN, 1n]]);
  });

  it('reads one group row, and null for an unknown id', () => {
    expect(stub({ group_row: () => encode(null) }).port.groupRow(G)).toBeNull();
    const s = stub({ group_row: () => encode([G, 0, null, CHAN, 2, 4, 9, 0, 0]) });
    expect(s.port.groupRow(G)).toEqual({ groupId: G, kind: 0, communityId: null, targetId: CHAN, state: 2, epoch: 4n, nextSeq: 9n, proposalsPending: 0, pendingCommit: false });
    expect(s.calls).toEqual([{ method: 'group_row', args: [G] }]);
  });

  it('forwards markRead and reads activity', () => {
    const s = stub({ mark_read: () => undefined, activity: () => encode([[G, 3, 1, 12, 1_800_000_012, 9], [MSG, 0, 0, 0, 0, 4]]) });
    s.port.markRead(G, 12n, 1_800_000_100n);
    expect(s.calls[0]).toEqual({ method: 'mark_read', args: [G, 12n, 1_800_000_100n] });
    expect(s.port.activity()).toEqual([
      { groupId: G, unread: 3, mentions: 1, lastSeq: 12n, lastTs: 1_800_000_012n, lastReadSeq: 9n },
      { groupId: MSG, unread: 0, mentions: 0, lastSeq: 0n, lastTs: 0n, lastReadSeq: 4n },
    ]);
  });

  it('folds settings into a record and forwards puts and deletes', () => {
    const s = stub({
      settings: () => encode([['mute.channel.aa', '1'], ['notify.default', 'everything']]),
      setting_put: () => undefined, setting_delete: () => undefined,
    });
    expect(s.port.settings()).toEqual({ 'mute.channel.aa': '1', 'notify.default': 'everything' });
    s.port.settingPut('notify.default', 'nothing');
    s.port.settingDelete('mute.channel.aa');
    expect(s.calls.slice(1)).toEqual([
      { method: 'setting_put', args: ['notify.default', 'nothing'] },
      { method: 'setting_delete', args: ['mute.channel.aa'] },
    ]);
  });

  it('reads the three sealed objects and forwards stateSealedUploaded', () => {
    const root = new Uint8Array(103).fill(1);
    const state = new Uint8Array(40).fill(2);
    expect(stub({ sealed_objects: () => encode([root, state, 1]) }).port.sealedObjects()).toEqual({ root, state, stateUploaded: true });
    expect(stub({ sealed_objects: () => encode([null, null, 0]) }).port.sealedObjects()).toEqual({ root: null, state: null, stateUploaded: false });
    const s = stub({ state_sealed_uploaded: () => undefined });
    s.port.stateSealedUploaded();
    expect(s.calls).toEqual([{ method: 'state_sealed_uploaded', args: [] }]);
  });

  it('walks the enrolment exports in the facade argument order', () => {
    const body = new Uint8Array([0x85, 1]);
    const s = stub({
      enrol_begin: () => encode([DEV, DSK]), enrol_session_sign: () => body, enrol_registered: () => undefined,
      enrol_complete: () => encode([new Uint8Array([4]), new Uint8Array([5])]), enrol_reset: () => undefined,
    });
    expect(s.port.enrolBegin(INST)).toEqual({ deviceId: DEV, dskPub: DSK });
    const nonce = new Uint8Array(32).fill(9);
    const login = new TextEncoder().encode('asrt-1');
    expect(s.port.enrolSessionSign(nonce, login)).toBe(body);
    s.port.enrolRegistered(USER);
    const input = { recoveryKey: 'abcd-efgh', rootSealed: new Uint8Array([1]), stateSealed: new Uint8Array([2]), listBody: new Uint8Array([3]), username: 'ada', now: 1_800_000_000n };
    expect(s.port.enrolComplete(input)).toEqual({ deviceListBody: new Uint8Array([4]), stateSealed: new Uint8Array([5]) });
    s.port.enrolReset();
    expect(s.calls).toEqual([
      { method: 'enrol_begin', args: [INST] },
      { method: 'enrol_session_sign', args: [nonce, login] },
      { method: 'enrol_registered', args: [USER] },
      { method: 'enrol_complete', args: ['abcd-efgh', input.rootSealed, input.stateSealed, input.listBody, 'ada', 1_800_000_000n] },
      { method: 'enrol_reset', args: [] },
    ]);
  });

  it('concatenates the device ids of a revocation and refuses a malformed list before the call', () => {
    const s = stub({ device_list_revoke: () => encode([new Uint8Array([6]), new Uint8Array([7])]) });
    const a = new Uint8Array(16).fill(0x0a);
    const b = new Uint8Array(16).fill(0x0b);
    const input = { recoveryKey: 'K', rootSealed: new Uint8Array([1]), stateSealed: new Uint8Array([2]), listBody: new Uint8Array([3]), deviceIds: [a, b], now: 9n };
    expect(s.port.deviceListRevoke(input)).toEqual({ deviceListBody: new Uint8Array([6]), stateSealed: new Uint8Array([7]) });
    const ids = new Uint8Array(32);
    ids.set(a, 0);
    ids.set(b, 16);
    expect(s.calls[0]).toEqual({ method: 'device_list_revoke', args: ['K', input.rootSealed, input.stateSealed, input.listBody, ids, 9n] });
    expect(caught(() => s.port.deviceListRevoke({ ...input, deviceIds: [a, new Uint8Array(15)] })).code).toBe('E_CORE_INPUT');
    expect(caught(() => s.port.deviceListRevoke({ ...input, deviceIds: [] })).code).toBe('E_CORE_INPUT');
    expect(caught(() => s.port.deviceListRevoke({ ...input, deviceIds: Array.from({ length: 65 }, () => a) })).code).toBe('E_CORE_INPUT');
    expect(s.calls).toHaveLength(1);
  });

  it('reads the own device list and the result of an update', () => {
    const OTHER = new Uint8Array(16).fill(0x0c);
    const s = stub({
      own_device_list: () => encode([3, 0, [[DEV, DSK, 1, 1_800_000_000, null], [OTHER, DSK, 0, 1_799_000_000, 1_800_000_500]]]),
      own_device_list_update: () => encode([3, 1]),
    });
    expect(s.port.ownDeviceList()).toEqual({ version: 3n, published: false, entries: [
      { deviceId: DEV, dskPub: DSK, tier: 1, addedAt: 1_800_000_000n, revokedAt: null },
      { deviceId: OTHER, dskPub: DSK, tier: 0, addedAt: 1_799_000_000n, revokedAt: 1_800_000_500n },
    ] });
    const history = encode([]);
    expect(s.port.ownDeviceListUpdate(history)).toEqual({ version: 3n, listed: true });
    expect(s.calls[1]).toEqual({ method: 'own_device_list_update', args: [history] });
  });

  it('maps a web-2a result of the wrong shape to E_CORE_DECODE', () => {
    expect(caught(() => stub({ activity: () => encode([[G, 1, 0, 1, 1]]) }).port.activity()).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ sealed_objects: () => encode([null, null, 2]) }).port.sealedObjects()).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ own_device_list_update: () => encode([1]) }).port.ownDeviceListUpdate(new Uint8Array([0x80]))).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ identity: () => encode([4, null, null, null, '', 0]) }).port.identity()).code).toBe('E_CORE_DECODE');
  });
});
