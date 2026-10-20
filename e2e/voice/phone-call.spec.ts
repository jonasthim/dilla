// web3.7 W-Phone-4: a call on a phone (390 x 844, flow 12). The test host of the web suite has no SFU, so this is the voice
// suite's: the call bar stands above the tab bar while the stage is off screen, the dock holds no controls, the stage
// (opened from the bar) holds the only mute button and takes focus on its title, and back closes it.
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import { VoicePeer, WAIT, copy, joinVoice, onboard, stage } from './support/voice';

watchContexts(test);

test('on a phone the call bar opens the stage, which holds the one mute button, and back closes it', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await peer.seat(1);
    await joinVoice(alice.page, peer.communityName, peer.voiceName);
    const page = alice.page;
    await page.setViewportSize({ width: 390, height: 844 });

    const bar = page.locator('.d-call-bar');
    const tabs = page.getByRole('navigation', { name: copy('nav.tabs.label'), exact: true });
    const mute = page.getByRole('button', { name: copy('voice.mute'), exact: true });
    const back = page.getByRole('button', { name: copy('nav.back'), exact: true });
    const title = page.locator('.d-app-shell__main .d-phone-header__title');

    // On the stage: the call bar steps aside, and the stage's toolbar holds the only mute button.
    await expect(stage(page)).toBeVisible({ timeout: WAIT });
    await expect(bar).toHaveCount(0);
    await expect(mute).toHaveCount(1);

    // Off the stage: the call bar above the tab bar, no dock.
    await back.click();
    await expect(tabs).toBeVisible({ timeout: WAIT });
    await expect(bar).toBeVisible({ timeout: WAIT });
    await expect(page.locator('.d-voice-dock')).toHaveCount(0);
    await expect(mute).toHaveCount(1); // the call bar's own
    const [b, t] = await Promise.all([bar.boundingBox(), tabs.boundingBox()]);
    expect(b !== null && t !== null && b.y + b.height <= t.y + 1, 'the call bar sits above the tab bar').toBe(true);

    // The bar opens the stage: focus on its title, the bar gone, one mute button in the DOM.
    await bar.locator('.d-call-bar__open').click();
    await expect(stage(page)).toBeVisible({ timeout: WAIT });
    await expect(title).toBeFocused();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.d-voice-dock')).toHaveCount(0);
    await expect(mute).toHaveCount(1);

    // Back closes the stage; the call goes on, in the bar. Leave from there.
    await back.click();
    await expect(bar).toBeVisible({ timeout: WAIT });
    await expect(stage(page)).toBeHidden();
    await bar.getByRole('button', { name: copy('voice.leave'), exact: true }).click();
    await expect(bar).toHaveCount(0, { timeout: WAIT });
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});

// web3.8 FX (final review m9): a real phone has no getDisplayMedia, and its stage offers no share button. Chromium's
// emulation keeps getDisplayMedia, so the page loses it here; with it, the same phone stage offers share (the control).
test('on a phone without getDisplayMedia the stage offers no share button', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await peer.seat(1);
    const page = alice.page;
    await joinVoice(page, peer.communityName, peer.voiceName);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(stage(page)).toBeVisible({ timeout: WAIT });
    const toolbar = stage(page).getByRole('toolbar');
    const share = toolbar.getByRole('button', { name: copy('voice.shareOn'), exact: true });
    const mute = toolbar.getByRole('button', { name: copy('voice.mute'), exact: true });
    await expect(mute).toBeVisible({ timeout: WAIT });
    await expect(share).toHaveCount(1);

    await page.evaluate(() => { Reflect.deleteProperty(MediaDevices.prototype, 'getDisplayMedia'); });
    expect(await page.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia)).toBe('undefined');
    // Any change of the call renders the toolbar again: a mute and an unmute.
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'true', { timeout: WAIT });
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false', { timeout: WAIT });
    await expect(share).toHaveCount(0);
    const leave = toolbar.getByRole('button', { name: copy('voice.leave'), exact: true });
    await expect(leave).toBeVisible();
    await leave.click();
    await expect(toolbar).toHaveCount(0, { timeout: WAIT });
  } finally {
    await peerBrowser.close(alice);
    await peer.close();
  }
});
