import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every test in this file needs a working OPFS boot, a leader and an encrypted store. Firefox in
// private browsing and WebKit in an ephemeral context both boot in `memory` mode by design, so these
// assertions would fail there for the right reason and the wrong purpose. Task 18 adds the firefox
// and webkit projects and `persistence-matrix.spec.ts` covers those engines; this file stays on
// Chromium, and the hand-over metrics file is written by the Chromium run alone.
test.skip(({ browserName }) => browserName !== 'chromium', 'OPFS sahpool is Chromium-only here');

/** Each test gets its own instance id, so its OPFS directory is its own. */
function instance(name: string): string {
  return `spike-${name}-${Date.now().toString(36)}`;
}

async function boot(page: Page, id: string, extraQuery = ''): Promise<void> {
  await page.goto(`/?instance=${id}${extraQuery}`);
  await expect(page.getByTestId('mode')).not.toHaveText('', { timeout: 60_000 });
  await expect(page.getByTestId('role')).not.toHaveText('', { timeout: 60_000 });
}

test('a lone tab probes opfs, becomes leader on the first attempt and opens the encrypted store', async ({ page }) => {
  const id = instance('lone');
  await boot(page, id);

  await expect(page.getByTestId('mode')).toHaveText('opfs');
  await expect(page.getByTestId('reason')).toHaveText('');
  await expect(page.getByTestId('role')).toHaveText('leader');
  await expect(page.getByTestId('attempts')).toHaveText('1');
  // A row read back through `SELECT count(*)` proves PRAGMA key actually took.
  await expect(page.getByTestId('rows')).toHaveText('1');
});

test('the probe runs before install, and install creates the pool directory only in opfs mode', async ({ page }) => {
  const id = instance('probe-order');
  await boot(page, id);

  const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
  expect(order.slice(0, 2)).toEqual(['probe', 'install']);

  const dirs: string[] = await page.evaluate(async (dir) => {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    // @ts-expect-error async iteration over FileSystemDirectoryHandle is not in lib.dom yet
    for await (const [name] of root.entries()) names.push(name);
    const sub = await root.getDirectoryHandle(dir.split('/')[0]);
    // @ts-expect-error same
    for await (const [name] of sub.entries()) names.push(`${dir.split('/')[0]}/${name}`);
    return names;
  }, `dilla/${id}`);
  expect(dirs.some((n) => n.startsWith('dilla'))).toBe(true);
});

test('a second tab in the same context stays a follower while the leader holds the lock', async ({ context }) => {
  const id = instance('follower');
  const leader = await context.newPage();
  await boot(leader, id);
  await expect(leader.getByTestId('role')).toHaveText('leader');

  const follower = await context.newPage();
  await boot(follower, id);
  await expect(follower.getByTestId('role')).toHaveText('follower');

  // The other half of the leader contract: the follower opened no store of its own, forwarded a
  // `call` over the BroadcastChannel and rendered the leader's `event`. Asserting the leader's row
  // count here is what makes the channel load-bearing rather than decorative.
  await expect(follower.getByTestId('rows')).toHaveText('1', { timeout: 30_000 });
  const followerOrder: string[] = await follower.evaluate(() => (globalThis as any).__dilla.order);
  expect(followerOrder).toContain('follower');
  expect(followerOrder).not.toContain('install');
});

test('a wrong key fails on the SELECT, not on the pragma', async ({ page }) => {
  const id = instance('wrong-key');
  await boot(page, id);
  await expect(page.getByTestId('role')).toHaveText('leader');

  // gap-13 §2.2: `PRAGMA key` reports ok whatever the key is, so this message is the only evidence
  // the browser store is actually encrypted. The probe runs after the boot marker is written, because
  // an empty database has no page to decrypt and any key would succeed.
  const message: string = await page.evaluate(() => (globalThis as any).__dilla.wrongKeyMessage);
  expect(message).toContain('sqlite_schema');
  expect(message).toContain('E_STORE_KEY');
  expect(message).not.toContain('PRAGMA key');
  expect(message).not.toContain('unexpected:');
});

test('the encrypted database survives a reload in the same context', async ({ page }) => {
  const id = instance('reload');
  await boot(page, id);
  await page.getByTestId('append').click();
  await expect(page.getByTestId('rows')).toHaveText('2');

  await page.reload();
  await boot(page, id);
  await expect(page.getByTestId('mode')).toHaveText('opfs');
  await expect(page.getByTestId('rows')).toHaveText('2');
  // Second visit, marker still present: storage was not cleared.
  await expect(page.getByTestId('marker')).toHaveText('kept');
});

test('a leader whose store fails to open reports the error instead of hanging', async ({ page }) => {
  const id = instance('store-error');

  // `badkek=1` is the worker's only lever for this branch: it opens the store with a KEK that
  // `store_open` rejects on sight, so the failure is permanent and never contention — the gap-14 §5
  // retry budget is not spent and the rejection reaches `navigator.locks.request` immediately.
  //
  // This is the NV-10 negative branch, and it cannot be reached any other way: the plain-VFS probe
  // runs only *after* `store_open` has succeeded. Without a reporting `.catch` on the lock request
  // the rejection is an unhandled rejection inside the worker — `run()` has already returned, so
  // worker.ts's own `.catch` cannot see it either — the page renders an empty `role`, and the only
  // symptom is this test timing out in `boot` with no message anywhere. Task 18's hand-over test
  // consumes the same contract.
  await boot(page, id, '&badkek=1');

  await expect(page.getByTestId('role')).toHaveText('error');
  await expect(page.getByTestId('banner')).toContainText('E_STORE_KEK');

  // The failure happened inside the elected-leader callback, not before the election: the tab did
  // win the lock, and `install` is on the trail that leads to `leader-failed`.
  const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
  expect(order).toContain('install');
  expect(order).toContain('leader-failed');
  expect(order).not.toContain('leader-elected');
});

