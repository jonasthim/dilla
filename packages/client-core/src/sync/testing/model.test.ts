import { describe, expect, it } from 'vitest';
import { arr, bin, decode, encode, type CborInput } from '../../cbor';
import type { AttachmentDescriptor, ExpectedGroup, Id, SendRequest, TimelineRow } from '../../core-port';
import { CHANNEL, CHANNEL_2, COMMUNITY, FOLD_TARGET, FOLD_UNHELD, ME, ModelCore, ModelDs, PEER, THIRD, at, idOf, wire, textRequest, type Peer } from './model';

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
    expect(thrown(() => core.sendPrepare(G, textRequest('€'.repeat(1334)), 1n))).toMatchObject({ code: 'E_ENVELOPE_LIMIT' }); // 4002 bytes
    expect(core.outbox(G)).toEqual([]);
    const id = core.sendPrepare(G, textRequest('€'.repeat(1333)), 1n); // 3999 bytes
    expect(core.outbox(G).map((r) => r.msgId)).toEqual([id]);
  });

  it('sendEncrypt refuses with E_CORE_STATE while a proposal is pending, and changes nothing', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([[1n, 0n, 0n, null, wire.prop(idOf(0x5e, 1), 'add', THIRD.device)]]), encode([]), 1n);
    expect(core.group(G)?.proposalsPending).toBe(1);
    const id = core.sendPrepare(G, textRequest('held'), 1n);
    expect(thrown(() => core.sendEncrypt(id))).toMatchObject({ code: 'E_CORE_STATE', detail: 'proposals are pending' });
    expect(core.outbox(G).map((r) => r.state)).toEqual([0]);
  });

  it('sendEncrypt refuses with E_CORE_STATE while a commit is pending', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.commitBuild(G, encode([]));
    expect(core.group(G)).toMatchObject({ pendingCommit: true, proposalsPending: 0 });
    const id = core.sendPrepare(G, textRequest('held'), 1n);
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
    const m = core.sendPrepare(G, textRequest('mine'), 1n);
    core.sendEncrypt(m);
    expect(core.sendConfirm(m, encode([3n, new Uint8Array(32), 1_700_000_003n]))).toEqual({ groupId: G, seq: 3n }); // ahead of nextSeq
    const r = core.groupApply(G, encode([]), encode([peerMsg(2n, 'two'), peerMsg(3n, 'served twice')]), 3n);
    expect(r).toMatchObject({ newSeqs: [2n], nextSeq: 4n, ownAdopted: false });
    expect(core.timeline(G, 0n, 200).map((x) => [x.seq, x.status, x.body])).toEqual([[2n, 0, 'two'], [3n, 0, 'mine']]);
  });

  it('adopts a failed row and a queued row whose commitment the echo carries', () => {
    const core = new ModelCore(ME);
    registered(core);
    const failed = core.sendPrepare(G, textRequest('failed'), 1n);
    const failedBlob = blobOf(core.sendEncrypt(failed)); // stored by the server; its answer was lost
    core.sendFail(failed, 'E_NETWORK');
    const queued = core.sendPrepare(G, textRequest('queued'), 2n);
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
    const m = core.sendPrepare(G, textRequest('in flight'), 1n);
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
    const m = core.sendPrepare(G, textRequest('gone soon'), 1n);
    core.sendEncrypt(m);
    const r = core.groupApply(G, encode([]), encode([[1n, 0n, ME.device, null, wire.commitment(m), new Uint8Array(32), 1_700_000_001n, 1]]), 1n);
    expect(r).toMatchObject({ newSeqs: [1n], ownAdopted: true });
    expect(core.timeline(G, 0n, 200)).toMatchObject([{ seq: 1n, status: 2, body: '', senderUser: ME.user, senderDevice: ME.device, msgId: m }]);
    expect(core.outbox(G)).toEqual([]);
    expect(core.sendConfirm(m, encode([1n, new Uint8Array(32), 1_700_000_001n]))).toEqual({ groupId: G, seq: 1n }); // read back
    const m2 = core.sendPrepare(G, textRequest('unplaced'), 2n);
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
    const m = core.sendPrepare(G, textRequest('mine'), 1n);
    core.sendEncrypt(m);
    expect(thrown(() => core.sendConfirm(m, encode([1n, new Uint8Array(32), 1_700_000_001n])))).toMatchObject({
      code: 'E_CORE_STATE', detail: 'message seq exists',
    });
    expect(core.outbox(G)).toMatchObject([{ msgId: m, state: 2, error: 'E_CORE_STATE', body: 'mine' }]);
    expect(core.bodies(G)).toEqual(['theirs']);
    expect(thrown(() => core.sendFail(m, 'E_NETWORK'))).toMatchObject({ code: 'E_CORE_STATE' });
    expect(core.sendEncrypt(core.sendPrepare(G, textRequest('next'), 2n)).groupId).toEqual(G);
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
    // CORE-ENGINE-03: as groups.rs writes it, epoch 0 (the old MLS group was already replaced); the floor stays.
    expect(core.group(G)).toMatchObject({ state: 3, epoch: 0n });
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
    const msg = core.sendPrepare(G, textRequest('framed first'), 1n);
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
    const own = core.sendPrepare(G, textRequest('mine <@everyone>'), 1n);
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
  it('answers the web-2b timeline row: fold fields at their defaults and the mention flag (L-CORE-34)', () => {
    const core = new ModelCore(ME);
    registered(core);
    core.groupApply(G, encode([]), encode([peerMsg(1n, 'plain'), peerMsg(2n, `hi <@${toHex(ME.user)}>`)]), 2n);
    expect(core.timeline(G, 0n, 200).map((x) => [x.seq, x.editedSeq, x.reply, x.reactions, x.pinned, x.attachments, x.mention])).toEqual([
      [1n, 0n, null, [], false, [], false],
      [2n, 0n, null, [], false, [], true],
    ]);
  });

});

