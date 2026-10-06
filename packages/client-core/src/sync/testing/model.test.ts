import { describe, expect, it } from 'vitest';
import { arr, bin, decode, encode, type CborInput } from '../../cbor';
import type { ExpectedGroup, Id } from '../../core-port';
import { CHANNEL, CHANNEL_2, COMMUNITY, ME, ModelCore, ModelDs, PEER, THIRD, at, idOf, wire } from './model';

import { toHex } from '../../hex';
import type { Frame } from '../../gateway/frames';
import { fakeListBlob } from '../../testing/fake-list';

const G = idOf(0x9b, 1);
const G2 = idOf(0x9b, 2);
const G3 = idOf(0x9b, 3);
const CHANNEL_3 = idOf(0xc1, 3);

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function registered(core: ModelCore, groupId: Id = G, channelId: Id = CHANNEL): void {
  core.groupCreate(groupId, COMMUNITY, channelId);
  core.groupRegistered(groupId, 1n);
}

function expectedFor(groupId: Id, channelId: Id = CHANNEL): ExpectedGroup {
  return { groupId, communityId: COMMUNITY, channelId, policyVersion: 1n };
}

/** A GET /v1/welcomes body, labelled truthfully; each entry is [welcome_id, group_id, epoch, commit_seq]. */
function welcomes(...rows: [bigint, Id, bigint, bigint][]): Uint8Array {
  return encode(rows.map(([id, g, epoch, seq]) => [id, g, epoch, seq, wire.welcome(g, epoch), wire.tree(g, epoch), wire.treeHash(g, epoch)]));
}

/** A welcomes item labelled epoch `label` (and that epoch's tree hash) around an arbitrary blob. */
function labelled(id: bigint, g: Id, label: bigint, blob: Uint8Array): CborInput[] {
  return [id, g, label, 1n, blob, wire.tree(g, label), wire.treeHash(g, label)];
}

function peerMsg(seq: bigint, body: string): CborInput[] {
  return [seq, 0n, PEER.device, wire.app(PEER, idOf(0x7e, Number(seq)), body), new Uint8Array(32), new Uint8Array(32), 1_700_000_000n + seq, 0];
}

function peerRow(seq: bigint, body: string): Uint8Array {
  return encode([peerMsg(seq, body)]);
}

/** A self-update commit by PEER (kind 1) framed in `framed`. */
function commitRow(seq: bigint, framed: bigint): CborInput[] {
  return [seq, framed, 1n, 1n, wire.commit(framed + 1n, PEER.device, [], [])];
}

/** The 200 bodies of GET …/info and …/tree for group g at epoch e. */
function infoAt(g: Id, e: bigint): Uint8Array {
  return encode([e, wire.info(g, e), wire.treeHash(g, e), 1n]);
}
function treeAt(g: Id, e: bigint): Uint8Array {
  return encode([e, wire.tree(g, e), wire.treeHash(g, e)]);
}

/** The private message a sendEncrypt framed (element 1 of the message body). */
function blobOf(sent: { messageBody: Uint8Array }): Uint8Array {
  return bin(at(arr(decode(sent.messageBody), 2), 1));
}

/** Registered G, then two peer commits (epoch 2) and one that cannot be processed: state 3, floor 2. */
function stoppedAtEpoch2(core: ModelCore): void {
  registered(core);
  core.groupApply(G, encode([commitRow(1n, 0n), commitRow(2n, 1n), [3n, 2n, 1n, 1n, new Uint8Array([0xff])]]), encode([]), 3n);
}

