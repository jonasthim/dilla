import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { arr, bin, decode, encode, type CborInput } from '../../cbor';
import { wrapCore, type ApplyResult, type CoreHandle } from '../../core-port';
import { fromHex } from '../../hex';
import { CHANNEL, COMMUNITY, ME, ModelCore, textRequest, ModelDs, PEER, at, idOf } from './model';

interface ParityRow {
  stream: 'h' | 'm';
  seq: number;
  what: string;
}
interface ParityCase {
  name: string;
  rows: ParityRow[];
  through: number;
  expect: { state: number; epoch: number; next_seq: number; new_seqs: number[]; proposals_pending: number; flags: number };
  result: string;
}
interface ParityFixture {
  v: number;
  cases: ParityCase[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../../core/dilla-core/tests/fixtures/group_apply_parity.json', import.meta.url), 'utf8'),
) as ParityFixture;

const G = idOf(0x9c, 1);

function expected(c: ParityCase): ApplyResult {
  const e = c.expect;
  return {
    state: e.state as ApplyResult['state'],
    epoch: BigInt(e.epoch),
    nextSeq: BigInt(e.next_seq),
    newSeqs: e.new_seqs.map((n) => BigInt(n)),
    proposalsPending: e.proposals_pending,
    epochChanged: (e.flags & 1) === 1,
    ownAdopted: (e.flags & 2) === 2,
  };
}

/** The common start of every case: me registered (next_seq 1), PEER joined by external commit at seq 1, me applied it. */
async function commonStart(): Promise<ModelCore> {
  const ds = new ModelDs();
  ds.addChannel(COMMUNITY, CHANNEL);
  const core = new ModelCore(ME);
  const routes = ds.routesFor(ME.device);
  const { nextSeq } = await routes.postGroup(core.groupCreate(G, COMMUNITY, CHANNEL));
  expect(nextSeq).toBe(1n);
  core.groupRegistered(G, nextSeq);
  expect(ds.peerJoin(G, PEER)).toBe(1n);
  const hs = await routes.getHandshakes(G, 1n, 512);
  core.groupApply(G, hs.raw, encode([]), 1n);
  expect(core.group(G)).toMatchObject({ state: 2, epoch: 1n, nextSeq: 2n, proposalsPending: 0, pendingCommit: false });
  expect(core.outbox(G)).toEqual([]);
  return core;
}

/** The case's rows, in the fixture's order; each framed in the epoch current at its seq (1 + earlier peer commits). */
function rowsOf(core: ModelCore, c: ParityCase): { handshakes: CborInput[]; messages: CborInput[] } {
  const handshakes: CborInput[] = [];
  const messages: CborInput[] = [];
  for (const r of c.rows) {
    const seq = BigInt(r.seq);
    const epoch = 1n + BigInt(c.rows.filter((x) => x.what === 'peer-commit' && x.seq < r.seq).length);
    const into = r.stream === 'h' ? handshakes : messages;
    switch (r.what) {
      case 'peer-message':
        into.push(ModelDs.row.peerMessage(seq, epoch));
        break;
      case 'peer-commit':
        into.push(ModelDs.row.peerCommit(seq, epoch));
        break;
      case 'bad-commit':
        into.push(ModelDs.row.badCommit(seq, epoch));
        break;
      case 'own-echo': {
        const sent = core.sendEncrypt(core.sendPrepare(G, textRequest('parity echo'), 1n));
        into.push(ModelDs.row.ownEcho(seq, epoch, bin(at(arr(decode(sent.messageBody), 2), 1))));
        break;
      }
      case 'pruned':
        into.push(ModelDs.row.pruned(seq, epoch));
        break;
      case 'deleted':
        into.push(ModelDs.row.deleted(seq, epoch));
        break;
      case 'add-proposal':
        into.push(ModelDs.row.addProposal(seq, epoch));
        break;
      default:
        throw new Error(`unknown what: ${r.what}`);
    }
  }
  return { handshakes, messages };
}

describe('the parity fixture (L-CORE-10)', () => {
  it('is version 1 with exactly eight cases', () => {
    expect(fixture.v).toBe(1);
    expect(fixture.cases).toHaveLength(8);
  });

  for (const c of fixture.cases) {
    it(`model: ${c.name}`, async () => {
      const core = await commonStart();
      const { handshakes, messages } = rowsOf(core, c);
      expect(core.groupApply(G, encode(handshakes), encode(messages), BigInt(c.through))).toEqual(expected(c));
      // new_seqs lists every inserted row, readable or not; the ordering cases are named for readability
      // (CORE-ENGINE-01), so every peer message the apply inserted must have been decrypted.
      const inserted = new Set(c.expect.new_seqs);
      const peerMessages = c.rows.filter((r) => r.what === 'peer-message' && inserted.has(r.seq)).map((r) => BigInt(r.seq));
      expect(core.unreadable(G).filter((u) => peerMessages.includes(u.seq))).toEqual([]);
    });

    it(`decoder: ${c.name}`, () => {
      const port = wrapCore({ group_apply: () => fromHex(c.result) } as unknown as CoreHandle);
      expect(port.groupApply(new Uint8Array(16), new Uint8Array([0x80]), new Uint8Array([0x80]), 0n)).toEqual(expected(c));
    });
  }
});
