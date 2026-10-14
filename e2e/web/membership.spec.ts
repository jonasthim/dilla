import { expect } from '@playwright/test';
import {
  CONTROL_URL, HEX32, TEST_TIMEOUT, WAIT, copy, instanceInvite, joinCommunity, messageRow,
  openChannel, railItem, sendText, signUp, tag, test,
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

// INTEGRATION-SEAMS-01, since web3.4: a device removed from a group it holds as active used to learn so only by 404 E_NOT_FOUND
// on its group reads, with the tab showing not-member. The removal now reaches the person as op 54 community_changed: the
// open tab is told (removed.notice) and the server leaves its rail. Once the person is admitted again the server is back
// and the device rejoins the channel's group by external commit, so messages flow both ways.
test('a kicked browser is told and loses the server, and after re-admission messages flow again', async ({ page, peer, instanceName }) => {
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

  // With the tab still open and no action of the person's: the notice names the server and the rail loses it.
  await expect(page.getByText(copy('removed.notice', { server: peer.communityName }), { exact: true }).first()).toBeVisible({ timeout: WAIT });
  await expect(railItem(page, peer.communityName)).toHaveCount(0, { timeout: WAIT });

  // Admitted again through the same invite: the server is back, with no reload, and the browser rejoins the channel's group.
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, channel);
  expect((await peer.waitForDevices(2)).sort()).toEqual([setup.device_id, browserDevice!].sort());

  const fromPeer = `peer after re-admission ${tag()}`;
  await peer.send(fromPeer);
  await expect(messageRow(page, channel, fromPeer)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  const fromWeb = `browser after re-admission ${tag()}`;
  await sendText(page, channel, fromWeb);
  expect((await peer.waitFor(fromWeb)).sender_device).toBe(browserDevice);
});