describe('ModelCore follows L-CORE-07..09', () => {
  it('sendPrepare counts the body limit in UTF-8 bytes, as the core does', () => {
    const core = new ModelCore(ME);
    registered(core);
    expect(thrown(() => core.sendPrepare(G, '€'.repeat(1334), 1n))).toMatchObject({ code: 'E_ENVELOPE_LIMIT' }); // 4002 bytes
    expect(core.outbox(G)).toEqual([]);
    const id = core.sendPrepare(G, '€'.repeat(1333), 1n); // 3999 bytes
    expect(core.outbox(G).map((r) => r.msgId)).toEqual([id]);
  });

  it('sendEncrypt refuses with E_CORE_STATE while a proposal is pending, and changes nothing', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([[1n, 0n, 0n, null, wire.prop(idOf(0x5e, 1), 'add', THIRD.device)]]), encode([]), 1n);
    expect(core.group(G)?.proposalsPending).toBe(1);
    const id = core.sendPrepare(G, 'held', 1n);
    expect(thrown(() => core.sendEncrypt(id))).toMatchObject({ code: 'E_CORE_STATE', detail: 'proposals are pending' });
    expect(core.outbox(G).map((r) => r.state)).toEqual([0]);
  });

  it('sendEncrypt refuses with E_CORE_STATE while a commit is pending', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.commitBuild(G, encode([]));
    expect(core.group(G)).toMatchObject({ pendingCommit: true, proposalsPending: 0 });
    const id = core.sendPrepare(G, 'held', 1n);
    expect(thrown(() => core.sendEncrypt(id))).toMatchObject({ code: 'E_CORE_STATE', detail: 'a commit is pending' });
    expect(core.outbox(G).map((r) => r.state)).toEqual([0]);
  });

  it('welcomesApply answers outcome 1 for a row in state 0, 1 or 2 and leaves it untouched', () => {
    const core = new ModelCore(ME);
    core.groupCreate(G, COMMUNITY, CHANNEL); // state 0
    core.groupJoinExternal(
      expectedFor(G2, CHANNEL_2),
      encode([0n, wire.info(G2, 0n), new Uint8Array(32), 1n]),
      encode([0n, wire.tree(G2, 0n), new Uint8Array(32)]),
    ); // state 1
    registered(core, G3, CHANNEL_3); // state 2
    const out = core.welcomesApply(welcomes([1n, G, 1n, 1n], [2n, G2, 1n, 1n], [3n, G3, 1n, 1n]), [
      expectedFor(G), expectedFor(G2, CHANNEL_2), expectedFor(G3, CHANNEL_3),
    ]);
    expect(out.map((o) => o.outcome)).toEqual([1, 1, 1]);
    expect([core.group(G)?.state, core.group(G2)?.state, core.group(G3)?.state]).toEqual([0, 1, 2]);
  });

  it('welcomesApply joins over a row in state 3 and keeps its stored rows', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(1n, 'kept'), 1n);
    core.groupApply(G, encode([[2n, 0n, 1n, 1n, new Uint8Array([0xff])]]), encode([]), 2n);
    expect(core.group(G)?.state).toBe(3);
    expect(core.welcomesApply(welcomes([4n, G, 2n, 5n]), [expectedFor(G)])).toEqual([{ welcomeId: 4n, groupId: G, outcome: 0, reason: '' }]);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 2n, nextSeq: 6n });
    expect(core.bodies(G)).toEqual(['kept']);
  });

  it('welcomesApply refuses a Welcome while another group holds the channel (outcome 2, E_CORE_STATE)', () => {
    const core = new ModelCore(ME);
    registered(core); // G holds CHANNEL
    expect(core.welcomesApply(welcomes([7n, G2, 1n, 1n]), [expectedFor(G2)])).toEqual([
      { welcomeId: 7n, groupId: G2, outcome: 2, reason: 'E_CORE_STATE' },
    ]);
    expect(core.group(G2)).toBeUndefined();
  });

  it('messageDeleted clears a stored row once and ignores a seq it does not hold', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(1n, 'bye'), 1n);
    expect(core.messageDeleted(G, 1n)).toEqual({
      state: 2, epoch: 0n, nextSeq: 2n, newSeqs: [1n], proposalsPending: 0, epochChanged: false, ownAdopted: false,
    });
    expect(core.timeline(G, 0n, 200)).toMatchObject([{ seq: 1n, status: 2, body: '' }]);
    expect(core.messageDeleted(G, 1n).newSeqs).toEqual([]);
    expect(core.messageDeleted(G, 9n).newSeqs).toEqual([]);
  });

  it('messageDeleted refuses an unknown group and a group that removed this device', () => {
    const core = new ModelCore(ME);
    expect(thrown(() => core.messageDeleted(G, 1n))).toMatchObject({ code: 'E_CORE_NOT_FOUND' });
    registered(core);
    core.groupApply(G, encode([[1n, 0n, 1n, 1n, wire.commit(1n, PEER.device, [], [ME.device])]]), encode([]), 1n);
    expect(core.group(G)?.state).toBe(4);
    expect(thrown(() => core.messageDeleted(G, 1n))).toMatchObject({ code: 'E_CORE_STATE' });
  });

  // --- amended after the core hardening (L-CORE-07..09 as amended) ---

  it('groupApply skips a live row served at a stored seq: not listed, not processed, nextSeq moves past it', () => {
    const core = new ModelCore(ME);
    registered(core);
    const m = core.sendPrepare(G, 'mine', 1n);
    core.sendEncrypt(m);
    expect(core.sendConfirm(m, encode([3n, new Uint8Array(32), 1_700_000_003n]))).toEqual({ groupId: G, seq: 3n }); // ahead of nextSeq
    const r = core.groupApply(G, encode([]), encode([peerMsg(2n, 'two'), peerMsg(3n, 'served twice')]), 3n);
    expect(r).toMatchObject({ newSeqs: [2n], nextSeq: 4n, ownAdopted: false });
    expect(core.timeline(G, 0n, 200).map((x) => [x.seq, x.status, x.body])).toEqual([[2n, 0, 'two'], [3n, 0, 'mine']]);
  });

  it('adopts a failed row and a queued row whose commitment the echo carries', () => {
    const core = new ModelCore(ME);
    registered(core);
    const failed = core.sendPrepare(G, 'failed', 1n);
    const failedBlob = blobOf(core.sendEncrypt(failed)); // stored by the server; its answer was lost
    core.sendFail(failed, 'E_NETWORK');
    const queued = core.sendPrepare(G, 'queued', 2n);
    const queuedBlob = blobOf(core.sendEncrypt(queued)); // stored too; requeued after the echo wait
    core.sendRequeue(queued);
    const r = core.groupApply(G, encode([]), encode([ModelDs.row.ownEcho(1n, 0n, failedBlob), ModelDs.row.ownEcho(2n, 0n, queuedBlob)]), 2n);
    expect(r).toMatchObject({ newSeqs: [1n, 2n], ownAdopted: true });
    expect(core.outbox(G)).toEqual([]);
    expect(core.timeline(G, 0n, 200).map((x) => [x.seq, x.status, x.msgId, x.body])).toEqual([[1n, 0, failed, 'failed'], [2n, 0, queued, 'queued']]);
  });

  it('adopts nothing on a commitment mismatch (E_OWN_UNKNOWN, the row in flight stays), then adopts by the blob alone', () => {
    const core = new ModelCore(ME);
    registered(core);
    const m = core.sendPrepare(G, 'in flight', 1n);
    const blob = blobOf(core.sendEncrypt(m));
    const unplaced = wire.app(ME, idOf(0x6d, 99), 'an upload this device cannot place');
    const r = core.groupApply(G, encode([]), encode([
      ModelDs.row.ownEcho(1n, 0n, unplaced),
      [2n, 0n, ME.device, blob, wire.commitment(idOf(0x6d, 98)), new Uint8Array(32), 1_700_000_002n, 0], // field and blob disagree
    ]), 2n);
    expect(r).toMatchObject({ newSeqs: [1n, 2n], ownAdopted: false });
    expect(core.unreadable(G)).toEqual([{ seq: 1n, reason: 'E_OWN_UNKNOWN' }, { seq: 2n, reason: 'E_OWN_UNKNOWN' }]);
    expect(core.outbox(G).map((o) => [o.msgId, o.state])).toEqual([[m, 1]]);
    // A live op-19 row carries no commitment field: the blob's own commitment decides.
    const live = core.groupApply(G, encode([]), encode([[3n, 0n, ME.device, blob, null, new Uint8Array(32), 1_700_000_003n, 0]]), 3n);
    expect(live).toMatchObject({ newSeqs: [3n], ownAdopted: true });
    expect(core.outbox(G)).toEqual([]);
  });

  it('a deleted upload of an outbox row is stored as its own deleted marker and adopts it; without a commitment the outbox stays', () => {
    const core = new ModelCore(ME);
    registered(core);
    const m = core.sendPrepare(G, 'gone soon', 1n);
    core.sendEncrypt(m);
    const r = core.groupApply(G, encode([]), encode([[1n, 0n, ME.device, null, wire.commitment(m), new Uint8Array(32), 1_700_000_001n, 1]]), 1n);
    expect(r).toMatchObject({ newSeqs: [1n], ownAdopted: true });
    expect(core.timeline(G, 0n, 200)).toMatchObject([{ seq: 1n, status: 2, body: '', senderUser: ME.user, senderDevice: ME.device, msgId: m }]);
    expect(core.outbox(G)).toEqual([]);
    expect(core.sendConfirm(m, encode([1n, new Uint8Array(32), 1_700_000_001n]))).toEqual({ groupId: G, seq: 1n }); // read back
    const m2 = core.sendPrepare(G, 'unplaced', 2n);
    core.sendEncrypt(m2);
    core.groupApply(G, encode([]), encode([[2n, 0n, ME.device, null, null, new Uint8Array(32), 1_700_000_002n, 1]]), 2n);
    expect(at(core.timeline(G, 0n, 200), 1)).toMatchObject({ seq: 2n, status: 2, senderUser: null, msgId: null });
    expect(core.outbox(G).map((o) => [o.msgId, o.state])).toEqual([[m2, 1]]);
    // The answer for that upload names seq 2: the confirm completes at its own deleted marker.
    expect(core.sendConfirm(m2, encode([2n, new Uint8Array(32), 1_700_000_002n]))).toEqual({ groupId: G, seq: 2n });
    expect(core.outbox(G)).toEqual([]);
    expect(at(core.timeline(G, 0n, 200), 1)).toMatchObject({ seq: 2n, status: 2, msgId: m2 });
  });

  it('sendConfirm at a seq that holds another row fails the row, throws E_CORE_STATE, and the group sends on', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(1n, 'theirs'), 1n);
    const m = core.sendPrepare(G, 'mine', 1n);
    core.sendEncrypt(m);
    expect(thrown(() => core.sendConfirm(m, encode([1n, new Uint8Array(32), 1_700_000_001n])))).toMatchObject({
      code: 'E_CORE_STATE', detail: 'message seq exists',
    });
    expect(core.outbox(G)).toMatchObject([{ msgId: m, state: 2, error: 'E_CORE_STATE', body: 'mine' }]);
    expect(core.bodies(G)).toEqual(['theirs']);
    expect(thrown(() => core.sendFail(m, 'E_NETWORK'))).toMatchObject({ code: 'E_CORE_STATE' });
    expect(core.sendEncrypt(core.sendPrepare(G, 'next', 2n)).groupId).toEqual(G);
  });

  it('groupJoined and welcomesApply never lower nextSeq', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(5n, 'five'), 5n); // nextSeq 6
    core.groupJoinExternal(expectedFor(G), infoAt(G, 0n), treeAt(G, 0n)); // a resync
    core.groupJoined(G, 2n);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 6n });
    core.groupApply(G, encode([[6n, 1n, 1n, 1n, new Uint8Array([0xff])]]), encode([]), 6n);
    expect(core.group(G)?.state).toBe(3);
    expect(core.welcomesApply(welcomes([1n, G, 2n, 2n]), [expectedFor(G)])).toMatchObject([{ outcome: 0 }]);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 2n, nextSeq: 6n });
    expect(core.bodies(G)).toEqual(['five']);
  });

  it('refuses a Welcome at or below the floor over an existing row, and a mislabelled one, raising nothing; one above joins', () => {
    const core = new ModelCore(ME);
    stoppedAtEpoch2(core);
    expect(core.group(G)).toMatchObject({ state: 3, epoch: 2n });
    expect(core.floor(G)).toBe(2n);
    expect(core.welcomesApply(welcomes([1n, G, 1n, 4n], [2n, G, 2n, 4n]), [expectedFor(G)])).toEqual([
      { welcomeId: 1n, groupId: G, outcome: 2, reason: 'E_CORE_INPUT' },
      { welcomeId: 2n, groupId: G, outcome: 2, reason: 'E_CORE_INPUT' },
    ]);
    // A Welcome into epoch 9 labelled 3 is refused (3f26670) and leaves the floor at 2.
    expect(core.welcomesApply(encode([labelled(9n, G, 3n, wire.welcome(G, 9n))]), [expectedFor(G)])).toEqual([
      { welcomeId: 9n, groupId: G, outcome: 2, reason: 'E_CORE_INPUT' },
    ]);
    expect(core.group(G)?.state).toBe(3);
    expect(core.floor(G)).toBe(2n);
    expect(core.welcomesApply(welcomes([3n, G, 3n, 4n]), [expectedFor(G)])).toMatchObject([{ outcome: 0 }]);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 3n });
    expect(core.floor(G)).toBe(3n);
  });

  it('refuses a GroupInfo below the floor and rejoins from one at it; a discarded resync keeps the floor and can be repeated', () => {
    const core = new ModelCore(ME);
    stoppedAtEpoch2(core);
    expect(thrown(() => core.groupJoinExternal(expectedFor(G), infoAt(G, 1n), treeAt(G, 1n)))).toMatchObject({
      code: 'E_CORE_INPUT', detail: 'GroupInfo would rejoin at or below an epoch this device has held',
    });
    expect(core.group(G)?.state).toBe(3);
    core.groupJoinExternal(expectedFor(G), infoAt(G, 2n), treeAt(G, 2n));
    core.groupDiscard(G); // the server refused the external commit
    expect(core.group(G)?.state).toBe(3);
    expect(core.floor(G)).toBe(2n);
    core.groupJoinExternal(expectedFor(G), infoAt(G, 2n), treeAt(G, 2n));
    core.groupJoined(G, 9n);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 3n, nextSeq: 10n });
    expect(core.floor(G)).toBe(3n);
  });

  it('a discarded rejoin of a gone row returns it to state 4 with its timeline; a join that created its row leaves nothing', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(1n, 'kept'), 1n);
    core.groupApply(G, encode([[2n, 0n, 1n, 1n, wire.commit(1n, PEER.device, [], [ME.device])]]), encode([]), 2n);
    expect(core.group(G)).toMatchObject({ state: 4, nextSeq: 3n });
    core.groupJoinExternal(expectedFor(G), infoAt(G, 1n), treeAt(G, 1n));
    expect(core.group(G)?.state).toBe(1);
    core.groupDiscard(G);
    expect(core.group(G)).toMatchObject({ state: 4, nextSeq: 3n });
    expect(core.bodies(G)).toEqual(['kept']);
    // A Welcome never rebinds the row to another channel.
    expect(core.welcomesApply(welcomes([5n, G, 2n, 3n]), [expectedFor(G, CHANNEL_2)])).toEqual([
      { welcomeId: 5n, groupId: G, outcome: 2, reason: 'E_CORE_STATE' },
    ]);
    expect(core.group(G)).toMatchObject({ state: 4, targetId: CHANNEL });
    core.groupJoinExternal(expectedFor(G2, CHANNEL_2), infoAt(G2, 0n), treeAt(G2, 0n));
    core.groupDiscard(G2);
    expect(core.group(G2)).toBeUndefined();
  });

  it('groupJoinExternal refuses another group id, a row bound to another channel and another holder of the channel, writing nothing', () => {
    const core = new ModelCore(ME);
    registered(core); // G holds CHANNEL
    expect(thrown(() => core.groupJoinExternal(expectedFor(G2, CHANNEL_2), infoAt(G3, 0n), treeAt(G3, 0n)))).toMatchObject({
      code: 'E_CORE_INPUT', detail: 'GroupInfo group id does not match',
    });
    expect(core.group(G2)).toBeUndefined();
    expect(thrown(() => core.groupJoinExternal(expectedFor(G, CHANNEL_2), infoAt(G, 0n), treeAt(G, 0n)))).toMatchObject({
      code: 'E_CORE_STATE', detail: 'group is bound to another channel',
    });
    expect(core.group(G)).toMatchObject({ state: 2, targetId: CHANNEL });
    expect(thrown(() => core.groupJoinExternal(expectedFor(G2), infoAt(G2, 0n), treeAt(G2, 0n)))).toMatchObject({ code: 'E_CORE_STATE' });
    expect(core.group(G2)).toBeUndefined();
  });

  it('the floor is the last epoch reached: a removal does not raise it to the epoch of the removing commit', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([commitRow(1n, 0n), commitRow(2n, 1n)]), encode([]), 2n); // epoch 2 reached
    core.groupApply(G, encode([[3n, 2n, 1n, 1n, wire.commit(3n, PEER.device, [], [ME.device])]]), encode([]), 3n);
    expect(core.group(G)).toMatchObject({ state: 4, nextSeq: 4n });
    expect(core.floor(G)).toBe(2n);
    expect(thrown(() => core.groupJoinExternal(expectedFor(G), infoAt(G, 1n), treeAt(G, 1n)))).toMatchObject({ code: 'E_CORE_INPUT' });
    core.groupJoinExternal(expectedFor(G), infoAt(G, 2n), treeAt(G, 2n)); // lands at 3, above the floor
    expect(core.group(G)?.state).toBe(1);
    expect(core.floor(G)).toBe(2n); // the join's own epoch is recorded only by groupJoined
    core.groupJoined(G, 5n);
    expect(core.floor(G)).toBe(3n);
  });

  it('welcomesApply refuses a Welcome whose joined state is not its labels, and one into another group, storing nothing', () => {
    // 3f26670: the group id is checked first (E_BINDING), then the label (E_CORE_INPUT).
    const core = new ModelCore(ME);
    const out = core.welcomesApply(encode([
      labelled(1n, G, 1n, wire.welcome(G, 7n)), // the joined epoch is not the label
      labelled(2n, G, 1n, wire.welcome(G, 1n, wire.treeHash(G2, 1n))), // the joined tree hash is not the label
      labelled(3n, G, 1n, wire.welcome(G2, 1n)), // a Welcome into another group
    ]), [expectedFor(G)]);
    expect(out.map((o) => [o.outcome, o.reason])).toEqual([[2, 'E_CORE_INPUT'], [2, 'E_CORE_INPUT'], [2, 'E_BINDING']]);
    expect(core.group(G)).toBeUndefined();
    expect(core.welcomesApply(welcomes([4n, G, 1n, 1n]), [expectedFor(G)])).toMatchObject([{ outcome: 0 }]);
    expect(core.group(G)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 2n });
  });
  it('sendConfirm keeps the epoch framed by sendEncrypt after the group advances', () => {
    const core = new ModelCore(ME);
    registered(core);
    const msg = core.sendPrepare(G, 'framed first', 1n);
    core.sendEncrypt(msg);
    core.groupApply(G, encode([commitRow(1n, 0n)]), encode([]), 1n);
    expect(core.group(G)?.epoch).toBe(1n);
    core.sendConfirm(msg, encode([2n, new Uint8Array(32), 3n]));
    expect(core.timeline(G, 0n, 10).find((row) => row.seq === 2n)?.epoch).toBe(0n);
  });

  it('cursorAcked refuses a future seq and never moves its cursor backward', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), peerRow(1n, 'one'), 1n);
    expect(thrown(() => core.cursorAcked(G, 2n, 0n))).toMatchObject({ code: 'E_CORE_INPUT' });
    core.cursorAcked(G, 1n, 0n);
    core.cursorAcked(G, 0n, 0n);
    expect(core.cursorBody(G)).toBeNull();
  });

  it('commitConfirm refuses a non-active group', () => {
    const core = new ModelCore(ME);
    core.groupCreate(G, COMMUNITY, CHANNEL);
    expect(thrown(() => core.commitConfirm(G))).toMatchObject({ code: 'E_CORE_STATE' });
  });

  it('groupApply refuses duplicate seqs within a single input array', () => {
    const core = new ModelCore(ME);
    registered(core);
    expect(thrown(() => core.groupApply(G, encode([]), encode([peerMsg(1n, 'first'), peerMsg(1n, 'second')]), 1n)))
      .toMatchObject({ code: 'E_CORE_INPUT' });
    expect(thrown(() => core.groupApply(G, encode([commitRow(1n, 0n), commitRow(1n, 0n)]), encode([]), 1n)))
      .toMatchObject({ code: 'E_CORE_INPUT' });
    expect(core.group(G)?.nextSeq).toBe(1n);
  });

});

