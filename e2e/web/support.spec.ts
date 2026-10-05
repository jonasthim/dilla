import { readdirSync } from 'node:fs';
import { expect, test } from './support/persistent';
import { WebDriver, testHostUrl, testkitEnv } from './support/driver';
import { injectAxe, runAxe } from './support/axe';

const HEX32 = /^[0-9a-f]{32}$/;
const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;
// L-HTTP-10, exactly, with HOST = 127.0.0.1:8453.
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self' ws://127.0.0.1:8453 wss://127.0.0.1:8453; worker-src 'self'; media-src 'none'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The invite landing's own policy (internal/api/invites.go:107), set on every answer of GET /i/{code}.
const LANDING_CSP = "default-src 'none'; style-src 'unsafe-inline'";

test('the test host serves the client root same-origin, with its headers, to a persistent profile', async ({ page, profileDir }) => {
  expect(profileDir).toMatch(/^\/tmp\/dw\/(chromium|firefox)-core-\d+$/);
  const response = await page.goto('/');
  // A persistent context: the browser wrote its profile into the directory the fixture created empty.
  expect(readdirSync(profileDir).length).toBeGreaterThan(0);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['content-security-policy']).toBe(CSP);
  expect(headers['content-type']).toBe('text/html; charset=utf-8');
  expect(headers['cache-control']).toBe('no-cache');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['permissions-policy']).toBe('camera=(), microphone=(), display-capture=(), geolocation=()');
  expect(headers['cross-origin-opener-policy']).toBeUndefined();
  expect(headers['cross-origin-embedder-policy']).toBeUndefined();
  expect(headers['access-control-allow-origin']).toBeUndefined();
  await expect(page.locator('meta[name="dilla-web"]')).toHaveAttribute('content', 'placeholder', { timeout: WAIT });
  await expect(page.locator('body')).toHaveText('dilla: this build does not include the web client.');
});

test('axe evaluates under the served CSP without a policy violation', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as Window & { cspViolations?: string[] };
    w.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => w.cspViolations!.push(e.violatedDirective));
  });
  await injectAxe(page);
  expect(await page.evaluate(() => (window as Window & { axe?: { version: string } }).axe?.version)).toBe('4.13.0');
  const findings = await runAxe(page);
  for (const f of findings) expect(['serious', 'critical']).toContain(f.impact);
  await expect.poll(() => page.evaluate(() => (window as Window & { cspViolations?: string[] }).cspViolations), { timeout: WAIT }).toEqual([]);
});

test('the native peer enrols and builds its community through the public routes', async ({ request }) => {
  const peer = await WebDriver.start(testHostUrl(), testkitEnv());
  try {
    const s = await peer.setup({ community: 'support community', channel: 'general' });
    expect(s.username).toBe(`peer${(peer.seed & 0xff_ffff).toString(16).padStart(6, '0')}`);
    expect(s.display).toBe(s.username);
    for (const key of ['user_id', 'device_id', 'community_id', 'channel_id'] as const) expect(s[key]).toMatch(HEX32);
    expect(s.invite_code.length).toBeGreaterThan(0);
    const landing = await request.get(`/i/${s.invite_code}`, { headers: { accept: 'application/cbor' } });
    expect(landing.status()).toBe(200);
    expect(landing.headers()['content-type']).toBe('application/cbor');
    expect(landing.headers()['content-security-policy']).toBe(LANDING_CSP);
    const registered = await peer.register();
    expect(registered.group_id).toMatch(HEX32);
    expect(registered.epoch).toBe(0);
    expect((await peer.members()).devices).toEqual([s.device_id]);
    expect(await peer.sync()).toEqual({ epoch: 0, members: 1, received: [] });
  } finally {
    await peer.close();
  }
});
