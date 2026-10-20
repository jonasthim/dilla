// web3.8, E2: a tab speaking an older wire version than the host offers is told so, and the reload it offers keeps the work.
// The default host offers wire 2 (the web3.8 client's); a host started with `-wire 3` offers only 3, so that client is refused
// two ways: the hello does not offer its version (the client closes the socket itself), and the server closes 4006. Both
// put the worker offline with reason 'version' (no reconnect loop), and the page shows `shell.banner.clientTooOld` with
// `reload.action`. Pressing it checkpoints the draft first (WS3), so the draft is back after the page has reloaded.
// Ada's account lives in /tmp/dw/host-8515, which the three hosts of this suite share (`keepData`).
import { expect, type Page, type TestInfo } from '@playwright/test';
import { addServerVia, TEST_TIMEOUT, WAIT, copy, composerBox, expectAccessible, expectComposerReady, railNav, signUp, test } from './support/app';
import { removeHostData, startTestHost, type HostConfig, type StartedHost } from './support/host';
import { arr, decode } from '../../packages/client-core/src/cbor/index';

const WIRE2: HostConfig = { port: 8515, control: 8516, webRoot: 'packages/web/dist', keepData: true };
const WIRE3: HostConfig = { ...WIRE2, wire: 3 };
const SERVER = 'Midgard Crew';
const DRAFT = 'a half-written thought that must outlive the reload';
const QUIET_MS = 4_000;
const BACKOFF_WAIT = WAIT + 60_000;

let host: StartedHost | null = null;
let instance = '';

test.describe.configure({ mode: 'serial', timeout: TEST_TIMEOUT });
test.use({ baseURL: `http://127.0.0.1:${String(WIRE2.port)}` });

test.beforeAll(async () => {
  removeHostData(WIRE2.port);
  host = await startTestHost(WIRE2);
  const res = await fetch(`${host.url}/v1/instance`, { headers: { accept: 'application/cbor' } });
  expect(res.status, 'GET /v1/instance').toBe(200);
  const name = arr(decode(new Uint8Array(await res.arrayBuffer())))[5];
  if (typeof name !== 'string' || name === '') throw new Error('GET /v1/instance: element 5 is not the instance name');
  instance = name;
});
test.afterAll(async () => { await host?.stop(); removeHostData(WIRE2.port); });

/** Stops the running host and starts `next` on the same ports and the same data. */
async function swapHost(next: HostConfig): Promise<void> {
  await host?.stop();
  host = null;
  host = await startTestHost(next);
}

const banner = (page: Page) => page.getByText(copy('shell.banner.clientTooOld'), { exact: true });
const reloadButton = (page: Page) => page.getByRole('button', { name: copy('reload.action'), exact: true });

const isChromium = (info: TestInfo) => info.project.name.startsWith('chromium');

/** Runs first in every dedicated worker of the page (chromium only): while `refuse` is set, each gateway WebSocket closes itself 4006 once
 *  it is open, which the gateway reads as the server's own close. Playwright's WebSocket routes do not reach a worker's sockets, so
 *  this attaches to the worker through the DevTools protocol while it waits for its debugger, runs the patch, and lets it start. */
const refusePatch = `(()=>{const N=self.WebSocket;self.WebSocket=class extends N{constructor(u,p){super(u,p);`
  + `this.addEventListener('open',()=>{if(self.__refuse)this.close(4006,'E_VERSION');});}};})();`;

/** Counts the gateway sockets the page opens (workers' included: the page event sees them) and its `load` events. */
async function watch(page: Page): Promise<{ sockets: () => number; loads: () => number; refuse: (on: boolean) => Promise<void> }> {
  let sockets = 0;
  let loads = 0;
  page.on('load', () => { loads += 1; });
  page.on('websocket', (ws) => { if (ws.url().endsWith('/gateway')) sockets += 1; });
  let refusing = false;
  if (isChromium(test.info())) {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Target.attachedToTarget', (e: { sessionId: string; targetInfo: { type: string } }) => {
      void (async () => {
        if (e.targetInfo.type !== 'worker') return;
        const send = (method: string, params: object = {}) => cdp.send('Target.sendMessageToTarget' as never, { sessionId: e.sessionId, message: JSON.stringify({ id: 1, method, params }) } as never);
        await send('Runtime.evaluate', { expression: `self.__refuse=${String(refusing)};${refusePatch}` });
        await send('Runtime.runIfWaitingForDebugger');
      })();
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  }
  return { sockets: () => sockets, loads: () => loads, refuse: async (on) => { refusing = on; } };
}

async function expectNoReconnect(page: Page, sockets: () => number): Promise<void> {
  const opened = sockets();
  await page.waitForTimeout(QUIET_MS);
  expect(sockets(), `gateway sockets opened in ${String(QUIET_MS)} ms after the version refusal`).toBe(opened);
}

test('a tab older than the host is refused two ways: banner, no reconnect, and Reload keeps the draft', async ({ page }) => {
  const h = host;
  if (h === null) throw new Error('the test host did not start');
  await page.setViewportSize({ width: 1280, height: 800 });
  const seen = await watch(page);
  await signUp(page, h.invite.split(',')[0], instance, 'Ada', h.control);
  await addServerVia(page, 'create');
  const start = page.getByRole('dialog', { name: copy('create.server.title'), exact: true });
  await start.getByRole('textbox', { name: copy('create.server.name'), exact: true }).fill(SERVER);
  await page.keyboard.press('Enter');
  await expect(start).toBeHidden({ timeout: WAIT });
  await expectComposerReady(page, 'general');
  await expect(banner(page)).toHaveCount(0);
  await composerBox(page, 'general').fill(DRAFT);

  // The wire-2 host goes, a wire-3 host takes its ports: the tab reconnects, the hello offers no wire 2, and the client stops.
  await swapHost(WIRE3);
  // The tab was backing off (up to 30 s) while no host answered, so the next attempt can be that far away.
  await expect(banner(page)).toBeVisible({ timeout: BACKOFF_WAIT });
  await expect(reloadButton(page)).toBeVisible();
  await expectNoReconnect(page, seen.sockets);
  await expectAccessible(page, 'version refused: banner shown');

  // Reload checkpoints the draft first; the page loads once more and the draft is in the composer again.
  const loadsBefore = seen.loads();
  await reloadButton(page).click();
  await expect.poll(seen.loads, { timeout: WAIT }).toBe(loadsBefore + 1);
  await expect(composerBox(page, 'general')).toHaveValue(DRAFT, { timeout: WAIT });
  await expect(banner(page)).toBeVisible({ timeout: WAIT });

  // A host that offers wire 2 again loads the app normally: no banner.
  await swapHost(WIRE2);
  await page.reload();
  await expectComposerReady(page, 'general');
  await expect(banner(page)).toHaveCount(0);
  await expectAccessible(page, 'wire 2 again: no banner');

  // The other client path: the server closes the socket 4006 itself (chromium only: the close is injected into the worker over the
  // DevTools protocol). The same tab, the same banner, still no reconnect loop.
  if (!isChromium(test.info())) return;
  await seen.refuse(true);
  const before = seen.sockets();
  await page.reload();
  await expect(banner(page)).toBeVisible({ timeout: WAIT });
  await expect(reloadButton(page)).toBeVisible();
  await expectNoReconnect(page, seen.sockets);
  expect(seen.sockets() - before, 'one socket after the reload, refused once').toBe(1);
});
