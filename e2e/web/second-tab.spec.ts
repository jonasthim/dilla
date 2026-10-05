import { expect } from '@playwright/test';
import {
  COPY, TEST_TIMEOUT, WAIT, expectAccessible, expectShell, instanceInvite, joinCommunity, messageRow,
  openChannel, railNav, sendText, signUp, splash, tag, test,
} from './support/app';

test.describe.configure({ timeout: TEST_TIMEOUT });

test('a second tab waits while the first holds the device and takes over when it closes', async ({ page, context, peer, instanceName }) => {
  const setup = await peer.setup();
  await peer.register();
  const channel = peer.channelName;
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, channel);
  const browserDevice = (await peer.waitForDevices(2)).find((d) => d !== setup.device_id);

  const second = await context.newPage();
  await second.goto('/');
  await expect(splash(second, COPY.otherTab)).toBeVisible({ timeout: WAIT });
  await expect(railNav(second)).toHaveCount(0);
  await expectAccessible(second, 'other-tab');

  // The first tab keeps working while the second waits.
  const first = `from the first tab ${tag()}`;
  await sendText(page, channel, first);
  await peer.waitFor(first);

  await page.close();
  await expectShell(second);
  await openChannel(second, peer.communityName, channel);
  await expect(messageRow(second, channel, first)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  const later = `from the second tab ${tag()}`;
  await sendText(second, channel, later);
  expect((await peer.waitFor(later)).sender_device).toBe(browserDevice);
  await second.close();
});
