import { expect } from '@playwright/test';
import {
  CONTROL_URL, HEX32, TEST_TIMEOUT, WAIT, composerBox, copy, expectShell, instanceInvite, joinCommunity, messageRow,
  openChannel, sendText, signUp, tag, test,
} from './support/app';

test.describe.configure({ timeout: TEST_TIMEOUT });

/** POST /debug/kick with a community: the production kick, DELETE /v1/communities/{id}/members/{user} on the actor's authority. */
async function kick(actorDevice: string, targetDevice: string, community: string): Promise<void> {
  const res = await fetch(`${CONTROL_URL}/debug/kick`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: actorDevice, target: targetDevice, community }),
  });
  expect(res.status, await res.text()).toBe(204);
}

// INTEGRATION-SEAMS-01: a device removed from a group it holds as active is told so only by 404 E_NOT_FOUND on
// its group reads. The open tab must show that it is no longer a member, and once the person is admitted again
// the device must rejoin the channel's group by external commit and hear and speak in it.
test('a kicked browser shows not-member with its tab open, and after re-admission messages flow again', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup();
  await peer.register();
  const channel = peer.channelName;
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, channel);
  const browserDevice = (await peer.waitForDevices(2)).find((d) => d !== setup.device_id);
  expect(browserDevice).toMatch(HEX32);

  const before = `before the kick ${tag()}`;
  await peer.send(before);
  await expect(messageRow(page, channel, before)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

  // The owner kicks the browser's user; the peer commits the instance's Remove, which never reaches the browser.
  await kick(setup.device_id, browserDevice!, setup.community_id);
  expect(await peer.waitForDevices(1)).toEqual([setup.device_id]);

  // With the tab still open: a send (the person's next action) meets the lost membership. Whichever read
  // finds it first, the composer ends blocked with the not-member reason, and a message that could not
  // leave is shown failed, never "sending…" for ever.
  const box = composerBox(page, channel);
  const lost = `after the kick ${tag()}`;
  if (await box.isEnabled()) {
    await box.fill(lost);
    await box.press('Enter');
    await expect(messageRow(page, channel, lost)).toHaveAttribute('data-state', 'failed', { timeout: WAIT });
  }
  await expect(page.getByText(copy('shell.composer.notMember'), { exact: true })).toBeVisible({ timeout: WAIT });
  await expect(box).toBeDisabled();
  expect(peer.inbox.some((m) => m.body === lost)).toBe(false);

  // Admitted again through the same invite. The not-member copy tells the person to reload; the reload's
  // catch-up meets 404 again, and this time the external join is admitted.
  await joinCommunity(page, peer, setup);
  await page.reload();
  await expectShell(page);
  await openChannel(page, peer.communityName, channel);
  expect((await peer.waitForDevices(2)).sort()).toEqual([setup.device_id, browserDevice!].sort());

  const fromPeer = `peer after re-admission ${tag()}`;
  await peer.send(fromPeer);
  await expect(messageRow(page, channel, fromPeer)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  const fromWeb = `browser after re-admission ${tag()}`;
  await sendText(page, channel, fromWeb);
  expect((await peer.waitFor(fromWeb)).sender_device).toBe(browserDevice);
});
