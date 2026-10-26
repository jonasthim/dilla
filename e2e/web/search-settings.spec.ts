import { expect, type Locator } from '@playwright/test';
import { advanceClock, composerBox, copy, expectAccessible, closeSettings, instanceInvite, joinCommunity, openChannel, openSettings, Peer, rowById, settingsDialog, signUp, WAIT } from './support/app';
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

test('Privacy, Keyboard and Diagnostics use the phone settings index and return with focus', async ({ page, peer, instanceName }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const tabs = page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
  for (const section of ['privacy', 'keyboard', 'diagnostics'] as const) {
    const dialog = await openSettings(page, section);
    await expect(dialog).toBeVisible({ timeout: WAIT });
    await expect(page).toHaveURL(new RegExp(`/settings/${section}$`), { timeout: WAIT });
    await expect(dialog.getByRole('button', { name: copy('workspace.back'), exact: true })).toBeVisible();
    await expect(dialog.locator('.d-settings-frame__nav')).toBeHidden();
    await expect(page.locator('.d-app-shell').getByRole('navigation', { name: copy('nav.tabs.label'), exact: true })).toHaveCount(0);
    await expectAccessible(page, `${section} at 360px`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: copy('workspace.back'), exact: true }).click();
    await expect(dialog).toBeVisible({ timeout: WAIT });
    await expect(page).toHaveURL('/settings', { timeout: WAIT });
    await expect(dialog.getByRole('navigation', { name: copy('settings.nav.label'), exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: WAIT });
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  }
});

test('settings search opens a registry result and focuses its setting anchor', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const settings = await openSettings(page, 'profile');
  const search = settings.getByRole('searchbox', { name: copy('workspace.search'), exact: true });
  await search.fill('microphone test');
  const result = settings.getByRole('button', { name: /Voice.*Preferences \/ Voice/u });
  await expect(result).toBeVisible({ timeout: WAIT });
  await expect(result).toContainText(copy('workspace.voice'));
  await search.press('Enter');
  await expect(page).toHaveURL('/settings/voice', { timeout: WAIT });
  await expect(settings.getByRole('heading', { name: copy('workspace.voice'), exact: true })).toBeFocused();
  await closeSettings(page);
});

test('Appearance controls fit desktop rows and the phone section header keeps its title readable', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const settings = await openSettings(page, 'appearance');
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const group = settings.getByRole('radiogroup', { name: copy('appearance.theme.label'), exact: true });
    // matchMedia updates the React phone layout after the viewport resize event.
    await expect.poll(async () => new Set(await group.getByRole('radio').evaluateAll(
      elements => elements.map(el => Math.round(el.getBoundingClientRect().y)),
    )).size, { message: `theme option rows at ${width}px` }).toBe(width >= 1024 ? 1 : 2);
    const overflow = await settings.locator('.d-settings-frame__body').evaluate(el => el.scrollWidth > el.clientWidth);
    expect(overflow, `settings overflow at ${width}px`).toBe(false);
    if (width < 768) {
      const back = settings.getByRole('button', { name: copy('workspace.back'), exact: true });
      await expect(back).toHaveText(copy('workspace.backShort'));
      const title = settings.locator('.d-settings-frame__section-title');
      await expect(title).toHaveText(copy('workspace.appearance'));
      expect(await title.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(settings.locator('.d-settings-frame__activity')).toHaveAttribute('data-visible', 'false');
      expect((await settings.locator('.d-settings-frame__bar').boundingBox())!.height,
        'idle phone headers do not reserve a second activity row').toBeLessThanOrEqual(72);
    }
  }
  await closeSettings(page);
});

test('a dirty Profile draft survives Keep editing and is discarded only after confirmation', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await peer.waitForDevices(2, setup.channel_id);
  const settings = await openSettings(page, 'profile');
  const display = settings.getByRole('textbox', { name: copy('profile.display.label'), exact: true });
  await display.fill('Unsaved profile draft');
  await expect(settings.locator('.d-settings-frame__footer')).toContainText('Unsaved changes');
  const nav = settings.getByRole('navigation', { name: copy('settings.nav.label'), exact: true });
  await nav.getByRole('button', { name: copy('workspace.signin'), exact: true }).click();
  let prompt = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(prompt).toBeVisible({ timeout: WAIT });
  await prompt.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await expect(page).toHaveURL('/settings/profile', { timeout: WAIT });
  await expect(display).toHaveValue('Unsaved profile draft');
  await nav.getByRole('button', { name: copy('workspace.signin'), exact: true }).click();
  prompt = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true });
  await expect(prompt).toBeVisible({ timeout: WAIT });
  await prompt.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL('/settings/signin', { timeout: WAIT });
  await expect(settings.getByRole('heading', { name: copy('workspace.signin'), exact: true })).toBeFocused();
  await closeSettings(page);
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

// I1, I2: labels and controls share aligned columns; a long danger label grows its button, it never overprints.
test('settings rows align their controls, and the sign-out button holds its text', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup({});
  await peer.register();
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, peer.channelName);
  await page.setViewportSize({ width: 1440, height: 900 });
  const columns = async (dialog: Locator) => dialog.locator('.d-settings-row__control').evaluateAll(els => els.map(el => {
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.x), width: Math.round(box.width) };
  }));
  let dialog = await openSettings(page, 'devices');
  await dialog.getByRole('navigation', { name: copy('settings.nav.label'), exact: true }).getByRole('button', { name: copy('factorSettings.nav'), exact: true }).click();
  await expect(dialog.locator('.d-settings-row').first()).toBeVisible({ timeout: WAIT });
  const signin = await columns(dialog);
  expect(signin.length).toBeGreaterThanOrEqual(4);
  expect(new Set(signin.map(c => c.x)).size, 'one control x in Sign-in').toBe(1);
  expect(new Set(signin.map(c => c.width)).size, 'one control width in Sign-in').toBe(1);
  await closeSettings(page);
  dialog = await openSettings(page, 'devices');
  const out = dialog.locator('.d-settings-row__control').getByRole('button', { name: copy('devices.signOut'), exact: true }).first();
  await expect(out).toBeVisible({ timeout: WAIT });
  const fits = await out.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.getBoundingClientRect().right <= (el.closest('.d-settings-row__control')?.getBoundingClientRect().right ?? 0) + 1);
  expect(fits, 'the sign-out label is inside its button and its column').toBe(true);
  await closeSettings(page);
  // M-3: every row keeps its own hairline, also two rows that are each the last child of their parent (Voice).
  dialog = await openSettings(page, 'voice');
  await expect(dialog.locator('.d-settings-row').first()).toBeVisible({ timeout: WAIT });
  const hairlines = await dialog.locator('.d-settings-row').evaluateAll(els => els.map(el => getComputedStyle(el).borderBottomWidth));
  expect(hairlines.length).toBeGreaterThan(1);
  expect(new Set(hairlines)).toEqual(new Set(['1px']));
  await closeSettings(page);
});
