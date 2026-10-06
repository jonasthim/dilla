import { expect } from '@playwright/test';
import {
  CLASS, COPY, TEST_TIMEOUT, WAIT, channelsNav, composerBox, copy, expectComposerReady, expectShell,
  heading, instanceInvite, logRegion, messageRow, nextButton, railNav, submitButton, tabTo, tag, test,
} from './support/app';

test.describe.configure({ timeout: TEST_TIMEOUT });

test('the messaging flow runs on the keyboard alone, in the fixed focus order', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup();
  await peer.register();
  const channel = peer.channelName;
  const press = (key: string) => page.keyboard.press(key);

  // Onboarding: every step is a form, submitted with Enter on its focused forward button (L-COPY-01).
  await page.goto(`/welcome?invite=${encodeURIComponent(instanceInvite())}`);
  await expect(heading(page, COPY.connectTitle, { instance: instanceName })).toBeVisible({ timeout: WAIT });
  await tabTo(page, nextButton(page));
  await press('Enter');
  await expect(heading(page, COPY.identityTitle)).toBeFocused({ timeout: WAIT });
  await tabTo(page, page.getByLabel(copy(COPY.usernameLabel), { exact: true }));
  await page.keyboard.type(`k${setup.user_id.slice(0, 8)}`);
  await tabTo(page, page.getByLabel(copy(COPY.displayLabel), { exact: true }));
  await page.keyboard.type('keyboard tester');
  await tabTo(page, page.getByLabel(copy(COPY.passwordLabel), { exact: true }));
  await page.keyboard.type('e2e-password-1234');
  await tabTo(page, nextButton(page));
  await press('Enter');
  await expect(heading(page, COPY.keysTitle)).toBeFocused({ timeout: WAIT });
  const acknowledge = page.getByRole('checkbox', { name: copy(COPY.keysAcknowledge), exact: true });
  await tabTo(page, acknowledge);
  await press('Space');
  await expect(acknowledge).toBeChecked();
  await tabTo(page, nextButton(page));
  await press('Enter');
  await expect(heading(page, COPY.deviceTitle)).toBeFocused({ timeout: WAIT });
  await tabTo(page, submitButton(page));
  await press('Enter');
  await expect(heading(page, COPY.doneTitle)).toBeFocused({ timeout: WAIT });
  await tabTo(page, page.getByRole('button', { name: copy(COPY.finish), exact: true }));
  await press('Enter');
  await expectShell(page);

  // Join the peer's server through the rail's join button (the rail's one tab stop while it has no
  // server) and the dialog.
  const rail = railNav(page);
  await tabTo(page, rail.getByRole('button', { name: copy(COPY.railJoin), exact: true }));
  await press('Enter');
  const dialog = page.getByRole('dialog', { name: copy(COPY.joinTitle), exact: true });
  await expect(dialog).toBeVisible({ timeout: WAIT });
  await tabTo(page, dialog.getByLabel(copy(COPY.joinInvite), { exact: true }));
  await page.keyboard.type(setup.invite_code);
  await tabTo(page, dialog.getByRole('button', { name: copy(COPY.joinSubmit), exact: true }));
  await press('Enter');
  await expect(dialog).toBeHidden({ timeout: WAIT });

  // Rail and channel list by their single tab stops (the active item, else the first).
  await tabTo(page, rail.getByRole('button', { name: copy(COPY.railJoin), exact: true }));
  await press('ArrowUp');
  await expect(rail.getByRole('button', { name: peer.communityName, exact: true })).toBeFocused();
  await press('Enter');
  await tabTo(page, channelsNav(page).getByRole('button', { name: channel }));
  await press('Enter');
  await expectComposerReady(page, channel);

  // Shift+Enter breaks the line, Enter sends.
  const first = `line one ${tag()}`;
  await tabTo(page, composerBox(page, channel));
  await page.keyboard.type(first);
  await press('Shift+Enter');
  await page.keyboard.type('line two');
  await press('Enter');
  await expect(messageRow(page, channel, first)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  const received = await peer.waitFor(`${first}\nline two`);
  expect(received.tier).toBe(1);

  // Escape in the log returns focus to the composer.
  await expect(composerBox(page, channel)).toBeFocused();
  await press('Shift+Tab');
  await expect(logRegion(page, channel)).toBeFocused();
  await press('Escape');
  await expect(composerBox(page, channel)).toBeFocused();

  // One Tab lap from the skip link, in the order the Global Constraints fix.
  const regions = [
    page.getByRole('link', { name: copy(COPY.skipLink), exact: true }),   // 0 skip link
    rail,                                                                   // 1 community rail
    channelsNav(page),                                                      // 2 channel list
    page.locator(CLASS.channelHeader),                                      // 3 channel header
    logRegion(page, channel),                                               // 4 message log
    page.locator(CLASS.composer),                                           // 5 composer
    page.getByRole('region', { name: copy(COPY.statusBarLabel), exact: true }), // 6 status bar
  ];
  const regionOfFocus = async (): Promise<number> => {
    for (let i = 0; i < regions.length; i++) {
      const inside = await regions[i].evaluateAll((els) =>
        els.some((el) => el === document.activeElement || el.contains(document.activeElement)));
      if (inside) return i;
    }
    return -1;
  };
  const skip = regions[0];
  for (let i = 0; i < 40 && !(await skip.evaluate(el => el === document.activeElement)); i++) {
    await press('Shift+Tab');
  }
  await expect(skip).toBeFocused();
  const seen: number[] = [0];
  for (let i = 0; i < 12; i++) {
    await press('Tab');
    seen.push(await regionOfFocus());
  }
  const start = seen.indexOf(0);
  expect(start, `the skip link is a tab stop (regions seen: ${seen.join(' ')})`).toBeGreaterThanOrEqual(0);
  const lap: number[] = [];
  const stops = new Map<number, number>();
  let previous = -2;
  for (const region of seen.slice(start)) {
    if (region === 0 && lap.length > 1) break;
    if (region === -1) { previous = -1; continue; }
    if (region !== previous) lap.push(region);
    stops.set(region, (stops.get(region) ?? 0) + 1);
    previous = region;
  }
  expect(lap, `focus order ${lap.join(' > ')}`).toEqual([...lap].sort((a, b) => a - b));
  expect(new Set(lap).size, `each region entered once: ${lap.join(' > ')}`).toBe(lap.length);
  for (const required of [0, 1, 2, 4, 5]) expect(lap).toContain(required);
  expect(stops.get(2), 'the channel list is one tab stop').toBe(1);
  expect(stops.get(1), 'the rail is one tab stop, its join button included').toBe(1);
});