describe('ModelCore sends a plain message as web-2a did', () => {
  it('lists it with the eight-field outbox row', () => {
    const core = new ModelCore(ME);
    registered(core);
    const id = core.sendPrepare(G, textRequest('plain'), 5n);
    expect(core.outbox(G)).toEqual([{ msgId: id, state: 0, error: '', created: 5n, body: 'plain', type: 0, replyTo: null, attachments: [] }]);
  });
});

const MY_OTHER: Peer = { device: idOf(0xd0, 8), user: ME.user };
const PEER_OTHER: Peer = { device: idOf(0xd0, 9), user: PEER.user };
const THIRD_OTHER: Peer = { device: idOf(0xd0, 10), user: THIRD.user };
const T = FOLD_TARGET;
const T2 = new Uint8Array(16).fill(0x72);
const ROLE = idOf(0x40, 1);
const FILE: AttachmentDescriptor = {
  blobId: new Uint8Array(32).fill(0x43), key: new Uint8Array(32).fill(0x44), nonce: new Uint8Array(12).fill(0x45), size: 1234,
  mime: 'image/png', w: 640, h: 480, thumb: new Uint8Array(40).fill(0x46), name: 'map.png',
};
const fold = (seq: bigint): Id => idOf(0x7f, Number(seq));

function app(seq: bigint, from: Peer, msgId: Id, body: string, opts: { type?: number; replyTo?: Id | null; attachments?: AttachmentDescriptor[] } = {}): CborInput[] {
  return ModelDs.row.app(seq, 0n, from, msgId, body, opts);
}
function apply(core: ModelCore, ...rows: CborInput[][]): void {
  const through = rows.reduce((m, r) => ((r[0] as bigint) > m ? (r[0] as bigint) : m), 0n);
  core.groupApply(G, encode([]), encode(rows), through);
}
function request(type: SendRequest['type'], replyTo: Id | null, body = '', attachments: AttachmentDescriptor[] = []): SendRequest {
  return { type, replyTo, body, attachments };
}
/** Prepares and frames an own row and applies its echo at `seq`, as the delivery service serves it. */
function own(core: ModelCore, seq: bigint, r: SendRequest): Id {
  const msgId = core.sendPrepare(G, r, seq);
  apply(core, ModelDs.row.ownEcho(seq, 0n, blobOf(core.sendEncrypt(msgId))));
  return msgId;
}
function shown(core: ModelCore, seq: bigint): TimelineRow {
  const r = core.timeline(G, 0n, 200).find((x) => x.seq === seq);
  if (r === undefined) throw new Error(`no displayable row at seq ${String(seq)}`);
  return r;
}
function fresh(): ModelCore {
  const core = new ModelCore(ME);
  registered(core);
  return core;
}

