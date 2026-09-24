import { expect, test, type Page } from '@playwright/test';

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

async function boot(page: Page, id: string): Promise<void> {
  await page.goto(`/?instance=${id}`);
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
