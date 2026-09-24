import { expect, test } from '@playwright/test';

function instance(name: string): string {
  return `matrix-${name}-${Date.now().toString(36)}`;
}

test.describe('@matrix persistence across engines', () => {
  test('chromium reports opfs and keeps the database across a reload', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'chromium project only');
    const id = instance('chromium');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('opfs', { timeout: 60_000 });
    await page.getByTestId('append').click();
    await expect(page.getByTestId('rows')).toHaveText('2');
    await page.reload();
    await expect(page.getByTestId('rows')).toHaveText('2', { timeout: 60_000 });
  });

  test('firefox private browsing reports memory with getDirectory:SecurityError and still boots', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'firefox', 'firefox project only');
    const id = instance('firefox-private');
    await page.goto(`/?instance=${id}`);
    // A plain Playwright Firefox context is a fresh profile, NOT private browsing, and would
    // report "opfs" — the project sets browser.privatebrowsing.autostart so this is real PBM.
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('reason')).toHaveText('getDirectory:SecurityError');
    await expect(page.getByTestId('role')).toHaveText('memory');
    await expect(page.getByTestId('banner')).toBeVisible();
    // gap-15 AC-7: the copy names the effect, never the browser mode.
    await expect(page.getByTestId('banner')).toHaveText(
      "Messages in this window won't be saved on this device.",
    );
  });

  test('webkit ephemeral contexts report memory with getDirectory:UnknownError and still boot', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'webkit project only');
    const id = instance('webkit');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('reason')).toHaveText('getDirectory:UnknownError');
    await expect(page.getByTestId('banner')).toBeVisible();
  });

  test('a memory boot never installs the pool and never reads an epoch from storage', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'chromium', 'memory mode only');
    const id = instance('no-install');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });

    // gap-15 AC-5: install() is never reached, so the order log stops at the memory boot.
    const order: string[] = await page.evaluate(() => (globalThis as any).__dilla.order);
    expect(order).toEqual(['probe', 'memory-boot']);
    expect(order).not.toContain('install');

    // gap-15 AC-4, second half: a reload produces a fresh client with no stored rows to read. The
    // first half — "rejoins by external commit", i.e. exactly one external commit on the wire — is
    // **deviation A2-12**: this spike has no MLS group, no delivery service and no wire, so it cannot
    // be observed here at all. Plan A task 13's testkit scenarios and the first browser-client task
    // (W2) carry it.
    await page.reload();
    await expect(page.getByTestId('mode')).toHaveText('memory', { timeout: 60_000 });
    await expect(page.getByTestId('rows')).toHaveText('-');
  });

  test('a cleared store is reported on the next visit', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs a working opfs boot to clear');
    const id = instance('cleared');
    await page.goto(`/?instance=${id}`);
    await expect(page.getByTestId('marker')).toHaveText('first-visit', { timeout: 60_000 });

    // The leader's dedicated worker still holds FileSystemSyncAccessHandles over the sahpool slots,
    // and in Chromium `removeEntry` on a directory with live access handles rejects with
    // NoModificationAllowedError. Resign first: the resign path closes the connection and calls
    // pause_vfs(), which is exactly the affordance that releases those handles.
    await page.getByTestId('resign').click();
    await expect(page.getByTestId('role')).toHaveText('resigned', { timeout: 30_000 });

    // Wipe OPFS the way an incognito session end or an eviction would, leaving localStorage alone.
    const left: string[] = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const names: string[] = [];
      // @ts-expect-error async iteration over FileSystemDirectoryHandle is not in lib.dom yet
      for await (const [name] of root.entries()) names.push(name);
      for (const name of names) {
        await root.removeEntry(name, { recursive: true });
      }
      const remaining: string[] = [];
      // @ts-expect-error same
      for await (const [name] of root.entries()) remaining.push(name);
      return remaining;
    });
    // Assert the wipe itself worked, so a swallowed NoModificationAllowedError cannot make the
    // "cleared" assertion below pass for the wrong reason.
    expect(left).toEqual([]);

    await page.reload();

    await expect(page.getByTestId('marker')).toHaveText('cleared', { timeout: 60_000 });
    await expect(page.getByTestId('banner')).toHaveText('Storage was cleared since your last visit.');
  });
});