describe('ModelCore folds envelope types 1–6 as the core does (L-CORE-33, L-CORE-34)', () => {
  it('stores and lists fold rows but shows only displayable rows', () => {
    const core = fresh();
    const r = core.groupApply(G, encode([]), encode([app(1n, PEER, T, 'the target'), app(2n, PEER, fold(2n), '👍', { type: 3, replyTo: T })]), 2n);
    expect(r.newSeqs).toEqual([1n, 2n]);
    expect(core.timeline(G, 0n, 200).map((x) => x.seq)).toEqual([1n]);
    expect(shown(core, 1n).reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('applies an edit from the author\'s other device', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'v1'), app(2n, PEER_OTHER, fold(2n), 'v2', { type: 1, replyTo: T }));
    expect(shown(core, 1n)).toMatchObject({ status: 0, body: 'v2', editedSeq: 2n });
  });

  it('applies the author\'s highest-seq edit, and no edit sequenced before its target (lead-fold-spoofing)', () => {
    const core = fresh();
    apply(core, app(1n, PEER, fold(1n), 'early', { type: 1, replyTo: T }), app(2n, PEER, fold(2n), 'later', { type: 1, replyTo: T }),
      app(3n, THIRD, fold(3n), 'not the author', { type: 1, replyTo: T }));
    expect(core.timeline(G, 0n, 200)).toEqual([]);
    apply(core, app(4n, PEER, T, 'original'));
    // The security ruling of 2026-10-07 binds over the plan's { body: 'later', editedSeq: 2n }: a fold counts only when
    // its seq is above its target's, so the edits at seq 1 and 2 never apply to the target at seq 4.
    expect(shown(core, 4n)).toMatchObject({ body: 'original', editedSeq: 0n });
    apply(core, app(5n, PEER, T2, 'second'), app(6n, PEER, fold(6n), 'early', { type: 1, replyTo: T2 }),
      app(7n, PEER, fold(7n), 'later', { type: 1, replyTo: T2 }), app(8n, THIRD, fold(8n), 'not the author', { type: 1, replyTo: T2 }));
    expect(shown(core, 5n)).toMatchObject({ body: 'later', editedSeq: 7n });
  });

  it('ignores a delete by another user', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'kept'), app(2n, THIRD, fold(2n), '', { type: 2, replyTo: T }));
    expect(shown(core, 1n)).toMatchObject({ status: 0, body: 'kept' });
  });

  it('lets a delete by the author remove the target with its edits, reactions and pin, and records no purge for a peer', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'gone soon'), app(2n, THIRD, fold(2n), '👍', { type: 3, replyTo: T }),
      app(3n, THIRD, fold(3n), '', { type: 5, replyTo: T }), app(4n, PEER, fold(4n), 'edited', { type: 1, replyTo: T }),
      app(5n, PEER_OTHER, fold(5n), '', { type: 2, replyTo: T }));
    expect(shown(core, 1n)).toMatchObject({ status: 2, body: '', editedSeq: 0n, reactions: [], pinned: false, attachments: [], reply: null });
    expect(core.pins(G)).toEqual([]);
    expect(core.purges()).toEqual([]);
  });

  it('keeps reactions per user: two devices of one user make one chip', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, THIRD, fold(2n), '👍', { type: 3, replyTo: T }), app(3n, THIRD_OTHER, fold(3n), '👍', { type: 3, replyTo: T }));
    expect(shown(core, 1n).reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('lets only a reaction\'s own user remove it', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, THIRD, fold(2n), '👍', { type: 3, replyTo: T }), app(3n, PEER, fold(3n), '👍', { type: 4, replyTo: T }));
    expect(shown(core, 1n).reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    apply(core, app(4n, THIRD_OTHER, fold(4n), '👍', { type: 4, replyTo: T }));
    expect(shown(core, 1n).reactions).toEqual([]);
  });

  it('orders chips by first appearance and marks the own reaction', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, PEER, fold(2n), '🔥', { type: 3, replyTo: T }),
      app(3n, THIRD, fold(3n), '👍', { type: 3, replyTo: T }), app(4n, THIRD, fold(4n), '🔥', { type: 3, replyTo: T }));
    own(core, 5n, request(3, T, '👍'));
    expect(shown(core, 1n).reactions).toEqual([{ emoji: '🔥', count: 2, mine: false }, { emoji: '👍', count: 2, mine: true }]);
  });

  it('answers a reply held, not held and deleted', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'line one\nline two'), app(2n, THIRD, fold(2n), 'a reply', { replyTo: T }),
      app(3n, THIRD, fold(3n), 'to nothing here', { replyTo: FOLD_UNHELD }), app(4n, PEER, T2, 'second'),
      app(5n, THIRD, fold(5n), 'to the second', { replyTo: T2 }), app(6n, PEER, fold(6n), '', { type: 2, replyTo: T2 }));
    expect(shown(core, 2n).reply).toEqual({ replyTo: T, targetSeq: 1n, targetUser: PEER.user, excerpt: 'line one line two', state: 0 });
    expect(shown(core, 3n).reply).toEqual({ replyTo: FOLD_UNHELD, targetSeq: null, targetUser: null, excerpt: '', state: 1 });
    expect(shown(core, 5n).reply).toEqual({ replyTo: T2, targetSeq: 4n, targetUser: PEER.user, excerpt: '', state: 2 });
    expect(shown(core, 1n).reply).toBeNull();
  });

  it('cuts the excerpt at 120 scalar values of the shown body, with line breaks as spaces', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, '😀'.repeat(130)), app(2n, THIRD, fold(2n), 'r', { replyTo: T }), app(3n, PEER, T2, 'old'),
      app(4n, PEER, fold(4n), 'new\r\nbody', { type: 1, replyTo: T2 }), app(5n, THIRD, fold(5n), 'r2', { replyTo: T2 }));
    expect(shown(core, 2n).reply?.excerpt).toBe('😀'.repeat(120));
    expect(shown(core, 5n).reply?.excerpt).toBe('new  body');
  });

  it('accepts a pin from any member; the latest pin or unpin decides; pins list newest first', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'first'), app(2n, THIRD, T2, 'second'), app(3n, THIRD, fold(3n), '', { type: 5, replyTo: T }),
      app(4n, PEER, fold(4n), '', { type: 5, replyTo: T2 }));
    expect(core.pins(G)).toEqual([
      { targetSeq: 2n, msgId: T2, pinnedSeq: 4n, byUser: PEER.user, author: THIRD.user, excerpt: 'second', targetTs: shown(core, 2n).recvTs },
      { targetSeq: 1n, msgId: T, pinnedSeq: 3n, byUser: THIRD.user, author: PEER.user, excerpt: 'first', targetTs: shown(core, 1n).recvTs },
    ]);
    expect([shown(core, 1n).pinned, shown(core, 2n).pinned]).toEqual([true, true]);
    apply(core, app(5n, PEER, fold(5n), '', { type: 6, replyTo: T }));
    expect(core.pins(G).map((p) => p.targetSeq)).toEqual([2n]);
    expect(shown(core, 1n).pinned).toBe(false);
    expect(thrown(() => core.pins(idOf(0x9b, 99)))).toMatchObject({ code: 'E_CORE_NOT_FOUND' });
  });

  it('shows a row that repeats a msg id but never makes it a target, nor gives it the target\'s folds', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'original'), app(2n, THIRD, T, 'a replay of the id'), app(3n, PEER, fold(3n), 'edited', { type: 1, replyTo: T }),
      app(4n, THIRD, fold(4n), '👍', { type: 3, replyTo: T }), app(5n, THIRD, fold(5n), '', { type: 5, replyTo: T }));
    expect(shown(core, 1n)).toMatchObject({ body: 'edited', editedSeq: 3n, reactions: [{ emoji: '👍', count: 1, mine: false }], pinned: true });
    expect(shown(core, 2n)).toMatchObject({ body: 'a replay of the id', editedSeq: 0n, reactions: [], pinned: false });
  });

  it('shows at most twenty reactions, the most counted first (FACTS-SECURITY-02)', () => {
    const core = fresh();
    const rows: CborInput[][] = [app(1n, PEER, T, 't')];
    for (let i = 0; i < 25; i++) rows.push(app(BigInt(2 + i), PEER, fold(BigInt(2 + i)), `r${String(i).padStart(2, '0')}`, { type: 3, replyTo: T }));
    rows.push(app(27n, THIRD, fold(27n), 'r24', { type: 3, replyTo: T }));
    apply(core, ...rows);
    const want = Array.from({ length: 19 }, (_, i) => ({ emoji: `r${String(i).padStart(2, '0')}`, count: 1, mine: false }));
    want.push({ emoji: 'r24', count: 2, mine: false });
    expect(shown(core, 1n).reactions).toEqual(want);
  });

  it('drops the author\'s edits when the author deletes a target this device never held (FACTS-SECURITY-03)', () => {
    const core = fresh();
    apply(core, ModelDs.row.deleted(1n, 0n), app(2n, PEER, fold(2n), 'secret words', { type: 1, replyTo: T }),
      app(3n, THIRD, fold(3n), 'third words', { type: 1, replyTo: T }), app(4n, PEER, fold(4n), '', { type: 2, replyTo: T }));
    expect(core.storedRow(G, 2n)).toEqual({ type: 1, status: 0, body: '', hasEnvelope: false });
    expect(core.storedRow(G, 3n)).toEqual({ type: 1, status: 0, body: 'third words', hasEnvelope: true });
  });

  it('drops a reaction whose row the delivery service deleted by seq', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, THIRD, fold(2n), '👍', { type: 3, replyTo: T }));
    core.messageDeleted(G, 2n);
    expect(shown(core, 1n).reactions).toEqual([]);
  });

  it('blanks a target the delivery service deleted by seq and drops what folded onto it', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, THIRD, fold(2n), '👍', { type: 3, replyTo: T }), app(3n, THIRD, fold(3n), '', { type: 5, replyTo: T }));
    core.messageDeleted(G, 1n);
    expect(shown(core, 1n)).toMatchObject({ status: 2, body: '', reactions: [], pinned: false });
    expect(core.pins(G)).toEqual([]);
  });

  it('flags role mentions for roles known when the row arrives, never backfilled, and refuses a bad role list', () => {
    const core = fresh();
    const role = toHex(ROLE);
    core.ownRolesSet(COMMUNITY, [ROLE]);
    apply(core, app(1n, PEER, idOf(0x7e, 1), `<@${role}> look`));
    core.ownRolesSet(COMMUNITY, []);
    apply(core, app(2n, PEER, idOf(0x7e, 2), `<@${role}> again`));
    expect([shown(core, 1n).mention, shown(core, 2n).mention]).toEqual([true, false]);
    expect(at(core.activity(), 0).mentions).toBe(1);
    const tooMany = Array.from({ length: 65 }, (_, i) => idOf(0x40, i));
    expect(thrown(() => core.ownRolesSet(COMMUNITY, tooMany))).toMatchObject({ code: 'E_CORE_INPUT', detail: 'role_ids must be 0..=64 ids of 16 bytes' });
    expect(thrown(() => core.ownRolesSet(COMMUNITY, [new Uint8Array(15)]))).toMatchObject({ code: 'E_CORE_INPUT', detail: 'role_ids must be 0..=64 ids of 16 bytes' });
  });

  it('never raises a mention through an edit', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'hello'), app(2n, PEER, fold(2n), `<@${toHex(ME.user)}> hello`, { type: 1, replyTo: T }));
    expect(shown(core, 1n)).toMatchObject({ body: `<@${toHex(ME.user)}> hello`, mention: false });
    expect(at(core.activity(), 0).mentions).toBe(0);
  });

  it('reads a fold row without a target or with files as a row it cannot read (E_ENVELOPE_SHAPE)', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, PEER, fold(2n), 'x', { type: 1 }), app(3n, PEER, fold(3n), '👍', { type: 3, replyTo: T, attachments: [FILE] }));
    expect(core.unreadable(G)).toEqual([{ seq: 2n, reason: 'E_ENVELOPE_SHAPE' }, { seq: 3n, reason: 'E_ENVELOPE_SHAPE' }]);
    expect(shown(core, 1n)).toMatchObject({ body: 't', reactions: [] });
  });
});