test('opening the pool under its plain VFS name fails with the exact sqlite3mc message', async ({ page }) => {
  const id = instance('plain-vfs');
  await boot(page, id);
  const message: string = await page.evaluate(() => (globalThis as any).__dilla.plainVfsMessage);
  expect(message).toContain('Setting key failed. Encryption is not supported by the VFS.');
});

test('resigning closes the connection, pauses the VFS and releases the lock in that order', async ({
  context,
}) => {
  const id = instance('resign');
  const page = await context.newPage();
  await boot(page, id);
  await page.getByTestId('resign').click();
  await expect(page.getByTestId('role')).toHaveText('resigned');

  // `lock-released` is pushed from a `.finally()` on navigator.locks.request, so it appears only once
  // the browser has really released the lock — recording it on the line after `resign()` would record
  // intent and would still pass if the lock were never released at all.
  await expect
    .poll(async () => (await page.evaluate(() => (globalThis as any).__dilla.order)) as string[], {
      timeout: 30_000,
    })
    .toContain('lock-released');

  const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
  const tail = order.slice(order.indexOf('resign-start'));
  expect(tail).toEqual(['resign-start', 'pause', 'leader-resigned', 'lock-released']);

  // The only proof the lock is genuinely free: a fresh page takes it. Without this, a leader that
  // resigned but never released would wedge every successor and the test above would not notice.
  const successor = await context.newPage();
  await boot(successor, id);
  await expect(successor.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
});

const HANDOVERS = 10;

test('leadership passes to the follower within the 6-attempt budget when the leader tab is closed', async ({
  context,
}) => {
  const id = instance('handover');
  const samples: Array<{ attempts: number; elapsedMs: number; grantMs: number }> = [];

  let leader = await context.newPage();
  await boot(leader, id);
  await expect(leader.getByTestId('role')).toHaveText('leader');

  for (let i = 0; i < HANDOVERS; i += 1) {
    const follower = await context.newPage();
    await boot(follower, id);
    await expect(follower.getByTestId('role')).toHaveText('follower');

    // interfaces §6 task 20 asks for the **lock-release latency after a leader kill**, which is the
    // interval between closing the leader and the successor being elected. `elapsedMs` is measured
    // inside openWithRetry, which starts only after the lock has already been granted, so it is the
    // reopen time and not that latency. Both are recorded; task 20 reports them under their own names.
    const killedAt = Date.now();
    await leader.close();

    // The Web Lock is released on agent teardown, with no lease and no TTL; the successor's first
    // install() is also what evicts a BFCached predecessor, so one retry is expected and healthy
    // (gap-14 §0, §3).
    await expect(follower.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
    const grantMs = Date.now() - killedAt;
    const attempts = Number(await follower.getByTestId('attempts').textContent());
    const elapsedMs = Number(await follower.getByTestId('elapsed').textContent());

    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(2);
    expect(elapsedMs).toBeLessThan(4500);
    samples.push({ attempts, elapsedMs, grantMs });

    leader = follower;
  }

  const sorted = [...samples].sort((a, b) => a.elapsedMs - b.elapsedMs);
  const sortedGrant = [...samples].sort((a, b) => a.grantMs - b.grantMs);
  const metrics = {
    handovers: HANDOVERS,
    attempts: {
      min: Math.min(...samples.map((s) => s.attempts)),
      max: Math.max(...samples.map((s) => s.attempts)),
    },
    // Time from `leader.close()` to the successor showing `role = leader`: the OPFS/Web-Locks
    // release latency task 20 must publish. No vendor documents a bound (gap-14 §0).
    grantMs: {
      min: sortedGrant[0].grantMs,
      p50: sortedGrant[Math.floor(sortedGrant.length / 2)].grantMs,
      max: sortedGrant[sortedGrant.length - 1].grantMs,
    },
    // Time inside `openWithRetry`, i.e. how long reopening the encrypted store took once the lock
    // was already held.
    elapsedMs: {
      min: sorted[0].elapsedMs,
      p50: sorted[Math.floor(sorted.length / 2)].elapsedMs,
      max: sorted[sorted.length - 1].elapsedMs,
    },
    samples,
  };
  const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'opfs-leader-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
});

test('the new leader reads the rows the old leader wrote', async ({ context }) => {
  const id = instance('handover-data');
  const first = await context.newPage();
  await boot(first, id);
  await first.getByTestId('append').click();
  await expect(first.getByTestId('rows')).toHaveText('2');

  const second = await context.newPage();
  await boot(second, id);
  await expect(second.getByTestId('role')).toHaveText('follower');
  await first.close();

  await expect(second.getByTestId('role')).toHaveText('leader', { timeout: 30_000 });
  await expect(second.getByTestId('rows')).toHaveText('2');
});
