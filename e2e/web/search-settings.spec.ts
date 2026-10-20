import { expect } from '@playwright/test';
import { advanceClock, composerBox, copy, expectAccessible, instanceInvite, joinCommunity, openChannel, Peer, rowById, settingsDialog, signUp, WAIT } from './support/app';
import { test } from './support/second';

test('native edit is searched by prefix and deleted text disappears after a positive result', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const first = await peer.send('old lantern');
  await expect(rowById(page, peer.channelName, first.msg_id)).toContainText('old lantern', { timeout: WAIT });
  await peer.edit(first.msg_id, 'café lamp');
  await expect(rowById(page, peer.channelName, first.msg_id)).toContainText('café lamp', { timeout: WAIT });
  await page.keyboard.press('ControlOrMeta+K');
  const search = page.getByRole('combobox', { name: copy('search.placeholder') });
  await search.fill('cafe');
  await expect(page.getByRole('option', { name: /café lamp/ })).toBeVisible({ timeout: WAIT });
  // J1, R-S4: a desktop search is a centred overlay of at most 40rem over a shell that stays in the DOM, not a full-screen page.
  const overlay = page.locator('dialog.d-search-palette-dialog');
  const box = await overlay.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error('no search overlay box');
  expect(box.width).toBeLessThanOrEqual(641);
  expect(box.x).toBeGreaterThan(100);
  expect(box.x + box.width / 2).toBeCloseTo(viewport.width / 2, 0);
  await expect(page.locator('dialog.dw-search')).toHaveCount(0);
  await expect(rowById(page, peer.channelName, first.msg_id)).toBeAttached();
  await expect(search).toBeFocused();
  await page.getByRole('option', { name: /café lamp/ }).click();
  await expect(rowById(page, peer.channelName, first.msg_id)).toBeFocused();
  await peer.deleteMessage(first.msg_id, first.seq);
  const later = await peer.send('lamp after delete');
  await expect(rowById(page, peer.channelName, later.msg_id)).toContainText('lamp after delete', { timeout: WAIT });
  await page.keyboard.press('ControlOrMeta+K');
  await page.getByRole('combobox', { name: copy('search.placeholder') }).fill('lamp');
  await expect(page.getByRole('option', { name: /lamp after delete/ })).toBeVisible({ timeout: WAIT });
  await expect(page.getByRole('option', { name: /café lamp/ })).toHaveCount(0);
  await expectAccessible(page, 'search after delete');
});

test('Privacy, Keyboard and Diagnostics work at phone width with surviving focus', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  await page.setViewportSize({ width: 360, height: 740 });
  // The phone shell has no rail settings tile and no section list: Settings opens from a row of the You tab and closes with the header's back.
  const tabs = page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
  const back = page.getByRole('button', { name: copy('nav.back'), exact: true });
  for (const section of ['privacy', 'keyboard', 'diagnostics'] as const) {
    if (!(await tabs.isVisible())) await back.click();
    await tabs.getByRole('link', { name: copy('nav.tab.you'), exact: true }).click();
    await page.locator(`[data-settings-section="${section}"]`).click();
    const dialog = settingsDialog(page);
    await expect(dialog).toBeVisible({ timeout: WAIT });
    await expect(page).toHaveURL(new RegExp(`/settings/${section}$`), { timeout: WAIT });
    // The phone header's title, then the section's own heading.
    await expect(dialog.locator('.d-phone-header__title')).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveCount(2);
    await expectAccessible(page, `${section} at 360px`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await back.click();
    await expect(dialog).toBeHidden({ timeout: WAIT });
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  }
});

test('scopes and keyboard selection stay on the textbox until a target is chosen', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const sent = await peer.send('café compass');
  await expect(rowById(page, peer.channelName, sent.msg_id)).toContainText('café compass', { timeout: WAIT });
  // Escape closes the overlay and returns focus to where search was opened.
  await rowById(page, peer.channelName, sent.msg_id).focus();
  await page.keyboard.press('ControlOrMeta+/');
  await expect(page.getByRole('combobox', { name: copy('search.placeholder') })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: copy('search.placeholder') })).toHaveCount(0);
  await expect(rowById(page, peer.channelName, sent.msg_id)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+/');
  const textbox = page.getByRole('combobox', { name: copy('search.placeholder') });
  await textbox.fill('cafe');
  for (const scope of ['this conversation', 'this community', 'everything']) {
    await page.getByRole('button', { name: scope }).click();
    await expect(page.getByRole('option', { name: /café compass/ })).toBeVisible({ timeout: WAIT });
    await textbox.focus();
    await page.keyboard.press('ArrowDown');
    await expect(textbox).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(rowById(page, peer.channelName, sent.msg_id)).toBeFocused();
});

test('typing is audience-scoped, expires by server time and is not replayed', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  await peer.typing(setup.channel_id, true);
  await expect(page.getByRole('status').filter({ hasText: /is typing/ })).toBeVisible({ timeout: WAIT });
  const outsider = await Peer.start();
  try {
    await outsider.setup({});
    await outsider.register();
    await expect(outsider.typing(setup.channel_id, true)).rejects.toThrow(/E_NOT_FOUND/);
    await expect(page.getByRole('status').filter({ hasText: /is typing/ })).toHaveCount(1);
  } finally { await outsider.close(); }
  await advanceClock(11);
  await expect(page.getByRole('status').filter({ hasText: /is typing/ })).toHaveCount(0, { timeout: WAIT });
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: /is typing/ })).toHaveCount(0);
});

// WB product walk I1: leaving a channel with an unsent draft is normal; no error banner, no refused typing signal.
test('switching channel with an unsent draft shows no error banner', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({ channels: 2 });
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  for (let i = 0; i < 3; i += 1) {
    await composerBox(page, peer.channelName).click();
    await page.keyboard.type('half a thought');
    await openChannel(page, peer.communityName, peer.channelNames[1]);
    await openChannel(page, peer.communityName, peer.channelName);
  }
  await page.waitForTimeout(500);
  await expect(page.getByText(/E_NOT_READY|That did not work/)).toHaveCount(0);
});

test('desktop, phone and reflow keep controls accessible in three themes', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['mesh', 'light', 'high-contrast']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await expectAccessible(page, `${theme} ${viewport.width}px`);
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        small: [...document.querySelectorAll('button, input, [role="button"]')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24);
        }).length,
      }));
      expect(layout).toEqual({ overflow: false, small: 0 });
    }
  }
});