describe('ModelCore sends every type as the core does (L-CORE-36…38)', () => {
  it('refuses every send_prepare rule with its code and detail and writes nothing', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'theirs'), app(2n, PEER, T2, 'deleted'), app(3n, PEER, fold(3n), '', { type: 2, replyTo: T2 }));
    const mine = own(core, 4n, request(0, null, 'mine'));
    const cases: [SendRequest, string, string][] = [
      [request(0, null, 'x', [{ ...FILE, key: new Uint8Array(31) }]), 'E_CORE_INPUT', 'request is malformed'],
      [request(7 as unknown as SendRequest['type'], null, 'x'), 'E_CORE_INPUT', 'type is out of range'],
      [request(1, mine, 'x', [FILE]), 'E_CORE_INPUT', 'only a message carries attachments'],
      [request(0, null, '  \n'), 'E_CORE_INPUT', 'body is empty'],
      [request(0, FOLD_UNHELD, 'x'), 'E_CORE_NOT_FOUND', 'target is not held'],
      [request(3, null, '👍'), 'E_CORE_INPUT', 'reply_to is required'],
      [request(3, FOLD_UNHELD, '👍'), 'E_CORE_NOT_FOUND', 'target is not held'],
      [request(3, T2, '👍'), 'E_CORE_STATE', 'the target is deleted'],
      [request(1, T, 'mine now'), 'E_CORE_INPUT', 'only the author may edit or delete'],
      [request(2, T), 'E_CORE_INPUT', 'only the author may edit or delete'],
      [request(1, mine, ' '), 'E_CORE_INPUT', 'body is empty'],
      [request(3, T, ''), 'E_CORE_INPUT', 'emoji must be 1..=32 bytes'],
      [request(4, T, 'x'.repeat(33)), 'E_CORE_INPUT', 'emoji must be 1..=32 bytes'],
      [request(5, T, 'x'), 'E_CORE_INPUT', 'body must be empty'],
      [request(6, T, 'x'), 'E_CORE_INPUT', 'body must be empty'],
      [request(2, mine, 'x'), 'E_CORE_INPUT', 'body must be empty'],
      [request(0, null, 'x', [FILE, FILE, FILE, FILE, FILE]), 'E_ENVELOPE_LIMIT', ''],
      [request(0, null, 'x', [{ ...FILE, name: 'n'.repeat(256) }]), 'E_ENVELOPE_LIMIT', ''],
      [request(0, null, 'x', [{ ...FILE, mime: 'm'.repeat(256) }]), 'E_ENVELOPE_LIMIT', ''],
      [request(0, null, '€'.repeat(1334)), 'E_ENVELOPE_LIMIT', ''],
    ];
    for (const [r, code, detail] of cases) {
      expect(thrown(() => core.sendPrepare(G, r, 9n)), `${String(r.type)} ${code} ${detail}`).toMatchObject({ code, detail });
      expect(core.outbox(G)).toEqual([]);
    }
    for (const r of [request(0, null, '', [FILE]), request(3, T, '👍'), request(5, T), request(1, mine, 'better'), request(2, mine), request(0, T, 'a reply')]) {
      core.sendPrepare(G, r, 9n);
    }
    expect(core.outbox(G).map((o) => o.type)).toEqual([0, 3, 5, 1, 2, 0]);
    // ADJ-01 (lesson f): the type check precedes the group check, as in the core (L-CORE-36 as amended, A8).
    const unknownGroup = new ModelCore(ME);
    expect(thrown(() => unknownGroup.sendPrepare(G, request(9 as unknown as SendRequest['type'], null, 'x'), 9n)))
      .toMatchObject({ code: 'E_CORE_INPUT', detail: 'type is out of range' });
    const notJoined = new ModelCore(ME);
    notJoined.groupCreate(G, COMMUNITY, CHANNEL);
    expect(thrown(() => notJoined.sendPrepare(G, request(9 as unknown as SendRequest['type'], null, 'x'), 9n)))
      .toMatchObject({ code: 'E_CORE_INPUT', detail: 'type is out of range' });
    expect(notJoined.outbox(G)).toEqual([]);
    expect(thrown(() => notJoined.sendPrepare(G, request(0, null, 'x'), 9n))).toMatchObject({ code: 'E_CORE_STATE' });
  });

  it('keeps type, reply and attachment summaries in the outbox, never a key', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 'theirs'));
    const id = core.sendPrepare(G, request(0, T, 'with a file', [FILE]), 5n);
    expect(core.outbox(G)).toEqual([{ msgId: id, state: 0, error: '', created: 5n, body: 'with a file', type: 0, replyTo: T,
      attachments: [{ blobId: FILE.blobId, size: 1234, mime: 'image/png', name: 'map.png' }] }]);
    expect(Object.keys(at(at(core.outbox(G), 0).attachments, 0))).toEqual(['blobId', 'size', 'mime', 'name']);
  });

  it('answers the full descriptor of a held message and refuses anything else', () => {
    const core = fresh();
    apply(core, app(1n, PEER, T, 't'), app(2n, PEER, fold(2n), '👍', { type: 3, replyTo: T }));
    own(core, 3n, request(0, null, '', [FILE]));
    expect(core.attachmentGet(G, 3n, 0)).toEqual(FILE);
    expect(shown(core, 3n).attachments).toEqual([{ index: 0, size: 1234, mime: 'image/png', w: 640, h: 480, hasThumb: true, name: 'map.png' }]);
    for (const [seq, index] of [[3n, 1], [2n, 0], [1n, 0], [99n, 0]] as const) {
      expect(thrown(() => core.attachmentGet(G, seq, index))).toMatchObject({ code: 'E_CORE_NOT_FOUND', detail: 'no such attachment' });
    }
  });

  it('records one purge for the sending device\'s own delete, adopted from its echo, and purgeDone clears it', () => {
    const core = fresh();
    const target = own(core, 1n, request(0, null, 'with a file', [FILE]));
    expect(core.purges()).toEqual([]);
    own(core, 2n, request(2, target));
    expect(shown(core, 1n)).toMatchObject({ status: 2, body: '', attachments: [] });
    expect(core.purges()).toEqual([{ groupId: G, seq: 1n, channelId: CHANNEL, blobIds: [FILE.blobId] }]);
    core.messageDeleted(G, 1n);
    expect(core.purges()).toHaveLength(1);
    core.purgeDone(G, 1n);
    expect(core.purges()).toEqual([]);
    core.purgeDone(G, 1n);
    expect(core.purges()).toEqual([]);
  });

  it('records the purge when the delete is confirmed by the upload answer', () => {
    const core = fresh();
    const target = own(core, 1n, request(0, null, 'x', [FILE]));
    const del = core.sendPrepare(G, request(2, target), 2n);
    core.sendEncrypt(del);
    core.sendConfirm(del, encode([2n, new Uint8Array(32), 1_700_000_002n]));
    expect(core.purges()).toEqual([{ groupId: G, seq: 1n, channelId: CHANNEL, blobIds: [FILE.blobId] }]);
  });

  it('records no purge for a delete from the own user\'s other device', () => {
    const core = fresh();
    const target = own(core, 1n, request(0, null, 'mine', [FILE]));
    apply(core, app(2n, MY_OTHER, fold(2n), '', { type: 2, replyTo: target }));
    expect(shown(core, 1n).status).toBe(2);
    expect(core.purges()).toEqual([]);
  });
});

