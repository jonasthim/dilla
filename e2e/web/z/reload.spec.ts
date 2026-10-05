import { expect } from '@playwright/test';
import {
  COPY, PAST_BROWSER_SESSION_S, TEST_TIMEOUT, WAIT, advanceClock, clearKek, copy, expectAccessible,
  expectComposerReady, expectHeading, expectShell, instanceInvite, joinCommunity, messageRow, onboardingFrame,
  openChannel, sendText, signUp, splash, tag, test,
} from '../support/app';

test.describe.configure({ timeout: TEST_TIMEOUT });

test('a relaunched profile comes back from its stored device key, even after its session expired', async ({ page, peer, relaunch, instanceName }) => {
  const setup = await peer.setup();
  await peer.register();
  const channel = peer.channelName;
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, channel);
  const browserDevice = (await peer.waitForDevices(2)).find((d) => d !== setup.device_id);

  const one = `peer before the relaunch ${tag()}`;
  await peer.send(one);
  await expect(messageRow(page, channel, one)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  const two = `browser before the relaunch ${tag()}`;
  await sendText(page, channel, two);
  await peer.waitFor(two);

  const channelRoute = `/c/${setup.community_id}/${setup.channel_id}`;

  await page.reload();
  await expectShell(page);
  await expect(messageRow(page, channel, one)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

  // 1. A new browser process on the same profile, with a live session: no onboarding, the timeline is
  //    read back from this device's store, and sending works.
  let { page: again } = await relaunch();
  await again.goto(channelRoute);
  await expectShell(again);
  await expect(messageRow(again, channel, one)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  await expect(messageRow(again, channel, two)).toHaveAttribute('data-state', 'ok');
  await expectComposerReady(again, channel);
  const three = `after the first relaunch ${tag()}`;
  await sendText(again, channel, three);
  expect((await peer.waitFor(three)).sender_device).toBe(browserDevice);

  // 2. The instance clock passes the browser session lifetime: the stored token is refused, so ready
  //    can only come from the device key establishing a new session.
  await advanceClock(PAST_BROWSER_SESSION_S);
  ({ page: again } = await relaunch());
  await again.goto(channelRoute);
  await expectShell(again);
  await expect(onboardingFrame(again)).toHaveCount(0);
  await expect(messageRow(again, channel, three)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  await expectComposerReady(again, channel);
  const four = `after the session expired ${tag()}`;
  await sendText(again, channel, four);
  expect((await peer.waitFor(four)).sender_device).toBe(browserDevice);
  expect(await peer.devices()).toHaveLength(2);
});

test('a profile whose device key wrapper is gone says so and can start over after a confirmation', async ({ page, relaunch, instanceName }) => {
  await signUp(page, instanceInvite(), instanceName);
  await clearKek(page);
  const { page: again } = await relaunch();
  await again.goto('/');
  await expect(splash(again, COPY.storeLost)).toBeVisible({ timeout: WAIT });
  await expect(onboardingFrame(again)).toHaveCount(0);
  await expectAccessible(again, 'store-lost');

  // The reset destroys this browser's data, so it runs only from its confirmation dialog (task 22).
  await again.getByRole('button', { name: copy(COPY.storeLostAction), exact: true }).click();
  const confirm = again.getByRole('dialog', { name: copy(COPY.storeLostConfirmTitle), exact: true });
  await expect(confirm).toBeVisible({ timeout: WAIT });
  await expectAccessible(again, 'store-lost: confirm');
  await confirm.getByRole('button', { name: copy(COPY.storeLostConfirm), exact: true }).click();
  await expectHeading(again, COPY.connectTitle, { instance: instanceName });
});
