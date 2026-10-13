// PROBE-E2E (task 2, L-PROBE-1): `netprobe prepare`, `arm` and `start` against the probe test host, and two probe
// pages that join the DM call with the start JSONs and publish their tones. Side a talks to the test host directly;
// side b goes through the probe page's dev server proxy, the path both machines take in the session.
//
// Two calls run on the same state directories, as the session's legs do: the first call's end closes its call group
// (`endCall`, the same closed state the instance's 600 s idle close leaves), so the second run arms a fresh group on
// side a, joins it on side b, and side a's `start` must merge side b's external commit before handing out a key.
// The loss bound is a check of the arithmetic on loopback, not a performance claim.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProbeReport } from '../../packages/media/probe/report';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTKIT = process.env.DILLA_TESTKIT ?? join(REPO_ROOT, 'target', 'release', 'dilla-testkit');
const PROBE_HOST = 'http://127.0.0.1:8485';
const PROBE_PAGE = 'http://127.0.0.1:5191';
// `localhost`, as the session checklist writes it (its redaction gate keeps IP literals out of the document).
const VIA_PROXY = 'http://localhost:5191';
const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;

function netprobe(args: string[]): string {
  return execFileSync(TESTKIT, ['netprobe', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `arm`'s outcome word, or `live` while the previous call has not ended yet. */
function arm(instance: string, side: string): string {
  try {
    return / (kept|registered|joined) at epoch /.exec(netprobe(['arm', '--instance', instance, '--state', side]))?.[1] ?? 'unknown';
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? err);
    if (stderr.includes('still live')) return 'live';
    throw new Error(stderr);
  }
}

interface ProbeWindow { __probe: { audioState(): string; report(): ProbeReport | null; failure(): string | null } }
interface StartJson { groupId: string; keys: { epoch: string; selfLeaf: number; roster: unknown[] } }

async function load(page: Page, json: string, query: string): Promise<void> {
  await page.goto(`${PROBE_PAGE}/?${query}`);
  await page.locator('#label').fill(json.endsWith('a.json') ? 'side-a' : 'side-b');
  await page.locator('#file').setInputFiles(json);
  await expect(page.locator('#status')).toContainText('loaded', { timeout: WAIT });
}

/** Starts both sides, presses Start on both pages and answers both reports, checked for verified UDP media. */
async function call(pages: Page[], dir: string, run: string, browserName: string, opts: { query: string; silence: boolean }): Promise<{ reports: ProbeReport[]; starts: StartJson[] }> {
  const files = [join(dir, `${run}-a.json`), join(dir, `${run}-b.json`)];
  // Each side is started right before its page is loaded and pressed, well inside the 30 s admission window.
  netprobe(['start', '--instance', PROBE_HOST, '--state', join(dir, 'side-a'), '--out', files[0]]);
  netprobe(['start', '--instance', VIA_PROXY, '--state', join(dir, 'side-b'), '--out', files[1]]);
  const starts = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as StartJson);
  for (const [i, page] of pages.entries()) await load(page, files[i], opts.query);
  if (browserName === 'firefox') {
    // A suspended context publishes silence, DTX sends nothing, and the loss figure would read as a false pass.
    for (const page of pages) {
      await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__probe.audioState()), { timeout: WAIT }).toBe('running');
    }
  }
  for (const page of pages) await page.locator('#start').click();
  if (opts.silence) {
    // Leg 3's button: side b sends no RTP for a while and then resumes.
    await expect(pages[1].locator('#silence')).toBeEnabled({ timeout: WAIT });
    await pages[1].locator('#silence').click();
  }
  const reports: ProbeReport[] = [];
  for (const page of pages) {
    await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__probe.report() !== null), { timeout: 120_000 }).toBe(true);
    expect(await page.evaluate(() => (window as unknown as ProbeWindow).__probe.failure())).toBeNull();
    reports.push((await page.evaluate(() => (window as unknown as ProbeWindow).__probe.report())) as ProbeReport);
  }
  for (const r of reports) {
    console.log(`${browserName} ${run} ${r.label}: pair ${r.pair?.local}/${r.pair?.remote}/${r.pair?.protocol}, joinMs ${JSON.stringify(r.joinMs)}, `
      + `summary ${JSON.stringify(r.summary)}, last ${JSON.stringify(r.samples.at(-1))}, `
      + `${r.events.filter((e) => e.what.startsWith('drops')).map((e) => e.what).join('; ') || 'no drops'}`);
    expect(r.v).toBe(1);
    expect(r.pair?.protocol).toBe('udp');
    expect(r.joinMs.connected).not.toBeNull();
    expect(r.joinMs.firstVerifiedRemote).not.toBeNull();
    expect(r.summary.lossPct).toBeLessThan(5);
    expect(r.summary.relayUnavailable).toBe(false);
    expect(r.samples.length).toBeGreaterThan(5);
    expect(r.samples.at(-1)?.packetsReceived).toBeGreaterThan(0);
    expect(r.samples.at(-1)?.verifiedRemote).toBeGreaterThan(0);
    for (const c of r.candidates) expect(Object.keys(c).sort()).toEqual(['protocol', 'type']);
  }
  // Both sides hand out the same epoch with both leaves: side a merged side b's join.
  expect(starts[0].groupId).toBe(starts[1].groupId);
  expect(starts[0].keys.epoch).toBe(starts[1].keys.epoch);
  for (const s of starts) expect(s.keys.roster).toHaveLength(2);
  return { reports, starts };
}

