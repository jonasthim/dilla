// PROBE-E2E (task 2, L-PROBE-1): `netprobe prepare` and `netprobe start` against the probe test host, and two probe
// pages that join the DM call with the start JSONs and publish their tones. Side a starts against the test host
// directly; side b goes through the probe page's dev server proxy, the path both machines take in the session.
// The loss bound is a check of the arithmetic on loopback, not a performance claim.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProbeReport } from '../../packages/media/probe/report';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTKIT = process.env.DILLA_TESTKIT ?? join(REPO_ROOT, 'target', 'release', 'dilla-testkit');
const PROBE_HOST = 'http://127.0.0.1:8485';
const PROBE_PAGE = 'http://127.0.0.1:5191';
const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;

function netprobe(args: string[]): string {
  return execFileSync(TESTKIT, ['netprobe', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface ProbeWindow { __probe: { audioState(): string; report(): ProbeReport | null; failure(): string | null } }

async function load(page: Page, json: string): Promise<void> {
  // 15 s of samples and a 3 s silence: enough for a loopback check; the session runs the 60 s and 45 s defaults.
  await page.goto(`${PROBE_PAGE}/?seconds=15&silence=3`);
  await page.locator('#label').fill(json.endsWith('a.json') ? 'side-a' : 'side-b');
  await page.locator('#file').setInputFiles(json);
  await expect(page.locator('#status')).toContainText('loaded', { timeout: WAIT });
}

test('two probe pages join a DM call over UDP and report verified media', async ({ browser, browserName }) => {
  const invite = process.env.DILLA_PROBE_INVITE;
  if (!invite) throw new Error('DILLA_PROBE_INVITE is unset: e2e/probe/global-setup.ts exports it from the test host banner');
  const dir = mkdtempSync(join(tmpdir(), 'netprobe-'));
  const before = browser.contexts().length;
  const contexts = [await browser.newContext(), await browser.newContext()];
  try {
    const prepared = netprobe(['prepare', '--instance', PROBE_HOST, '--invite', invite, '--out', dir]);
    const names = [...prepared.matchAll(/^account [ab]: (netprobe-[ab]-[0-9a-f]{6})$/gm)].map((m) => m[1]);
    expect(names).toHaveLength(2);
    expect(names[0].slice(-6)).toBe(names[1].slice(-6));

    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    const files = [join(dir, 'a.json'), join(dir, 'b.json')];
    // Each side is started right before its page is loaded and pressed, well inside the 30 s admission window.
    netprobe(['start', '--instance', PROBE_HOST, '--state', join(dir, 'side-a'), '--out', files[0]]);
    // `localhost`, as the session checklist writes it (its redaction gate keeps IP literals out of the document).
    netprobe(['start', '--instance', 'http://localhost:5191', '--state', join(dir, 'side-b'), '--out', files[1]]);
    for (const [i, page] of pages.entries()) await load(page, files[i]);

    if (browserName === 'firefox') {
      // A suspended context publishes silence, DTX sends nothing, and the loss figure would read as a false pass.
      for (const page of pages) {
        await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__probe.audioState()), { timeout: WAIT }).toBe('running');
      }
    }
    for (const page of pages) await page.locator('#start').click();
    // Leg 3's button: side b sends no RTP for a while and then resumes.
    await expect(pages[1].locator('#silence')).toBeEnabled({ timeout: WAIT });
    await pages[1].locator('#silence').click();

    const reports: ProbeReport[] = [];
    for (const page of pages) {
      await expect.poll(() => page.evaluate(() => (window as unknown as ProbeWindow).__probe.report() !== null), { timeout: 120_000 }).toBe(true);
      const failure = await page.evaluate(() => (window as unknown as ProbeWindow).__probe.failure());
      expect(failure).toBeNull();
      reports.push((await page.evaluate(() => (window as unknown as ProbeWindow).__probe.report())) as ProbeReport);
    }
    for (const r of reports) {
      console.log(`${browserName} ${r.label}: pair ${r.pair?.local}/${r.pair?.remote}/${r.pair?.protocol}, joinMs ${JSON.stringify(r.joinMs)}, `
        + `summary ${JSON.stringify(r.summary)}, last ${JSON.stringify(r.samples.at(-1))}, `
        + `${r.events.filter((e) => e.what.startsWith('drops')).map((e) => e.what).join('; ') || 'no drops'}`);
      expect(r.v).toBe(1);
      expect(r.pair?.protocol).toBe('udp');
      expect(r.joinMs.firstVerifiedRemote).not.toBeNull();
      expect(r.summary.lossPct).toBeLessThan(5);
      expect(r.summary.relayUnavailable).toBe(false);
      expect(r.samples.length).toBeGreaterThan(5);
      expect(r.samples.at(-1)?.packetsReceived).toBeGreaterThan(0);
      expect(r.samples.at(-1)?.verifiedRemote).toBeGreaterThan(0);
      for (const c of r.candidates) expect(Object.keys(c).sort()).toEqual(['protocol', 'type']);
    }
    const silence = reports[1].events.map((e) => e.what).filter((w) => w.startsWith('silence'));
    expect(silence).toEqual(['silence start', 'silence end']);
    // Side a kept authenticating side b's frames after the silence ended.
    const tail = reports[0].samples.slice(-4);
    expect(tail[3].verifiedRemote).toBeGreaterThan(tail[0].verifiedRemote);
    await expect(pages[0].locator('#download')).toBeEnabled();
  } finally {
    for (const c of contexts) await c.close();
    rmSync(dir, { recursive: true, force: true });
  }
  expect(browser.contexts().length).toBe(before);
});