describe('ModelDs answers the message delete as the delivery service does (L-HTTP-80)', () => {
  function world() {
    const ds = new ModelDs();
    for (const p of [ME, MY_OTHER, PEER, THIRD]) ds.own(p.user, p.device);
    ds.addChannel(COMMUNITY, CHANNEL);
    const g = ds.peerCreate(PEER, CHANNEL);
    ds.join(g, ME.device);
    ds.join(g, MY_OTHER.device);
    const frames: Frame[] = [];
    ds.attach(PEER.device, (f) => { frames.push(f); });
    const mine = ds.peerSend(g, ME, 'mine');
    const theirs = ds.peerSend(g, PEER, 'theirs');
    return { ds, g, frames, mine, theirs };
  }

  it('deletes for any member device of the uploading user, tombstones the row and fans out op 21', async () => {
    const { ds, g, frames, mine, theirs } = world();
    expect(await ds.routesFor(MY_OTHER.device).deleteGroupMessage(g, mine)).toBe('deleted');
    expect(ds.view(g).messages.map((m) => m.seq)).toEqual([theirs]);
    const op21 = frames.filter((f) => f.op === 21);
    expect(op21).toHaveLength(1);
    expect(at(at(op21, 0).payload, 0)).toBe(mine);
    const page = arr(decode((await ds.routesFor(PEER.device).getMessages(g, mine, 10)).raw));
    expect(at(arr(at(page, 0), 8), 7)).toBe(1n);
    // A second delete of the tombstoned row is 204 and fans out again, as dillad's no-op tombstone update does.
    expect(await ds.routesFor(ME.device).deleteGroupMessage(g, mine)).toBe('deleted');
    expect(frames.filter((f) => f.op === 21)).toHaveLength(2);
  });

  it('refuses another user\'s upload 403 E_NOT_UPLOADER and answers an unknown seq as gone', async () => {
    const { ds, g, theirs } = world();
    await expect(ds.routesFor(ME.device).deleteGroupMessage(g, theirs)).rejects.toMatchObject({ status: 403, code: 'E_NOT_UPLOADER' });
    expect(ds.view(g).messages.map((m) => m.seq)).toContain(theirs);
    expect(await ds.routesFor(ME.device).deleteGroupMessage(g, 99n)).toBe('gone');
  });

  // Attacker statement (L-HTTP-80): this 404 hits only a device that is no longer in the group; the uploader's other
  // member devices can still delete, and no honest delete comes from a removed device.
  it('answers a device that is not a member 404 (gone), even when its own user uploaded the message', async () => {
    const { ds, g, frames, mine } = world();
    ds.evict(g, MY_OTHER.device);
    expect(await ds.routesFor(MY_OTHER.device).deleteGroupMessage(g, mine)).toBe('gone');
    expect(await ds.routesFor(THIRD.device).deleteGroupMessage(g, mine)).toBe('gone');
    expect(ds.view(g).messages.map((m) => m.seq)).toContain(mine);
    expect(frames.filter((f) => f.op === 21)).toEqual([]);
    expect(ds.deleteAs(g, MY_OTHER.device, mine)).toBe(404);
    expect(ds.deleteAs(idOf(0x9a, 77), ME.device, mine)).toBe(404);
  });
});
