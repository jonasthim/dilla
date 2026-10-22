// Negative cases of the trust refresh after PR #72 (web3.12.2). Once one leaf of a user ingests the history read in a
// pass, the user's other leaves in that pass are handed the history sliced from the version the core cached
// (state/trust.ts historyFrom). Each test asserts the refusal that tells "correctly relaxed" from "relaxed too far":
// a refused leaf is never revalidated, whatever its siblings did. The fake core keeps the real core's two rules that
// matter here (core/dilla-core/src/client/trust.rs ingest_leaf): once a version is cached, a history must start at it
// (E_DEVICE_LIST_STALE), and a device the signed list does not name is refused (E_DEVICE_UNLISTED).
import { expect, it, vi } from 'vitest';
import { decode, encode } from '../cbor';
import { CoreError } from '../core-port';
import { toHex } from '../hex';
import { GROUP, STRANGER, world, toReady, type World } from './world';

const row = (v: number) => [v, new Uint8Array([v]), new Uint8Array(64), new Uint8Array(32)];
const ROGUE = 1;

/** The server: head v2, and the history from `after` on. */
function serve(w: World, head = 2): void {
  w.routes.getDeviceList.mockImplementation(() => Promise.resolve({ version: BigInt(head), blob: new Uint8Array([head]), raw: encode(row(head)) }));
  w.routes.getDeviceListHistory.mockImplementation((_u: Uint8Array, after: bigint) => {
    const versions = Array.from({ length: head - Number(after) }, (_, i) => Number(after) + 1 + i);
    return Promise.resolve({ raw: encode(versions.map(row)), count: versions.length, lastVersion: BigInt(head) });
  });
}

/** The core's anchor and listing rules; answers each ingest's leaf and the versions of the history it was handed. */
function core(w: World, opts: { cached?: bigint; verdict?: bigint } = {}): { leaf: number; versions: number[] }[] {
  let cached = opts.cached ?? 0n;
  const seen: { leaf: number; versions: number[] }[] = [];
  w.core.deviceListIngest.mockImplementation((_g: Uint8Array, leaf: number, _u: Uint8Array, history: Uint8Array) => {
    const versions = (decode(history) as [number | bigint][]).map((r) => Number(r[0]));
    seen.push({ leaf, versions });
    if (cached !== 0n && BigInt(versions[0]) !== cached) throw new CoreError('E_DEVICE_LIST_STALE', '');
    if (leaf === ROGUE) throw new CoreError('E_DEVICE_UNLISTED', '');
    cached = opts.verdict ?? BigInt(versions[versions.length - 1]);
    return { version: cached, changed: false, quarantined: 0 };
  });
  return seen;
}

function pending(w: World, order: number[], cachedVersion = 0n): void {
  w.core.pendingLeaves.mockReturnValue(order.map((leafIndex) => ({ groupId: GROUP, leafIndex, userId: STRANGER, cachedVersion, reason: 'unknown' as const })));
}

const released = (w: World): number[] => (w.core.revalidatePending.mock.calls as unknown as [Uint8Array, number][])
  .map(([g, leaf]) => { expect(toHex(g)).toBe(toHex(GROUP)); return leaf; });

async function pass(w: World, id: number): Promise<void> {
  w.call(id, { m: 'refreshTrust' });
  await vi.waitFor(() => expect(w.ret(id)).toMatchObject({ ok: true }));
}

// 1. An unauthorised device in the same pass as legitimate siblings, in every order.
for (const [name, order, expected] of [
  ['the unlisted leaf first', [ROGUE, 0, 2], [[1, 2], [1, 2], [2]]],
  ['a legitimate leaf first', [0, ROGUE, 2], [[1, 2], [2], [2]]],
  ['the unlisted leaf last', [0, 2, ROGUE], [[1, 2], [2], [2]]],
] as const) {
  it(`never releases an unlisted leaf of a user whose other leaves ingest in the same pass (${name})`, async () => {
    const w = world();
    await toReady(w);
    serve(w);
    const seen = core(w);
    pending(w, [...order]);
    await pass(w, 1201);
    expect(seen).toEqual(order.map((leaf, i) => ({ leaf, versions: [...expected[i]] })));
    // The slice the unlisted leaf got (or the full read) was refused; only its legitimate siblings are released.
    expect(released(w)).toEqual(order.filter((leaf) => leaf !== ROGUE));
    // The slice is the served v2 row itself, byte for byte: no history but the one read is ever handed to the core.
    const sliced = w.core.deviceListIngest.mock.calls.find((args) => (decode(args[3]) as unknown[]).length === 1);
    expect(sliced?.[3]).toEqual(encode([row(2)]));
    // A second pass in the same ready does not try the refused leaf again with the history its sibling's ingest cached.
    await pass(w, 1202);
    expect(released(w)).toEqual(order.filter((leaf) => leaf !== ROGUE));
  });
}

// 6. A non-zero cached start: the read begins at the cached version 1, [v1, v2]; the second leaf gets [v2].
it('slices [v1, v2] read from a cached v1 to [v2] for the next leaf once the first ingest cached v2', async () => {
  const w = world();
  await toReady(w);
  serve(w);
  const seen = core(w, { cached: 1n });
  pending(w, [0, 2], 1n);
  await pass(w, 1203);
  expect(seen).toEqual([{ leaf: 0, versions: [1, 2] }, { leaf: 2, versions: [2] }]);
  expect(released(w)).toEqual([0, 2]);
});

// 6. historyFrom answers null after a successful ingest (the core cached a version past every row read): the next leaf
// is handed the full read, which the core refuses; it is not released, and its retry is refused too, never accepted.
it('refuses, and on retry refuses again, a leaf whose slice is empty after its sibling\'s ingest', async () => {
  const w = world();
  await toReady(w);
  serve(w);
  const seen = core(w, { verdict: 3n });
  pending(w, [0, 2]);
  await pass(w, 1204);
  expect(seen).toEqual([{ leaf: 0, versions: [1, 2] }, { leaf: 2, versions: [1, 2] }]);
  expect(released(w)).toEqual([0]);
  // The retry: the core now reports the leaf at its cached version 3, a new pending leaf the worker fetches again. The
  // served head v2 is below it, so the read is refused before any ingest.
  const reads = w.routes.getDeviceList.mock.calls.length;
  w.core.pendingLeaves.mockReturnValue([{ groupId: GROUP, leafIndex: 2, userId: STRANGER, cachedVersion: 3n, reason: 'ready-refresh' }]);
  await pass(w, 1205);
  expect(w.routes.getDeviceList.mock.calls.length).toBeGreaterThan(reads);
  expect(seen).toHaveLength(2);
  expect(released(w)).toEqual([0]);
});
