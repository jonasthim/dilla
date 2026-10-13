import { expect, type Page } from '@playwright/test';
import { composerBox, copy, expectAccessible, instanceInvite, joinCommunity, openChannel, openSettings, Peer, rowById, sendText, shownName, signUp, WAIT } from './support/app';
import { test } from './support/second';

async function enter(page: Page, peer: Peer, instanceName: string) {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  return setup;
}

test('rotation retracts already visible text; an independent trusted group still works', async ({ page, peer, instanceName }) => {
  const setup = await enter(page, peer, instanceName);
  const original = await peer.send('before rotation');
  await expect(rowById(page, peer.channelName, original.msg_id)).toContainText('before rotation', { timeout: WAIT });
  const control = await Peer.start();
  try {
    const other = await control.setup({});
    await control.register();
    await joinCommunity(page, control, other);
    await openChannel(page, control.communityName, control.channelName);
    await control.waitForDevices(2, other.channel_id);
    await control.send('trusted baseline');
    await expect(page.getByText('trusted baseline')).toBeVisible({ timeout: WAIT });
    await openChannel(page, peer.communityName, peer.channelName);
    await peer.rotateUmk();
    await peer.send('after rotation');
    await expect(page.getByRole('alert')).toContainText(copy('privacy.changed'), { timeout: WAIT });
    // Requirement 1: sending is blocked in the changed contact's group, and the composer says why.
    await expect(composerBox(page, peer.channelName)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByText('before rotation')).toHaveCount(0);
    await expect(page.getByText('after rotation')).toHaveCount(0);
    await expect(rowById(page, peer.channelName, original.msg_id)).toHaveAttribute('data-state', 'cannot-read');
    await openChannel(page, control.communityName, control.channelName);
    await control.send('positive control');
    await expect(page.getByText('positive control')).toBeVisible({ timeout: WAIT });
    await openChannel(page, peer.communityName, peer.channelName);
    await expect(page.getByText('after rotation')).toHaveCount(0);
    await expectAccessible(page, 'rotated contact');
  } finally { await control.close(); }
});

test('Copy alone does not approve; explicit exact-key comparison admits new traffic', async ({ page, peer, instanceName }) => {
  const setup = await enter(page, peer, instanceName);
  const rotated = await peer.rotateUmk();
  await peer.send('pending rotation');
  await expect(page.getByRole('alert')).toContainText(copy('privacy.changed'), { timeout: WAIT });
  await expect(composerBox(page, peer.channelName)).toHaveAttribute('aria-disabled', 'true');
  await openSettings(page, 'privacy');
  await page.getByRole('button', { name: copy('privacy.compare', { name: shownName(setup) }) }).click();
  const dialog = page.getByRole('dialog', { name: copy('privacy.title') });
  await expect(dialog).toContainText(copy('privacy.instructions'));
  const groups = dialog.locator('[data-safety-group]');
  await expect(groups).toHaveCount(12);
  for (let i = 0; i < 12; i++) await expect(groups.nth(i)).toHaveText(/^\d{5}$/);
  const witness = await peer.trustList(rotated.user);
  expect(witness.pendingUmk).toMatch(/^[0-9a-f]{64}$/);
  await expect(dialog.locator('[data-public-umk]')).toHaveText(witness.pendingUmk!);
  const key = await dialog.locator('[data-public-umk]').textContent();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  const approve = dialog.getByRole('button', { name: copy('privacy.verify') });
  await dialog.getByRole('button', { name: copy('privacy.copy') }).click();
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await dialog.getByRole('checkbox', { name: copy('privacy.confirm') }).check();
  await approve.click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: copy('settings.close') }).click();
  await peer.send('validated new text');
  await expect(page.getByText('validated new text')).toBeVisible({ timeout: WAIT });
  await sendText(page, peer.channelName, 'browser after verification');
  await peer.waitFor('browser after verification');
  expect(key).toBe(witness.pendingUmk);
});