describe('ModelCore web-2a: rows, DMs, read markers, activity, settings', () => {
  it('groupRow answers one row of groups() and null for an unknown id', () => {
    const core = new ModelCore(ME);
    registered(core);
    expect(core.groupRow(G)).toEqual(at(core.groups(), 0));
    expect(core.groupRow(G2)).toBeNull();
  });

  it('a DM group has a null community after create, Welcome and external join', () => {
    const core = new ModelCore(ME);
    core.groupCreate(G, null, CHANNEL);
    expect(core.groupRow(G)?.communityId).toBeNull();
    const dm: ExpectedGroup = { groupId: G2, communityId: null, channelId: CHANNEL_2, policyVersion: 1n };
    expect(core.welcomesApply(welcomes([7n, G2, 1n, 2n]), [dm])).toEqual([{ welcomeId: 7n, groupId: G2, outcome: 0, reason: '' }]);
    expect(core.groupRow(G2)).toMatchObject({ communityId: null, targetId: CHANNEL_2, state: 2, epoch: 1n });
    core.groupJoinExternal({ groupId: G3, communityId: null, channelId: CHANNEL_3, policyVersion: 1n }, infoAt(G3, 4n), treeAt(G3, 4n));
    core.groupJoined(G3, 9n);
    expect(core.groupRow(G3)).toMatchObject({ communityId: null, state: 2, epoch: 5n });
  });
  it('reports the joined epoch while an external join is still in state 1', () => {
    const core = new ModelCore(ME);
    core.groupJoinExternal({ groupId: G, communityId: null, channelId: CHANNEL, policyVersion: 1n }, infoAt(G, 4n), treeAt(G, 4n));
    expect(core.groupRow(G)).toMatchObject({ state: 1, epoch: 5n });
  });

  it('a DM row and a community row are bound to different channels for a rejoin', () => {
    const core = new ModelCore(ME);
    core.groupCreate(G, null, CHANNEL);
    core.groupRegistered(G, 1n);
    expect(thrown(() => core.groupJoinExternal(expectedFor(G), infoAt(G, 3n), treeAt(G, 3n))))
      .toMatchObject({ code: 'E_CORE_STATE', detail: 'group is bound to another channel' });
    registered(core, G2, CHANNEL_2);
    expect(thrown(() => core.groupJoinExternal({ groupId: G2, communityId: null, channelId: CHANNEL_2, policyVersion: 1n }, infoAt(G2, 3n), treeAt(G2, 3n))))
      .toMatchObject({ code: 'E_CORE_STATE', detail: 'group is bound to another channel' });
  });

  it('markRead never lowers the marker, clamps it to nextSeq - 1, and refuses state 4 and an unknown group', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), encode([peerMsg(1n, 'a'), peerMsg(2n, 'b'), peerMsg(3n, 'c')]), 3n);
    core.markRead(G, 2n, 1_800_000_000n);
    expect(at(core.activity(), 0)).toMatchObject({ unread: 1, lastReadSeq: 2n, lastSeq: 3n });
    core.markRead(G, 1n, 1_800_000_001n);
    expect(at(core.activity(), 0).lastReadSeq).toBe(2n);
    core.markRead(G, 99n, 1_800_000_002n);
    expect(at(core.activity(), 0)).toMatchObject({ unread: 0, lastReadSeq: 3n, lastSeq: 0n, lastTs: 0n });
    expect(thrown(() => core.markRead(G2, 1n, 1n))).toMatchObject({ code: 'E_CORE_NOT_FOUND' });
    core.groupApply(G, encode([[4n, 0n, 1n, 1n, wire.commit(1n, PEER.device, [], [ME.device])]]), encode([]), 4n);
    expect(core.groupRow(G)?.state).toBe(4);
    expect(thrown(() => core.markRead(G, 1n, 1n))).toMatchObject({ code: 'E_CORE_STATE', detail: 'group state 4' });
  });

  it('activity counts unread type-0 rows of other devices and mentions by the literal rule', () => {
    const core = new ModelCore(ME);
    registered(core, G, CHANNEL);
    registered(core, G2, CHANNEL_2);
    core.groupCreate(G3, COMMUNITY, CHANNEL_3);
    const me = toHex(ME.user);
    const own = core.sendPrepare(G, 'mine <@everyone>', 1n);
    core.sendEncrypt(own);
    core.sendConfirm(own, encode([1n, new Uint8Array(32), 1_700_000_001n]));
    core.groupApply(G, encode([]), encode([
      peerMsg(2n, `hi <@${me}>`), peerMsg(3n, 'plain'), peerMsg(4n, `<@${me.toUpperCase()}>`), peerMsg(5n, 'all <@here>'),
      [6n, 0n, PEER.device, new Uint8Array([0xff]), null, new Uint8Array(32), 1_700_000_006n, 0],
    ]), 6n);
    expect(core.activity()).toEqual([
      { groupId: G, unread: 4, mentions: 2, lastSeq: 5n, lastTs: 1_700_000_005n, lastReadSeq: 0n },
      { groupId: G2, unread: 0, mentions: 0, lastSeq: 0n, lastTs: 0n, lastReadSeq: 0n },
    ]);
  });

  it('activity excludes a row from another device of the own user (ruling 29)', () => {
    const core = new ModelCore(ME);
    registered(core);
    const sibling = { device: idOf(0xd0, 7), user: ME.user };
    core.groupApply(G, encode([]), encode([
      [1n, 0n, sibling.device, wire.app(sibling, idOf(0x7e, 1), `typed in my other browser <@${toHex(ME.user)}>`), new Uint8Array(32), new Uint8Array(32), 1_700_000_001n, 0],
      peerMsg(2n, 'from the peer'),
    ]), 2n);
    expect(at(core.activity(), 0)).toMatchObject({ unread: 1, mentions: 0, lastSeq: 2n, lastTs: 1_700_000_002n });
  });

  it('settings upsert, delete and check their bounds in bytes', () => {
    const core = new ModelCore(ME);
    const mute = 'mute.channel.' + 'a'.repeat(32);
    core.settingPut('notify.default', 'everything');
    core.settingPut(mute, '1');
    core.settingPut('notify.default', 'nothing');
    expect(core.settings()).toEqual({ [mute]: '1', 'notify.default': 'nothing' });
    core.settingDelete(mute);
    core.settingDelete('absent');
    expect(core.settings()).toEqual({ 'notify.default': 'nothing' });
    for (const [k, v] of [['', 'x'], ['k'.repeat(129), 'x'], ['é'.repeat(65), 'x'], ['k', 'v'.repeat(1025)]] as const) {
      expect(thrown(() => core.settingPut(k, v))).toMatchObject({ code: 'E_CORE_INPUT' });
    }
    core.settingPut('k'.repeat(128), 'v'.repeat(1024));
  });
});