test('two probe pages join a DM call over UDP and report verified media, twice on one pair', async ({ browser, browserName }) => {
  const invite = process.env.DILLA_PROBE_INVITE;
  if (!invite) throw new Error('DILLA_PROBE_INVITE is unset: e2e/probe/global-setup.ts exports it from the test host banner');
  const dir = mkdtempSync(join(tmpdir(), 'netprobe-'));
  const sideA = join(dir, 'side-a');
  const sideB = join(dir, 'side-b');
  const before = browser.contexts().length;
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const prepared = netprobe(['prepare', '--instance', PROBE_HOST, '--invite', invite, '--out', dir]);
    const names = [...prepared.matchAll(/^account [ab]: (netprobe-[ab]-[0-9a-f]{6})$/gm)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(names[0].slice(-6)).toBe(names[1].slice(-6));
    // A fresh pair is armed already: arming is a no-op on both sides.
    expect(arm(PROBE_HOST, sideA)).toBe('kept');
    expect(arm(VIA_PROXY, sideB)).toBe('kept');

    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    // 15 s of samples and a 3 s silence: enough for a loopback check; the session runs the 60 s and 45 s defaults.
    const first = await call(pages, dir, 'run1', browserName, { query: 'seconds=15&silence=3', silence: true });
    const silence = first.reports[1].events.map((e) => e.what).filter((w) => w.startsWith('silence'));
    expect(silence).toEqual(['silence start', 'silence end']);
    // Side a kept authenticating side b's frames after the silence ended.
    const tail = first.reports[0].samples.slice(-4);
    expect(tail[3].verifiedRemote).toBeGreaterThan(tail[0].verifiedRemote);
    await expect(pages[0].locator('#download')).toBeEnabled();

    // While the first call is live, arm refuses on both sides. A real instance ends it about 20 s after both pages
    // left (LiveKit's room_finished); the test host has no LiveKit webhooks, so the call is ended through the public
    // route as `netprobe end` does it. Either way its group is closed, the state RV-2's idle close also leaves.
    expect(arm(PROBE_HOST, sideA)).toBe('live');
    expect(arm(VIA_PROXY, sideB)).toBe('live');
    expect(netprobe(['end', '--instance', PROBE_HOST, '--state', sideA])).toMatch(/^call [0-9a-f]{32} ended/);
    expect(netprobe(['end', '--instance', PROBE_HOST, '--state', sideA])).toMatch(/^no call is live/);
    // The closed group's state is refused by start until both sides are armed again.
    expect(() => netprobe(['start', '--instance', PROBE_HOST, '--state', sideA, '--out', join(dir, 'stale.json')])).toThrow(/run arm again/);
    expect(arm(PROBE_HOST, sideA)).toBe('registered');
    // Arming again is a no-op; side b joins the fresh group through the proxy.
    expect(arm(PROBE_HOST, sideA)).toBe('kept');
    expect(arm(VIA_PROXY, sideB)).toBe('joined');
    const second = await call(pages, dir, 'run2', browserName, { query: 'seconds=10', silence: false });
    expect(second.starts[0].groupId).not.toBe(first.starts[0].groupId);
    expect(BigInt(second.starts[0].keys.epoch)).toBeGreaterThan(0n);

    // M3: the dev server refuses to serve the probe's own state through /@fs.
    const canaryDir = join(REPO_ROOT, 'target', 'netprobe', 'e2e-canary');
    mkdirSync(canaryDir, { recursive: true });
    writeFileSync(join(canaryDir, 'side.json'), '{"canary":"netprobe-e2e-canary"}');
    try {
      const res = await pages[0].request.get(`${PROBE_PAGE}/@fs${join(canaryDir, 'side.json')}`);
      // The dev server refuses it (403); the static preview has no /@fs and answers its index page instead.
      if (process.env.DILLA_PROBE_PREVIEW !== '1') expect(res.status()).toBe(403);
      expect(await res.text()).not.toContain('netprobe-e2e-canary');
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }
  } finally {
    for (const c of contexts) await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(browser.contexts().length).toBe(before);
});
