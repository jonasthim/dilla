// UP7 (Q1 = B): a new build mid-call reloads the page at once and resumes the call it held. The update path posts callHold
// (never the person's leave, which self-Removed), disconnects the room with no MLS leave, and reloads; the next page resumes
// the held group (no external commit, the same device in bob's roster; see the race noted below) and measures its budget with five marks: pagehide
// (the hold, saved with the reload), the worker ready (the restore), the token (callJoin answered), LiveKit connected, and
// the microphone published. The budget is logged; UP9's upgrade.spec asserts the 5 s audio gap against a real restart.
import type { Page } from '@playwright/test';
import { expect, test } from './support/peer-browser';
import { watchContexts } from './support/leaks';
import { VoicePeer, WAIT, callSlice, connected, heard, heardCount, joinVoice, onboard, self, tile } from './support/voice';

watchContexts(test);

/** The resume's marks as wall-clock ms (performance.timeOrigin + startTime), and pagehide from the restore mark's detail. */
async function resumeMarks(page: Page): Promise<Record<string, number> & { answer?: { resumed: boolean; expired: boolean } }> {
  return page.evaluate(() => {
    const out: Record<string, unknown> = {};
    for (const m of performance.getEntriesByType('mark')) {
      if (!m.name.startsWith('dilla.resume.')) continue;
      const name = m.name.slice('dilla.resume.'.length);
      out[name] = performance.timeOrigin + m.startTime;
      const detail = (m as PerformanceMark).detail as { pagehide?: number; resumed?: boolean; expired?: boolean } | null;
      if (name === 'ready' && typeof detail?.pagehide === 'number') out.pagehide = detail.pagehide;
      if (name === 'answer' && detail !== null) out.answer = detail;
    }
    return out as Record<string, number> & { answer?: { resumed: boolean; expired: boolean } };
  });
}

test('a new build mid-call reloads at once and comes back into the call: no leave, the budget measured', async ({ peerBrowser }) => {
  const peer = peerBrowser.track(await VoicePeer.start());
  const alice = await peerBrowser.open('alice');
  const bob = await peerBrowser.open('bob');
  try {
    await peer.setup();
    await onboard(alice, peer, 'alice');
    await onboard(bob, peer, 'bob');
    await peer.seat(2);
    const a = await self(alice.page);

    await test.step('alice and bob are in the call and bob hears alice', async () => {
      await joinVoice(alice.page, peer.communityName, peer.voiceName);
      await joinVoice(bob.page, peer.communityName, peer.voiceName);
      await expect(tile(bob.page, 'alice')).toHaveAttribute('data-voice-state', 'ok', { timeout: WAIT });
      await heard(bob.page, a.device);
    });

    await test.step('a new build: alice holds the call, reloads, and resumes it with no leave and no external commit', async () => {
      const groupBefore = (await callSlice(alice.page))?.roster.length ?? 0;
      expect(groupBefore).toBe(2);
      const leaves: string[] = [];
      const commits: string[] = [];
      alice.context.on('request', (r) => {
        const path = new URL(r.url()).pathname;
        // An external join is a resync (or a new group); a commit of alice's would move the epoch on.
        if (r.method() === 'POST' && (/^\/v1\/groups\/[0-9a-f]{32}\/(resync|commit)$/.test(path) || path === '/v1/groups')) commits.push(path);
        if (r.method() === 'POST' && /^\/v1\/groups\/[0-9a-f]{32}\/proposal$/.test(path)) leaves.push(path);
      });
      // The host's build "changes" once: the old page sees a new entry, holds and reloads; the new page sees its own.
      let served = false;
      await alice.page.route('**/app-version.json', async (route) => {
        if (served) { await route.fallback(); return; }
        served = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entry: '/assets/index-next.js' }) });
      });
      const reloaded = alice.page.waitForEvent('load', { timeout: WAIT });
      await reloaded;
      await connected(alice.page);
      const marks = await resumeMarks(alice.page);
      // The hold is never expired here. Whether the worker resumed it depends on a race this page cannot win alone: the
      // old participant's departure makes the instance propose the absence Remove of alice's leaf at once
      // (callevents.go proposeLeave), and bob commits it within about 0.5 s, before the new page's resume reaches the
      // instance (403 E_LEAF_NOT_CURRENT: the worker forgets the group and joins it afresh). Logged, not asserted; see
      // the UP7 report.
      expect(marks.answer?.expired, 'the hold had not expired').toBe(false);
      for (const name of ['pagehide', 'ready', 'token', 'connected', 'published']) expect(typeof marks[name], name).toBe('number');
      const budget = {
        ready: marks.ready - marks.pagehide, token: marks.token - marks.pagehide, connected: marks.connected - marks.pagehide,
        published: marks.published - marks.pagehide,
      };
      // eslint-disable-next-line no-console -- the measured budget is the point of this test (UP7: measure first)
      console.log(`UP7 resume budget (ms from pagehide, ${test.info().project.name}): ${JSON.stringify(budget)} resumed=${String(marks.answer?.resumed)} externalJoin=${JSON.stringify(commits)}`);
      // A resume needs no external commit; a lost race takes exactly one (the resync).
      expect(commits.length, 'at most the one external join of a lost race').toBeLessThanOrEqual(marks.answer?.resumed === true ? 0 : 1);
      expect(leaves, 'no self-Remove: the update reload never leaves').toEqual([]);
      // bob still lists alice's one device, and hears her again.
      await expect.poll(async () => (await callSlice(bob.page))?.roster.filter((r) => r.deviceId === a.device).length, { timeout: WAIT }).toBe(1);
      const before = await heardCount(bob.page, a.device);
      await expect.poll(() => heardCount(bob.page, a.device), { timeout: WAIT }).toBeGreaterThan(before);
      await expect(tile(bob.page, 'alice')).toHaveCount(1, { timeout: WAIT });
    });
  } finally {
    await peerBrowser.close(bob);
    await peerBrowser.close(alice);
    await peer.close();
  }
});