describe('ModelDs web-2a: DMs, leafless reads and the device-list gate', () => {
  const DM = idOf(0xd3, 1);
  const NEW = idOf(0xd0, 9);

  it('sends a Welcome to the registrant’s other device when that device has KeyPackages', async () => {
    const ds = new ModelDs();
    ds.addDm(DM, [ME, PEER]);
    ds.own(ME.user, NEW);
    const core = new ModelCore(ME);
    const routes = ds.routesFor(ME.device);
    await routes.postGroup(core.groupCreate(G, null, DM));
    core.groupRegistered(G, 1n);
    const proposals = await routes.getProposals(G);
    expect(arr(decode(proposals))).toHaveLength(2);
    await routes.postCommit(G, core.commitBuild(G, proposals));
    expect(ds.welcomesFor(NEW)).toEqual([{ id: 1n, groupId: toHex(G) }]);
  });

  it('a DM group registered by one participant gets the instance Add of the other, who joins by its Welcome', async () => {
    const ds = new ModelDs();
    ds.addDm(DM, [ME, PEER]);
    const meCore = new ModelCore(ME);
    const routes = ds.routesFor(ME.device);
    expect(await routes.getChannel(DM)).toEqual({ id: DM, kind: 3, mode: 0, visibility: 0, parentId: null, name: '', topic: '', position: 0, seq: 0n, textGroupId: null });
    await routes.postGroup(meCore.groupCreate(G, null, DM));
    meCore.groupRegistered(G, 1n);
    expect((await routes.getChannel(DM)).textGroupId).toEqual(G);
    const proposals = await routes.getProposals(G);
    const rows = arr(decode(proposals));
    expect(rows).toHaveLength(1);
    const prop = arr(decode(bin(at(arr(at(rows, 0), 5), 3))), 4);
    expect([at(prop, 2), bin(at(prop, 3), 16)]).toEqual(['add', PEER.device]);
    // PEER has not registered and does not know the group: its expected set is empty (head ruling 37).
    const frames: Frame[] = [];
    ds.attach(PEER.device, (f) => frames.push(f));
    await routes.postCommit(G, meCore.commitBuild(G, proposals));
    expect(frames.filter((f) => f.op === 20).map((f) => f.groupId)).toEqual([G]);
    expect(ds.welcomesFor(PEER.device)).toEqual([{ id: 1n, groupId: toHex(G) }]);
    expect(ds.view(G).members).toEqual([toHex(ME.device), toHex(PEER.device)].sort());
    const peerCore = new ModelCore(PEER);
    const first = await ds.routesFor(PEER.device).getWelcomes(0n);
    expect(peerCore.welcomesApply(first.raw, [])).toEqual([{ welcomeId: 1n, groupId: G, outcome: 3, reason: '' }]);
    expect(peerCore.groupRow(G)).toBeNull();
    // The controller learns the DM (onUnexpectedWelcome → loadDms → setExpected): the kept Welcome is served again.
    const again = await ds.routesFor(PEER.device).getWelcomes(0n);
    expect(peerCore.welcomesApply(again.raw, [{ groupId: G, communityId: null, channelId: DM, policyVersion: 1n }]))
      .toEqual([{ welcomeId: 1n, groupId: G, outcome: 0, reason: '' }]);
  });

  it('postDm finds or opens a DM; listDms and getChannel answer participants only', async () => {
    const ds = new ModelDs();
    ds.own(ME.user, ME.device);
    ds.own(PEER.user, PEER.device);
    ds.own(THIRD.user, THIRD.device);
    const mine = ds.routesFor(ME.device);
    const opened = await mine.postDm([PEER.user]);
    expect(opened.created).toBe(true);
    expect(await mine.postDm([PEER.user])).toEqual({ channelId: opened.channelId, created: false });
    expect(await ds.routesFor(PEER.device).listDms()).toEqual([{ channelId: opened.channelId, kind: 3, members: [ME.user, PEER.user] }]);
    expect(await ds.routesFor(THIRD.device).listDms()).toEqual([]);
    await expect(ds.routesFor(THIRD.device).getChannel(opened.channelId)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    await expect(mine.postDm([ME.user])).rejects.toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
  });

  it('a device that holds no leaf reads 404 from messages, handshakes and proposals', async () => {
    const ds = new ModelDs();
    const g = ds.peerCreate(PEER, CHANNEL);
    const stranger = ds.routesFor(ME.device);
    await expect(stranger.getMessages(g, 1n, 10)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    await expect(stranger.getHandshakes(g, 1n, 10)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    await expect(stranger.getProposals(g)).rejects.toMatchObject({ status: 404, code: 'E_NOT_FOUND' });
    ds.join(g, ME.device);
    expect((await stranger.getMessages(g, 1n, 10)).count).toBe(0);
    expect(arr(decode(await stranger.getProposals(g)))).toEqual([]);
  });

  it('refuses a registration and an external join by a device its user has not listed', async () => {
    const ds = new ModelDs();
    ds.own(ME.user, ME.device);
    ds.own(ME.user, NEW);
    expect(ds.publishList(ME.user, [{ device: ME.device }])).toBe(1n);
    const g = ds.peerCreate(PEER, CHANNEL_2);
    const newRoutes = ds.routesFor(NEW);
    const core = new ModelCore({ device: NEW, user: ME.user });
    await expect(newRoutes.postGroup(core.groupCreate(G, COMMUNITY, CHANNEL))).rejects.toMatchObject({ status: 400, code: 'E_INVALID_REQUEST' });
    const resync = encode([wire.commit(1n, NEW, [NEW], []), wire.info(g, 1n)]);
    await expect(newRoutes.postResync(g, resync)).rejects.toMatchObject({ status: 422, code: 'E_COMMIT_INVALID', extra: ['external_joiner'] });
    expect(ds.view(g).members).toEqual([toHex(PEER.device)]);
    expect(ds.publishList(ME.user, [{ device: ME.device }, { device: NEW }])).toBe(2n);
    expect((await newRoutes.postResync(g, resync)).epoch).toBe(1n);
    // A device whose owner the model does not know is admitted, as in web-1.
    const g2 = ds.peerCreate(PEER, CHANNEL_3);
    expect((await ds.routesFor(THIRD.device).postResync(g2, encode([wire.commit(1n, THIRD.device, [THIRD.device], []), wire.info(g2, 1n)]))).epoch).toBe(1n);
  });

  it('putDeviceList takes only the next version, and a revocation removes the device from every group', async () => {
    const ds = new ModelDs();
    ds.own(ME.user, ME.device);
    ds.own(ME.user, NEW);
    const body = (v: bigint, entries: { deviceId: Id; revokedAt: bigint | null }[]) =>
      encode([v, fakeListBlob(ME.user, entries, 1_800_000_000n), new Uint8Array(64), new Uint8Array(32)]);
    const mine = ds.routesFor(ME.device);
    await expect(mine.putDeviceList(ME.user, body(2n, []))).rejects.toMatchObject({ status: 409, code: 'E_INVALID_REQUEST' });
    await mine.putDeviceList(ME.user, body(1n, [{ deviceId: ME.device, revokedAt: null }, { deviceId: NEW, revokedAt: null }]));
    await expect(mine.putDeviceList(PEER.user, body(1n, []))).rejects.toMatchObject({ status: 403, code: 'E_FORBIDDEN' });
    const g = ds.peerCreate(PEER, CHANNEL);
    ds.join(g, NEW);
    await mine.putDeviceList(ME.user, body(2n, [{ deviceId: ME.device, revokedAt: null }, { deviceId: NEW, revokedAt: 1_800_000_100n }]));
    expect((await mine.getDeviceList(ME.user))?.version).toBe(2n);
    const history = await mine.getDeviceListHistory(ME.user, 0n);
    expect([history.count, history.lastVersion]).toEqual([2, 2n]);
    expect((await mine.getDeviceListHistory(ME.user, 2n)).count).toBe(0);
    const props = arr(decode(await ds.routesFor(PEER.device).getProposals(g)));
    expect(props).toHaveLength(1);
    const p = arr(decode(bin(at(arr(at(props, 0), 5), 3))), 4);
    expect([at(p, 2), bin(at(p, 3), 16)]).toEqual(['remove', NEW]);
    await expect(ds.routesFor(NEW).getMessages(g, 1n, 10)).rejects.toMatchObject({ status: 401, code: 'E_UNAUTHENTICATED' });
  });
});
