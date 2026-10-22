import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addServerVia, copy, signUp, test } from './support/app';
import { startTestHost, type HostConfig, type StartedHost } from './support/host';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const HOST: HostConfig = { port: 8491, control: 8492, webRoot: 'packages/web/dist', botRuntime: true };
const SERVER = 'Runtime Bot Acceptance';

test.use({ baseURL: 'http://127.0.0.1:8491' });

test('a bot enabled through server settings reaches ready through the native runtime', async ({ page, instanceName }) => {
  let host: StartedHost | null = null;
  try {
    host = await startTestHost(HOST);
    const account = await signUp(page, host.invite.split(',')[0] ?? '', instanceName, 'Ada', host.control);
    await addServerVia(page, 'create');
    const create = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
    await create.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
    await page.keyboard.press('Enter');

    await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
    const settings = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
    await expect(settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })).toBeVisible();
    await settings.getByRole('navigation', { name: copy('admin.nav'), exact: true })
      .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
    await expect(settings.getByText(copy('admin.bot.none'), { exact: true })).toBeVisible();
    await settings.getByRole('button', { name: copy('admin.bot.enable'), exact: true }).click();
    const stepUp = page.getByRole('dialog', { name: copy('factorSettings.stepUp.title'), exact: true });
    await stepUp.getByLabel(copy('factorSettings.stepUp.password'), { exact: true }).fill(account.password);
    await stepUp.getByRole('button', { name: copy('factorSettings.stepUp.confirm'), exact: true }).click();

    const runtimeCredentialFile = host.runtimeCredentialFile;
    if (runtimeCredentialFile === undefined) throw new Error('test host did not expose its protected runtime credential path');
    await expect.poll(async () => {
      const token = readFileSync(runtimeCredentialFile, 'utf8').trim();
      const response = await fetch(`${host!.url}/v1/bot-runtime/installations`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/cbor' },
      });
      if (!response.ok) return `HTTP ${response.status}`;
      const rows = arr(decode(new Uint8Array(await response.arrayBuffer())));
      return rows.length === 1 ? arr(rows[0])[2] : `count ${rows.length}`;
    }, { timeout: 90_000, intervals: [1_000, 2_000] }).toBe(3n);

    await expect.poll(async () => {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: copy('admin.open'), exact: true }).click();
      const refreshed = page.getByRole('dialog', { name: copy('admin.title'), exact: true });
      await refreshed.getByRole('navigation', { name: copy('admin.nav'), exact: true })
        .getByRole('button', { name: copy('admin.nav.bot'), exact: true }).click();
      return refreshed.getByRole('status').innerText();
    }, { timeout: 90_000, intervals: [1_000, 2_000, 3_000] }).toBe(copy('admin.bot.status.ready'));
  } finally {
    await host?.stop();
  }
});
