import { expect } from '@playwright/test';
import {
  CLASS, HEX32, TEST_TIMEOUT, WAIT, expectAccessible, instanceInvite, joinCommunity, logRegion, messageRow,
  openChannel, sendText, shownName, signUp, tag, test,
} from './support/app';

test.describe.configure({ timeout: TEST_TIMEOUT });

test('text flows both ways with the MLS-authenticated sender, and a send after the peer’s Update arrives once', async ({ page, peer, instanceName }) => {
  const setup = await peer.setup();
  await peer.register();
  const channel = peer.channelName;
  await signUp(page, instanceInvite(), instanceName);
  await joinCommunity(page, peer, setup);
  await openChannel(page, peer.communityName, channel);
  const browserDevice = (await peer.waitForDevices(2)).find((d) => d !== setup.device_id);
  expect(browserDevice).toMatch(HEX32);

  // Peer to browser: shown once, confirmed, under the peer's name and not under the id fallback.
  const fromPeer = `from the peer ${tag()}`;
  await peer.send(fromPeer);
  const peerRow = messageRow(page, channel, fromPeer);
  await expect(peerRow).toHaveCount(1, { timeout: WAIT });
  await expect(peerRow).toHaveAttribute('data-state', 'ok');
  await expect(peerRow).toContainText(shownName(setup));
  await expect(peerRow).not.toContainText(setup.user_id.slice(0, 8));

  // Browser to peer: the sender the peer's MLS state authenticates is this browser's device, tier 1.
  const fromWeb = `from the browser ${tag()}`;
  await sendText(page, channel, fromWeb);
  const received = await peer.waitFor(fromWeb);
  expect(received.sender_device).toBe(browserDevice);
  expect(received.tier).toBe(1);
  expect(received.sender_user).toMatch(HEX32);
  expect(received.sender_user).not.toBe(setup.user_id);

  // A send after the peer committed a self-Update (serialised by ruling 25(b), not a race): the browser applies the
  // commit from the live frame, its send goes out at the new epoch (a stale one would be refused 422 and show as
  // failed), and the message exists exactly once on both sides.
  const before = (await peer.sync()).epoch;
  const racing = `during the update ${tag()}`;
  const update = await peer.update();
  await sendText(page, channel, racing);
  expect(update.epoch).toBe(before + 1);
  await peer.waitFor(racing);
  await peer.sync();
  expect(peer.inbox.filter((m) => m.body === racing)).toHaveLength(1);
  await expect(messageRow(page, channel, racing)).toHaveCount(1);
  await expect(messageRow(page, channel, racing)).toHaveAttribute('data-state', 'ok');
  await peer.sync();

  // The browser processed the Update: a peer message of the new epoch decrypts.
  const afterUpdate = `after the update ${tag()}`;
  await peer.send(afterUpdate);
  await expect(messageRow(page, channel, afterUpdate)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
  await peer.sync();
  await expect(messageRow(page, channel, racing)).toHaveCount(1);
  await expect(logRegion(page, channel).locator(`${CLASS.messageRow}[data-state="failed"]`)).toHaveCount(0);
  await expectAccessible(page, 'conversation');
});
