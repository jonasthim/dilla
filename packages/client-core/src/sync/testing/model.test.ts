import { describe, expect, it } from 'vitest';
import { arr, bin, decode, encode, type CborInput } from '../../cbor';
import type { ExpectedGroup, Id } from '../../core-port';
import { CHANNEL, CHANNEL_2, COMMUNITY, ME, ModelCore, ModelDs, PEER, THIRD, at, idOf, wire } from './model';

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
