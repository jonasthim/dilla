import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arr, bin, decode, encode, type CborInput } from '../../cbor';
import type { Id } from '../../core-port';
import { CHANNEL, COMMUNITY, FOLD_TARGET, ME, ModelCore, ModelDs, PEER, at, idOf } from './model';

interface FoldRow { seq: number; what: string; }
type ViewEntry = [number, number, string, number, [string, number, number][], number];
interface FoldCase { name: string; rows: FoldRow[]; through: number; view: ViewEntry[]; hidden: number[]; }
interface FoldFixture { v: number; cases: FoldCase[]; }

const fixture = JSON.parse(
  readFileSync(new URL('../../../../../core/dilla-core/tests/fixtures/fold_parity.json', import.meta.url), 'utf8'),
) as FoldFixture;

const G = idOf(0x9c, 1);

/** The common start of parity.test.ts: me registered, PEER joined by external commit at seq 1, me applied it (epoch 1). */
async function commonStart(): Promise<ModelCore> {
  const ds = new ModelDs();
  ds.addChannel(COMMUNITY, CHANNEL);
  const core = new ModelCore(ME);
  const routes = ds.routesFor(ME.device);
  const { nextSeq } = await routes.postGroup(core.groupCreate(G, COMMUNITY, CHANNEL));
  core.groupRegistered(G, nextSeq);
  expect(ds.peerJoin(G, PEER)).toBe(1n);
  core.groupApply(G, (await routes.getHandshakes(G, 1n, 512)).raw, encode([]), 1n);
  expect(core.group(G)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 2n });
  return core;
}

function framed(messageBody: Uint8Array): Uint8Array {
  return bin(at(arr(decode(messageBody), 2), 1));
}

/**
 * L-CORE-39's build rule (A2, peer-client 2): rows are built in order; before an own fold row the rows built so far are
 * applied with `groupApply(…, its seq − 1n)`; it is then prepared (`sendPrepare` with `{ type: 3, replyTo: target,
 * body: '👍', attachments: [] }`), framed and its echo queued; the final `groupApply(…, through)` adopts it.
 */
function run(core: ModelCore, c: FoldCase): void {
  let target: Id = FOLD_TARGET;
  let batch: CborInput[] = [];
  for (const r of c.rows) {
    const seq = BigInt(r.seq);
    switch (r.what) {
      case 'peer-target': batch.push(ModelDs.row.peerTarget(seq, 1n)); break;
      case 'own-target':
        target = core.sendPrepare(G, { type: 0, replyTo: null, body: 'my target', attachments: [] }, 1n);
        batch.push(ModelDs.row.ownEcho(seq, 1n, framed(core.sendEncrypt(target).messageBody)));
        break;
      case 'peer-edit': batch.push(ModelDs.row.peerEdit(seq, 1n, target)); break;
      case 'peer-react': batch.push(ModelDs.row.peerReact(seq, 1n, target)); break;
      case 'peer-unreact': batch.push(ModelDs.row.peerUnreact(seq, 1n, target)); break;
      case 'peer-delete': batch.push(ModelDs.row.peerDelete(seq, 1n, target)); break;
      case 'peer-pin': batch.push(ModelDs.row.peerPin(seq, 1n, target)); break;
      case 'peer-react-unheld': batch.push(ModelDs.row.peerReactUnheld(seq, 1n)); break;
      case 'own-react': {
        core.groupApply(G, encode([]), encode(batch), seq - 1n);
        batch = [];
        const id = core.sendPrepare(G, { type: 3, replyTo: target, body: '👍', attachments: [] }, 2n);
        batch.push(ModelDs.row.ownEcho(seq, 1n, framed(core.sendEncrypt(id).messageBody)));
        break;
      }
      default:
        throw new Error(`unknown what: ${r.what}`);
    }
  }
  core.groupApply(G, encode([]), encode(batch), BigInt(c.through));
}

describe('the fold parity fixture (L-CORE-39)', () => {
  it('is version 1 with exactly seven cases', () => {
    expect(fixture.v).toBe(1);
    expect(fixture.cases).toHaveLength(7);
  });

  for (const c of fixture.cases) {
    it(`model: ${c.name}`, async () => {
      const core = await commonStart();
      run(core, c);
      const rows = core.timeline(G, 0n, 200);
      for (const [seq, status, body, editedSeq, reactions, pinned] of c.view) {
        const row = rows.find((x) => x.seq === BigInt(seq));
        if (row === undefined) throw new Error(`no displayable row at seq ${String(seq)}`);
        expect([row.status, row.body, row.editedSeq, row.reactions.map((x) => [x.emoji, x.count, x.mine ? 1 : 0]), row.pinned ? 1 : 0])
          .toEqual([status, body, BigInt(editedSeq), reactions, pinned]);
      }
      expect(rows.filter((x) => c.hidden.includes(Number(x.seq))).map((x) => x.seq)).toEqual([]);
    });
  }
});

/**
 * The security ruling of 2026-10-07 (lead-fold-spoofing.md): a fold counts only when its seq is above its target's, and
 * a type 0 whose msg id a lower-seq stored row already names is a repeat, never a target. The core gains the same rule
 * in the core-block fix wave, which adds these two cases to fold_parity.json; until then they hold the model alone.
 */
describe('the fold seq bound (lead-fold-spoofing)', () => {
  const MALLORY = { device: idOf(0xd0, 6), user: idOf(0xe0, 6) };

  it('model: a reaction at seq 3 naming a target held at seq 5 is ignored', async () => {
    const core = await commonStart();
    core.groupApply(G, encode([]), encode([ModelDs.row.peerReact(3n, 1n, FOLD_TARGET), ModelDs.row.peerTarget(5n, 1n)]), 5n);
    const row = core.timeline(G, 0n, 200).find((x) => x.seq === 5n);
    expect([row?.status, row?.body, row?.editedSeq, row?.reactions, row?.pinned]).toEqual([0, 'the target', 0n, [], false]);
  });

  it('model: a type-0 repeat at seq 9 of a msg id a held row already names is not a target', async () => {
    const core = await commonStart();
    const X = idOf(0x78, 1);
    core.groupApply(G, encode([]), encode([
      // The original X, deleted before this device read it: held with no msg id, so X itself is not held.
      ModelDs.row.deleted(2n, 1n),
      ModelDs.row.peerReact(3n, 1n, X), ModelDs.row.peerPin(4n, 1n, X),
      ModelDs.row.app(5n, 1n, MALLORY, idOf(0x7f, 5), 'a reply to X', { replyTo: X }),
      ModelDs.row.app(9n, 1n, MALLORY, X, 'a repeat of X'),
    ]), 9n);
    const rows = core.timeline(G, 0n, 200);
    const repeat = rows.find((x) => x.seq === 9n);
    expect([repeat?.status, repeat?.body, repeat?.reactions, repeat?.pinned]).toEqual([0, 'a repeat of X', [], false]);
    expect(rows.find((x) => x.seq === 5n)?.reply).toEqual({ replyTo: X, targetSeq: null, targetUser: null, excerpt: '', state: 1 });
    expect(core.pins(G)).toEqual([]);
  });
});
