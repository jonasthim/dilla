import { describe, expect, it } from 'vitest';
import { decode, encode, type CborInput } from './cbor';
import { CoreError, wrapCore, type CoreHandle } from './core-port';
import { fromHex } from './hex';

const G = new Uint8Array(16).fill(0x67);
const COMM = new Uint8Array(16).fill(0xc1);
const CHAN = new Uint8Array(16).fill(0xc2);
const INST = new Uint8Array(16).fill(0xab);
const USER = new Uint8Array(16).fill(0xa2);
const DEV = new Uint8Array(16).fill(0xa1);
const MSG = new Uint8Array(16).fill(0x11);
const MSG2 = new Uint8Array(16).fill(0x12);

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
      outbox: () => encode([[MSG, 2, 'E_TOO_LARGE', 1_700_000_000, 'hi', 0, null, []]]),
      timeline: () => encode([
        [5, 7, 1_700_000_000, 0, '', USER, DEV, 0, 1, MSG, 0, 'hi', 0, null, [], 0, [], 0],
        [6, 7, 1_700_000_001, 1, 'E_PRUNED', null, DEV, null, null, null, null, '', 0, null, [], 0, [], 0],
        [9, 7, 1_700_000_004, 0, '', USER, DEV, 0, 1, MSG2, 0, 'edited', 8, [MSG, 5, USER, 'hi', 0], [['👍', 2, 1], ['🎉', 1, 0]], 1,
          [[0, 1234, 'image/png', 640, 480, 1, 'map.png'], [1, 70000, 'application/pdf', null, null, 0, '']], 1],
      ]),
    });
    expect(port.sendPrepare(G, { type: 0, replyTo: null, body: 'hi', attachments: [] }, 1n)).toEqual(MSG);
    expect(port.sendEncrypt(MSG)).toEqual({ groupId: G, messageBody: new Uint8Array([5, 6]) });
    expect(port.sendConfirm(MSG, new Uint8Array([1]))).toEqual({ groupId: G, seq: 42n });
    expect(port.outbox(G)).toEqual([{ msgId: MSG, state: 2, error: 'E_TOO_LARGE', created: 1_700_000_000n, body: 'hi', type: 0, replyTo: null, attachments: [] }]);
    const plain = { editedSeq: 0n, reply: null, reactions: [], pinned: false, attachments: [], mention: false };
    expect(port.timeline(G, 0n, 100)).toEqual([
      { seq: 5n, epoch: 7n, recvTs: 1_700_000_000n, status: 0, reason: '', senderUser: USER, senderDevice: DEV, senderKind: 0, senderTier: 1, msgId: MSG, type: 0, body: 'hi', ...plain },
      { seq: 6n, epoch: 7n, recvTs: 1_700_000_001n, status: 1, reason: 'E_PRUNED', senderUser: null, senderDevice: DEV, senderKind: null, senderTier: null, msgId: null, type: null, body: '', ...plain },
      { seq: 9n, epoch: 7n, recvTs: 1_700_000_004n, status: 0, reason: '', senderUser: USER, senderDevice: DEV, senderKind: 0, senderTier: 1, msgId: MSG2, type: 0, body: 'edited',
        editedSeq: 8n, reply: { replyTo: MSG, targetSeq: 5n, targetUser: USER, excerpt: 'hi', state: 0 },
        reactions: [{ emoji: '👍', count: 2, mine: true }, { emoji: '🎉', count: 1, mine: false }], pinned: true,
        attachments: [{ index: 0, size: 1234, mime: 'image/png', w: 640, h: 480, hasThumb: true, name: 'map.png' },
          { index: 1, size: 70000, mime: 'application/pdf', w: null, h: null, hasThumb: false, name: '' }],
        mention: true },
    ]);
  });

  it('refuses a timeline row of the web-2a shape or with out-of-range values (L-CORE-34)', () => {
    const twelve: CborInput[] = [5, 7, 1_700_000_000, 0, '', USER, DEV, 0, 1, MSG, 0, 'hi'];
    const decodeOne = (row: CborInput[]) => caught(() => stub({ timeline: () => encode([row]) }).port.timeline(G, 0n, 100)).code;
    expect(decodeOne(twelve)).toBe('E_CORE_DECODE');
    const row = (at: number, v: CborInput): CborInput[] => { const r: CborInput[] = [...twelve, 0, null, [], 0, [], 0]; r[at] = v; return r; };
    expect(decodeOne(row(15, 2))).toBe('E_CORE_DECODE');
    expect(decodeOne(row(17, 2))).toBe('E_CORE_DECODE');
    expect(decodeOne(row(13, [MSG, null, null, '', 3]))).toBe('E_CORE_DECODE');
    expect(decodeOne(row(13, [MSG, null, null, '']))).toBe('E_CORE_DECODE');
    expect(decodeOne(row(14, [['👍', 1]]))).toBe('E_CORE_DECODE');
    expect(decodeOne(row(16, [[0, 1, 'x', null, null, 2, '']]))).toBe('E_CORE_DECODE');
    expect(stub({ timeline: () => encode([row(13, [MSG, null, null, '', 1])]) }).port.timeline(G, 0n, 100)[0]?.reply)
      .toEqual({ replyTo: MSG, targetSeq: null, targetUser: null, excerpt: '', state: 1 });
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
    const s = stub({ state_sealed_uploaded: () => undefined, state_sealed_current: () => true });
    s.port.stateSealedUploaded();
    expect(s.port.stateSealedCurrent()).toBe(true);
    expect(s.calls).toEqual([{ method: 'state_sealed_uploaded', args: [] }, { method: 'state_sealed_current', args: [] }]);
  });

  it('walks the enrolment exports in the facade argument order', () => {
    const body = new Uint8Array([0x85, 1]);
    const s = stub({
      enrol_begin: () => encode([DEV, DSK]), enrol_session_sign: () => body, enrol_registered: () => undefined,
      enrol_complete: () => encode([new Uint8Array([4]), new Uint8Array([5]), null]), enrol_reset: () => undefined,
    });
    expect(s.port.enrolBegin(INST)).toEqual({ deviceId: DEV, dskPub: DSK });
    const nonce = new Uint8Array(32).fill(9);
    const login = new TextEncoder().encode('asrt-1');
    expect(s.port.enrolSessionSign(nonce, login)).toBe(body);
    s.port.enrolRegistered(USER);
    const input = { recoveryKey: 'abcd-efgh', rootSealed: new Uint8Array([1]), stateSealed: new Uint8Array([2]), listBody: new Uint8Array([3]), username: 'ada', now: 1_800_000_000n };
    expect(s.port.enrolComplete(input)).toEqual({ deviceListBody: new Uint8Array([4]), stateSealed: new Uint8Array([5]), interrupted: null });
    s.port.enrolReset();
    expect(s.calls).toEqual([
      { method: 'enrol_begin', args: [INST] },
      { method: 'enrol_session_sign', args: [nonce, login] },
      { method: 'enrol_registered', args: [USER] },
      { method: 'enrol_complete', args: ['abcd-efgh', input.rootSealed, input.stateSealed, input.listBody, 'ada', 1_800_000_000n] },
      { method: 'enrol_reset', args: [] },
    ]);
  });

  it('forwards the drop of an unpublished candidate (BACKUPS-RECOVERY-02)', () => {
    const s = stub({ device_list_drop: () => undefined });
    s.port.deviceListDrop();
    expect(s.calls).toEqual([{ method: 'device_list_drop', args: [] }]);
  });

  it('forwards the recovery key form check and maps its refusal (REGISTRATION-DEVICES-02)', () => {
    const s = stub({ recovery_key_check: () => undefined });
    s.port.recoveryKeyCheck('abcd-efgh');
    expect(s.calls).toEqual([{ method: 'recovery_key_check', args: ['abcd-efgh'] }]);
    const refused = caught(() => stub({ recovery_key_check: () => { throw new Error('E_RECOVERY_KEY'); } }).port.recoveryKeyCheck('x'));
    expect([refused.code, refused.detail]).toEqual(['E_RECOVERY_KEY', '']);
  });

  it('concatenates the device ids of a revocation and refuses a malformed list before the call', () => {
    const s = stub({ device_list_revoke: () => encode([new Uint8Array([6]), new Uint8Array([7]), new Uint8Array([5])]) });
    const a = new Uint8Array(16).fill(0x0a);
    const b = new Uint8Array(16).fill(0x0b);
    const input = { recoveryKey: 'K', rootSealed: new Uint8Array([1]), stateSealed: new Uint8Array([2]), listBody: new Uint8Array([3]), deviceIds: [a, b], now: 9n };
    expect(s.port.deviceListRevoke(input)).toEqual({ deviceListBody: new Uint8Array([6]), stateSealed: new Uint8Array([7]), interrupted: new Uint8Array([5]) });
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

describe('wrapCore web-2b', () => {
  const BLOB = new Uint8Array(32).fill(0xb1);
  const KEY = new Uint8Array(32).fill(0xb2);
  const NONCE = new Uint8Array(12).fill(0xb3);
  const THUMB = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const ROLE_A = new Uint8Array(16).fill(0x0a);
  const ROLE_B = new Uint8Array(16).fill(0x0b);
  const descriptor = { blobId: BLOB, key: KEY, nonce: NONCE, size: 1234, mime: 'image/png', w: 640, h: 480, thumb: THUMB, name: 'map.png' };

  it('encodes a send request as the L-CORE-36 array, attachment elements in order', () => {
    const s = stub({ send_prepare: () => encode([MSG]) });
    expect(s.port.sendPrepare(G, { type: 0, replyTo: MSG, body: 'look', attachments: [descriptor] }, 7n)).toEqual(MSG);
    expect(s.calls[0]?.method).toBe('send_prepare');
    expect(s.calls[0]?.args[0]).toBe(G);
    expect(s.calls[0]?.args[2]).toBe(7n);
    expect(decode(s.calls[0]?.args[1] as Uint8Array)).toEqual([0n, MSG, 'look', [[BLOB, KEY, NONCE, 1234n, 'image/png', 640n, 480n, THUMB, 'map.png']]]);
    s.port.sendPrepare(G, { type: 3, replyTo: MSG, body: '👍', attachments: [] }, 8n);
    expect(decode(s.calls[1]?.args[1] as Uint8Array)).toEqual([3n, MSG, '👍', []]);
    s.port.sendPrepare(G, { type: 0, replyTo: null, body: 'x', attachments: [{ ...descriptor, w: null, h: null, thumb: null, name: '' }] }, 9n);
    expect(decode(s.calls[2]?.args[1] as Uint8Array)).toEqual([0n, null, 'x', [[BLOB, KEY, NONCE, 1234n, 'image/png', null, null, null, '']]]);
  });

  it('reads the eight-element outbox row', () => {
    const { port } = stub({
      outbox: () => encode([
        [MSG, 0, '', 1_800_000_000, '', 0, null, [[BLOB, 1234, 'image/png', 'map.png']]],
        [G, 2, 'E_CORE_STATE', 1_800_000_001, '👍', 3, MSG, []],
      ]),
    });
    expect(port.outbox(G)).toEqual([
      { msgId: MSG, state: 0, error: '', created: 1_800_000_000n, body: '', type: 0, replyTo: null,
        attachments: [{ blobId: BLOB, size: 1234, mime: 'image/png', name: 'map.png' }] },
      { msgId: G, state: 2, error: 'E_CORE_STATE', created: 1_800_000_001n, body: '👍', type: 3, replyTo: MSG, attachments: [] },
    ]);
  });

  it('reads pins, an attachment descriptor and purges', () => {
    const s = stub({
      pins: () => encode([[5, MSG, 9, USER, null, 'the excerpt', 1700000005], [3, G, 7, DEV, USER, '', 1700000003]]),
      attachment_get: () => encode([BLOB, KEY, NONCE, 1234, 'image/png', 640, 480, THUMB, 'map.png']),
      purges: () => encode([[G, 12, CHAN, [BLOB, KEY]]]),
    });
    expect(s.port.pins(G)).toEqual([
      { targetSeq: 5n, msgId: MSG, pinnedSeq: 9n, byUser: USER, author: null, excerpt: 'the excerpt', targetTs: 1700000005n },
      { targetSeq: 3n, msgId: G, pinnedSeq: 7n, byUser: DEV, author: USER, excerpt: '', targetTs: 1700000003n },
    ]);
    expect(s.port.attachmentGet(G, 12n, 1)).toEqual(descriptor);
    expect(s.calls[1]).toEqual({ method: 'attachment_get', args: [G, 12n, 1] });
    expect(s.port.purges()).toEqual([{ groupId: G, seq: 12n, channelId: CHAN, blobIds: [BLOB, KEY] }]);
  });

  it('forwards purgeDone and concatenates own role ids, refusing a malformed set before the call', () => {
    const s = stub({ purge_done: () => undefined, own_roles_set: () => undefined });
    s.port.purgeDone(G, 12n);
    s.port.ownRolesSet(COMM, [ROLE_A, ROLE_B]);
    s.port.ownRolesSet(COMM, []);
    const both = new Uint8Array(32);
    both.set(ROLE_A, 0);
    both.set(ROLE_B, 16);
    expect(s.calls).toEqual([
      { method: 'purge_done', args: [G, 12n] },
      { method: 'own_roles_set', args: [COMM, both] },
      { method: 'own_roles_set', args: [COMM, new Uint8Array(0)] },
    ]);
    expect(caught(() => s.port.ownRolesSet(COMM, [new Uint8Array(15)])).code).toBe('E_CORE_INPUT');
    expect(caught(() => s.port.ownRolesSet(COMM, Array.from({ length: 65 }, () => ROLE_A))).code).toBe('E_CORE_INPUT');
    expect(caught(() => s.port.ownRolesSet(COMM, [new Uint8Array(15)])).detail).toBe('role_ids must be 0..=64 ids of 16 bytes');
    expect(s.calls).toHaveLength(3);
  });

  it('maps a web-2b result of the wrong shape to E_CORE_DECODE', () => {
    expect(caught(() => stub({ outbox: () => encode([[MSG, 0, '', 1, 'hi']]) }).port.outbox(G)).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ outbox: () => encode([[MSG, 0, '', 1, 'hi', 7, null, []]]) }).port.outbox(G)).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ pins: () => encode([[5, MSG, 9, USER, null, 'x']]) }).port.pins(G)).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ attachment_get: () => encode([BLOB, KEY, new Uint8Array(11), 1, 'x', null, null, null, '']) })
      .port.attachmentGet(G, 1n, 0)).code).toBe('E_CORE_DECODE');
    expect(caught(() => stub({ purges: () => encode([[G, 1, CHAN, [new Uint8Array(31)]]]) }).port.purges()).code).toBe('E_CORE_DECODE');
  });
});
