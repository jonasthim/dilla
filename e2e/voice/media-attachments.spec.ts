// VOICE-E2E (web-3 task 10): inline audio and video attachments (decision 7, R9, L-UI-71). Alice records a 2 s webm
// (a canvas and an oscillator through MediaRecorder) and builds a 1 s WAV in her page, and sends both with a 40-byte
// truncated copy of the webm; bob plays each from its own player. Nothing plays before his play; a file the browser
// cannot decode shows the error text and save; no securitypolicyviolation (media-src blob: only, RV-5), and every blob:
// URL the players minted is revoked once bob navigates away.
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import { POLL, VoicePeer, WAIT, blobs, buildWav, copy, introduce, onboard, openVoice } from './support/voice';
import { attachInput, composerBox, messageRow, trayEntries } from '../web/support/app';

watchContexts(test);

/** A 2 s webm of a moving canvas and a 440 Hz tone, recorded in the page; base64. */
async function recordWebm(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const g = canvas.getContext('2d');
    if (g === null) throw new Error('no 2d context');
    let frame = 0;
    const draw = () => {
      g.fillStyle = `hsl(${(frame * 9) % 360} 60% 50%)`;
      g.fillRect(0, 0, 160, 120);
      g.fillStyle = '#fff';
      g.fillRect((frame * 4) % 160, 40, 20, 40);
      frame += 1;
    };
    draw();
    const video = canvas.captureStream(25);
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.frequency.value = 440;
    osc.connect(dest);
    osc.start();
    const stream = new MediaStream([...video.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    const timer = setInterval(draw, 40);
    recorder.start(250);
    // The recording's own length, not a wait for a state: the clip is 2 s of media.
    await new Promise((r) => setTimeout(r, 2000));
    recorder.stop();
    await done;
    clearInterval(timer);
    osc.stop();
    for (const t of stream.getTracks()) t.stop();
    await ctx.close();
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

test('bob plays alice\'s webm and WAV inline; a truncated file shows the error and save; every blob: URL is revoked after', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await introduce(peer, [alice, bob]);
    const channel = peer.textName;

    const webm = await recordWebm(alice.page);
    const wav = await buildWav(alice.page);
    expect(webm.length).toBeGreaterThan(1000);
    await attachInput(alice.page).setInputFiles([
      { name: 'clip.webm', mimeType: 'video/webm', buffer: webm },
      { name: 'tone.wav', mimeType: 'audio/wav', buffer: wav },
      { name: 'broken.webm', mimeType: 'video/webm', buffer: webm.subarray(0, 40) },
    ]);
    const entries = trayEntries(alice.page);
    await expect(entries).toHaveCount(3, { timeout: WAIT });
    for (let i = 0; i < 3; i++) await expect(entries.nth(i)).toHaveAttribute('data-phase', 'ready', { timeout: WAIT });
    const text = `three files ${Date.now().toString(16)}`;
    await composerBox(alice.page, channel).fill(text);
    await composerBox(alice.page, channel).press('Enter');
    await expect(messageRow(alice.page, channel, text)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });

    const row = messageRow(bob.page, channel, text);
    await expect(row).toBeVisible({ timeout: WAIT });
    // The players in the order the files were attached: clip.webm, tone.wav, broken.webm.
    const players = row.locator('.d-media-player');
    await expect(players).toHaveCount(3, { timeout: WAIT });
    // Nothing is fetched or played before the person's play: every player is idle, and no blob: URL exists.
    for (let i = 0; i < 3; i++) await expect(players.nth(i)).toHaveAttribute('data-media-state', 'idle');
    expect((await blobs(bob.page)).created.filter((u) => u.startsWith('blob:'))).toEqual([]);

    for (const [i, name, kind] of [[0, 'clip.webm', 'video'], [1, 'tone.wav', 'audio']] as const) {
      await test.step(`play ${name}`, async () => {
        const p = players.nth(i);
        await p.getByRole('button', { name: copy('media.play', { name }), exact: true }).click();
        await expect(p).toHaveAttribute('data-media-state', 'ready', { timeout: WAIT });
        const media = p.locator(kind);
        await expect(media).toHaveAttribute('aria-label', name);
        // Ready is not playing: playback starts only on the person's own play (no autoplay).
        expect(await media.evaluate((m: HTMLMediaElement) => m.paused && m.currentTime === 0 && !m.autoplay)).toBe(true);
        expect(await media.evaluate((m: HTMLMediaElement) => m.src.startsWith('blob:'))).toBe(true);
        await media.evaluate((m: HTMLMediaElement) => m.play());
        await expect.poll(() => media.evaluate((m: HTMLMediaElement) => m.currentTime), POLL).toBeGreaterThan(0);
      });
    }

    await test.step('the truncated copy shows the error text and save', async () => {
      const p = players.nth(2);
      await p.getByRole('button', { name: copy('media.play', { name: 'broken.webm' }), exact: true }).click();
      await expect(p).toHaveAttribute('data-media-state', 'error', { timeout: WAIT });
      // The error line is an x icon (aria-hidden) and the text, in the player's status region.
      await expect(p.locator('.d-media-player__error [data-icon="x"]')).toHaveCount(1);
      await expect(p.locator('.d-media-player__error')).toHaveText(copy('media.error'));
      await expect(p.locator('.d-media-player__save')).toHaveText(copy('media.save'));
    });

    await test.step('every blob: URL the players minted is revoked once bob leaves the conversation', async () => {
      const minted = (await blobs(bob.page)).created.filter((u) => u.startsWith('blob:'));
      expect(minted.length).toBeGreaterThanOrEqual(2);
      await openVoice(bob.page, peer.communityName, peer.voiceName);
      await expect(row).toHaveCount(0, { timeout: WAIT });
      await expect.poll(async () => {
        const b = await blobs(bob.page);
        return b.created.filter((u) => u.startsWith('blob:') && !b.revoked.includes(u));
      }, POLL).toEqual([]);
      await peerBrowser.guard.collectWorkers();
      expect(peerBrowser.guard.cspViolations).toEqual([]);
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
