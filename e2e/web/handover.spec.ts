import { expect } from '@playwright/test';
import { copy, instanceInvite, joinCommunity, openChannel, sendText, signUp, WAIT } from './support/app';
import { test } from './support/app';

// Tab B is a second page of the first tab's context, opened at the app: the store, the Web Lock and BroadcastChannel
// are per origin and profile, so the second fixture's own persistent profile (support/second.ts) would be a fresh
// device at onboarding, never other-tab. The page closes in finally; the context is the fixture's.

test('the second tab takes the lock only after the first releases it', async ({ page, context, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const other = { page: await context.newPage() };
  try {
    await other.page.goto('/');
    await expect(other.page.getByRole('button', { name: copy('tabs.use') })).toBeVisible({ timeout: WAIT });
    await other.page.getByRole('button', { name: copy('tabs.use') }).click();
    await expect(other.page.getByRole('textbox', { name: /message/i })).toBeVisible({ timeout: WAIT });
    await expect(page.getByRole('textbox', { name: /message/i })).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    await sendText(other.page, peer.channelName, 'new leader sends');
    await peer.waitFor('new leader sends');
  } finally { await other.page.close(); }
});

test('takeover notices contain exactly three public routing fields', async ({ page, context, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const install = () => {
    const w = window as typeof window & { __noticeKeys?: string[][] };
    w.__noticeKeys = [];
    const old = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (value: unknown) {
      w.__noticeKeys!.push(Object.keys(value as object).sort());
      return old.call(this, value);
    };
  };
  await page.evaluate(install);
  const other = { page: await context.newPage() };
  try {
    await other.page.goto('/');
    await other.page.evaluate(install);
    await other.page.getByRole('button', { name: copy('tabs.use') }).click();
    await expect(other.page.getByRole('textbox', { name: /message/i })).toBeVisible({ timeout: WAIT });
    const keys = [
      ...(await page.evaluate(() => (window as typeof window & { __noticeKeys: string[][] }).__noticeKeys)),
      ...(await other.page.evaluate(() => (window as typeof window & { __noticeKeys: string[][] }).__noticeKeys)),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const names of keys) expect(names).toEqual(['instance', 'nonce', 't']);
  } finally { await other.page.close(); }
});
