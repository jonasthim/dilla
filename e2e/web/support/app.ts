// The web e2e suite's page-level support (task 25): the native peer, the page contract the specs drive
// (the copy keys of en.ts, landmarks, the L-UI root classes, data-state), the CSP/console guard every test
// carries (every page and the core worker), the onboarding and shell drivers, and the probes of the
// device-key record and the instance clock. Every wait waits for a state, never for a duration (lesson c).
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { test as persistentTest } from './persistent';
import { WebDriver, type PeerEnrolled, type PeerSetup } from './driver';
export type { PeerEnrolled, PeerSetup } from './driver';
import { runAxe } from './axe';
import { arr, decode } from '../../../packages/client-core/src/cbor/index';
import { en } from '../../../packages/web/src/strings/en';
import { t } from '../../../packages/web/src/strings/index';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const HOST = '127.0.0.1:8463';
export const PUBLIC_URL = `http://${HOST}`;
export const CONTROL_URL = 'http://127.0.0.1:8464';
/** One wait for one state. The CI runner has 4 vCPUs and is 3-5x slower than the dev machine. */
export const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;
export const TEST_TIMEOUT = process.env.CI === 'true' ? 480_000 : 180_000;
/** dillad's browser session lifetime (internal/config/defaults.go:78, BrowserLifetime 168h) plus one hour. */
export const PAST_BROWSER_SESSION_S = 169 * 3600;
/** One recovery-key group: four Crockford base32 characters (protocol/03 "Recovery"). */
export const RK_GROUP = /^[0-9A-HJKMNP-TV-Z]{4}$/;
export const HEX32 = /^[0-9a-f]{32}$/;
/** The console line Chromium and WebKit print for a response the client answers or retries by design (E2E-CI-01). */
export const BY_DESIGN_RESOURCE_LINE = /^Failed to load resource: the server responded with a status of (401|404|409|410|429|503) \(/;

// The copy keys the e2e drives: L-COPY-01 (onboarding) and the keys tasks 22 and 24 add to en.ts. The
// values always come from the app's own strings, so a reworded text never breaks the suite.
export const COPY = {
  otherTab: 'boot.otherTab.status',
  storeLost: 'boot.storeLost.status',
  storeLostAction: 'boot.storeLost.action',
  storeLostConfirmTitle: 'boot.storeLost.confirmTitle',
  storeLostConfirm: 'boot.storeLost.confirmAction',
  connectTitle: 'onboarding.connect.title',
  inviteLabel: 'onboarding.connect.invite',
  identityTitle: 'onboarding.identity.title',
  usernameLabel: 'onboarding.identity.username',
  displayLabel: 'onboarding.identity.display',
  passwordLabel: 'onboarding.identity.password',
  keysTitle: 'onboarding.keys.title',
  keysAcknowledge: 'onboarding.keys.acknowledge',
  deviceTitle: 'onboarding.browser.title',
  submit: 'onboarding.browser.submit',
  doneTitle: 'onboarding.done.title',
  next: 'onboarding.next',
  finish: 'onboarding.done.next',
  skipLink: 'shell.skip',
  railLabel: 'shell.rail.label',
  railJoin: 'shell.rail.join',
  joinTitle: 'join.title',
  joinInvite: 'join.invite',
  joinSubmit: 'join.submit',
  channelsLabel: 'shell.channels.label',
  logLabel: 'shell.log.label',
  composerLabel: 'shell.composer.label',
  statusBarLabel: 'shell.status.label',
} as const;

export const SIGNIN = {
  entry: 'onboarding.connect.signIn', step: 'signin.step',
  loginTitle: 'signin.login.title', username: 'signin.login.username',
  password: 'signin.login.password', loginSubmit: 'signin.login.submit',
  keyTitle: 'signin.key.title', keyLabel: 'signin.key.label',
  keyHint: 'signin.key.hint', keySubmit: 'signin.key.submit',
  keyLength: 'signin.error.keyLength', wrongKey: 'signin.error.wrongKey',
  doneTitle: 'signin.done.title', doneBody: 'signin.done.body', doneNext: 'signin.done.next',
} as const;

// The root classes of five L-UI components (plan head, L-UI class rule: d-<kebab-case component name>).
export const CLASS = {
  onboardingFrame: '.d-onboarding-frame',
  recoveryKey: '.d-recovery-key',
  channelHeader: '.d-channel-header',
  messageRow: '.d-message-row',
  composer: '.d-composer',
  deviceRow: '.d-device-row',
  channelRow: '.d-chrow',
} as const;

export function copy(key: string, vars?: Record<string, string | number>): string {
  if (!Object.hasOwn(en, key)) {
    throw new Error(`packages/web/src/strings/en.ts has no key "${key}"; the web e2e page contract (task 25) drives it`);
  }
  return t(key as keyof typeof en, vars);
}

// ---------------------------------------------------------------------------------------------------
// The native peer: one web-driver process per test.

export interface PeerSetupOptions { password?: string; channels?: number; }
export const PEER_PASSWORD = 'peer-password-1234';
export interface PeerMessage { seq: number; body: string; sender_user: string; sender_device: string; tier: number; }
interface SyncAnswer { epoch: number; members: number; received: PeerMessage[]; }

export class Peer {
  /** Every message the peer decrypted, across all syncs of this test. */
  readonly inbox: PeerMessage[] = [];
  /** The one text channel setup creates; the specs name it when they address the log and the composer. */
  readonly channelName = 'general';
  channelNames: string[] = ['general'];
  communityName = '';

  private constructor(private readonly driver: WebDriver, readonly seed: number) {}

  static async start(): Promise<Peer> {
    const invite = process.env.DILLA_TESTKIT_INVITE;
    if (!invite) throw new Error('DILLA_TESTKIT_INVITE is unset: the web global setup exports it from the test host banner');
    const seed = randomInt(1, 0xff_ffff);
    const driver = await WebDriver.start(PUBLIC_URL, { DILLA_TESTKIT_INVITE: invite, DILLA_TESTKIT_CONTROL: CONTROL_URL }, seed);
    return new Peer(driver, seed);
  }

  async setup(opts: PeerSetupOptions = {}): Promise<PeerSetup> {
    this.communityName = `e2e-${this.seed.toString(16)}`;
    const channels = opts.channels ?? 1;
    const s = await this.driver.setup({
      community: this.communityName, channel: this.channelName,
      ...(opts.password === undefined ? {} : { password: opts.password }),
      ...(opts.channels === undefined ? {} : { channels: opts.channels }),
    });
    for (const id of [s.user_id, s.device_id, s.community_id, s.channel_id, ...s.channel_ids]) expect(id).toMatch(HEX32);
    expect(s.channel_ids).toHaveLength(channels);
    expect(s.channel_ids[0]).toBe(s.channel_id);
    // L-E2E-10: the channels are named <channel>, <channel>-2 … <channel>-<n> in creation order.
    this.channelNames = [this.channelName, ...Array.from({ length: channels - 1 }, (_, i) => `${this.channelName}-${i + 2}`)];
    return s;
  }

  register(): Promise<{ group_id: string; epoch: number }> { return this.driver.request('register', {}); }
  send(body: string): Promise<{ seq: number }> { return this.driver.request('send', { body }); }
  /** L-E2E-01 `update`: drains and applies, then commits a self Update and answers the new epoch. */
  update(): Promise<{ epoch: number }> { return this.driver.request('update', {}); }
  /** L-E2E-10 `enrol` through the driver's wrapper (driver.ts, this task). */
  enrol(): Promise<PeerEnrolled> { return this.driver.enrol(); }
  /** L-E2E-10 `revoke` through the driver's wrapper (driver.ts, this task). */
  revoke(deviceId: string): Promise<{ version: number }> { return this.driver.revoke(deviceId); }

  async sync(): Promise<SyncAnswer> {
    const answer = await this.driver.request<SyncAnswer>('sync', {});
    this.inbox.push(...answer.received);
    return answer;
  }

  async devices(): Promise<string[]> {
    return (await this.driver.request<{ devices: string[] }>('members', {})).devices;
  }

  /** Syncs until a message with exactly this body has been decrypted, and returns it. */
  async waitFor(body: string): Promise<PeerMessage> {
    await expect.poll(async () => {
      await this.sync();
      return this.inbox.some((m) => m.body === body);
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(true);
    const found = this.inbox.find((m) => m.body === body);
    if (!found) throw new Error(`the peer never decrypted ${JSON.stringify(body)}`);
    return found;
  }

  /** Syncs until the text group's roster holds `count` devices, and returns them. */
  async waitForDevices(count: number): Promise<string[]> {
    let devices: string[] = [];
    await expect.poll(async () => {
      await this.sync();
      devices = await this.devices();
      return devices.length;
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(count);
    return devices;
  }

  close(): Promise<void> { return this.driver.close(); }
}

export function instanceInvite(): string {
  const codes = process.env.DILLA_TESTKIT_INVITE;
  if (!codes) throw new Error('DILLA_TESTKIT_INVITE is unset: the web global setup exports it from the test host banner');
  return codes.split(',')[0];
}

/** A short random suffix that makes a message body unique within the run. */
export function tag(): string { return randomInt(0, 0xff_ffff).toString(16).padStart(6, '0'); }

/** The author name the shell shows for the peer: its display name, else its username (task 24). */
export function shownName(s: PeerSetup): string { return s.display !== '' ? s.display : s.username; }

// ---------------------------------------------------------------------------------------------------
// The guard: no CSP violation, no console error, no uncaught error, in any page of the context and in
// its core worker. A dedicated worker takes its policy from its own script response (ruling 31), and its
// violations fire on the worker global, which the page's init script never reaches.

export interface CspViolation { directive: string; blockedURI: string; sourceFile: string; sample: string; }
export interface Guard {
  readonly cspViolations: CspViolation[];
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  attach(context: BrowserContext): Promise<void>;
  /** Moves every violation the tracked workers recorded into cspViolations (and empties their lists). */
  collectWorkers(): Promise<void>;
}

function newGuard(projectName: string): Guard {
  const cspViolations: CspViolation[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const workers: Worker[] = [];
  const watchWorker = (w: Worker): void => {
    workers.push(w);
    void w.evaluate(() => {
      const g = self as unknown as { __dillaCsp?: unknown[] };
      g.__dillaCsp = [];
      self.addEventListener('securitypolicyviolation', (e) => {
        const v = e as SecurityPolicyViolationEvent;
        g.__dillaCsp!.push({ directive: v.violatedDirective, blockedURI: v.blockedURI, sourceFile: v.sourceFile, sample: v.sample });
      });
    }).catch(() => undefined);
  };
  const watchPage = (p: Page): void => {
    p.on('worker', watchWorker);
    for (const w of p.workers()) watchWorker(w);
  };
  return {
    cspViolations, consoleErrors, pageErrors,
    async attach(context: BrowserContext): Promise<void> {
      await context.exposeBinding('__dillaCspViolation', (_source, v: CspViolation) => { cspViolations.push(v); });
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          (window as unknown as { __dillaCspViolation(v: unknown): void }).__dillaCspViolation({
            directive: e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, sample: e.sample,
          });
        });
      });
      context.on('console', (m) => {
        // Chromium and WebKit print every 4xx/5xx response as "Failed to load resource: …" (WebKit
        // measured on CI's first run: the expired session's 401 of the reload spec). Only the statuses the
        // client answers or retries by design are exempt: 401, 404, 409 and 410 (L-TS-02, L-TS-06) and the
        // paced 429 and 503; any other status, or a line of another shape, still fails the test (E2E-CI-01).
        // Firefox printed nothing for them and keeps the full guard.
        const resourceLine = (projectName === 'chromium-web' || projectName === 'webkit-web') && BY_DESIGN_RESOURCE_LINE.test(m.text());
        if (m.type() === 'error' && !resourceLine) {
          consoleErrors.push(m.text());
        }
      });
      context.on('weberror', (e) => { pageErrors.push(String(e.error())); });
      context.on('page', watchPage);
      for (const p of context.pages()) watchPage(p);
    },
    async collectWorkers(): Promise<void> {
      for (const w of workers) {
        const found = await w.evaluate(() => {
          const g = self as unknown as { __dillaCsp?: unknown[] };
          const out = g.__dillaCsp ?? [];
          g.__dillaCsp = [];
          return out;
        }).catch(() => [] as unknown[]);
        cspViolations.push(...(found as CspViolation[]));
      }
    },
  };
}

interface AppFixtures { guard: Guard; peer: Peer; }
interface AppWorkerFixtures { instanceName: string; }

export const test = persistentTest.extend<AppFixtures, AppWorkerFixtures>({
  // The instance name the onboarding shows in `Join {instance}` (L-COPY-01): element 5 of GET /v1/instance.
  // eslint-disable-next-line no-empty-pattern
  instanceName: [async ({}, use) => {
    const res = await fetch(`${PUBLIC_URL}/v1/instance`, { headers: { accept: 'application/cbor' } });
    expect(res.status, 'GET /v1/instance').toBe(200);
    const name = arr(decode(new Uint8Array(await res.arrayBuffer())))[5];
    if (typeof name !== 'string' || name === '') throw new Error('GET /v1/instance: element 5 is not the instance name');
    await use(name);
  }, { scope: 'worker' }],
  guard: [async ({ context }, use, testInfo) => {
    const guard = newGuard(testInfo.project.name);
    await guard.attach(context);
    await use(guard);
    await guard.collectWorkers();
    expect(guard.cspViolations, 'securitypolicyviolation events').toEqual([]);
    expect(guard.pageErrors, 'uncaught page errors').toEqual([]);
    expect(guard.consoleErrors, 'console errors').toEqual([]);
  }, { auto: true }],
  // Task 17's relaunch, with the guard carried across it: the old context's workers are collected
  // before it closes, and the new context is watched from its first page on.
  relaunch: async ({ relaunch, guard }, use) => {
    await use(async () => {
      await guard.collectWorkers();
      const next = await relaunch();
      await guard.attach(next.context);
      return next;
    });
  },
  // eslint-disable-next-line no-empty-pattern
  peer: async ({}, use) => {
    const peer = await Peer.start();
    await use(peer);
    await peer.close();
  },
});

// ---------------------------------------------------------------------------------------------------
// Page handles (L-COPY-01, the L-UI DOM contract, the Global Constraints landmarks).

export function heading(page: Page, key: string, vars?: Record<string, string | number>): Locator {
  return page.getByRole('heading', { level: 1, name: copy(key, vars), exact: true });
}
export async function expectHeading(page: Page, key: string, vars?: Record<string, string | number>): Promise<void> {
  await expect(heading(page, key, vars)).toBeVisible({ timeout: WAIT });
}
/** Any onboarding step (all five render inside OnboardingFrame). */
export function onboardingFrame(page: Page): Locator { return page.locator(CLASS.onboardingFrame); }
/** `Continue`, the forward button of steps 1-3. */
export function nextButton(page: Page): Locator { return page.getByRole('button', { name: copy(COPY.next), exact: true }); }
/** `Create account`, the forward button of step 4 and the only control that registers (L-COPY-01). */
export function submitButton(page: Page): Locator { return page.getByRole('button', { name: copy(COPY.submit), exact: true }); }
export function railNav(page: Page): Locator { return page.getByRole('navigation', { name: copy(COPY.railLabel), exact: true }); }
export function channelsNav(page: Page): Locator { return page.getByRole('navigation', { name: copy(COPY.channelsLabel), exact: true }); }
export function logRegion(page: Page, channel: string): Locator {
  return page.getByRole('log', { name: copy(COPY.logLabel, { channel }), exact: true });
}
export function composerBox(page: Page, channel: string): Locator {
  return page.getByRole('textbox', { name: copy(COPY.composerLabel, { channel }), exact: true });
}
export function splash(page: Page, key: string): Locator { return page.getByRole('status').filter({ hasText: copy(key) }); }
export function messageRow(page: Page, channel: string, text: string): Locator {
  return logRegion(page, channel).locator(CLASS.messageRow).filter({ hasText: text });
}

// ---------------------------------------------------------------------------------------------------
// Flows.

export interface Account { username: string; display: string; password: string; recoveryKey: string[]; }

export async function readRecoveryKey(page: Page): Promise<string[]> {
  return page.locator(`${CLASS.recoveryKey} li`).allInnerTexts();
}

/** The whole onboarding with the pointer; returns what the person would have written down. */
export async function signUp(page: Page, invite: string, instanceName: string): Promise<Account> {
  const account: Account = {
    username: `w${randomInt(0, 0xffff_ffff).toString(16).padStart(8, '0')}`,
    display: 'web tester',
    password: 'e2e-password-1234',
    recoveryKey: [],
  };
  await page.goto(`/welcome?invite=${encodeURIComponent(invite)}`);
  await expectHeading(page, COPY.connectTitle, { instance: instanceName });
  await nextButton(page).click();
  await expectHeading(page, COPY.identityTitle);
  await page.getByLabel(copy(COPY.usernameLabel), { exact: true }).fill(account.username);
  await page.getByLabel(copy(COPY.displayLabel), { exact: true }).fill(account.display);
  await page.getByLabel(copy(COPY.passwordLabel), { exact: true }).fill(account.password);
  await nextButton(page).click();
  await expectHeading(page, COPY.keysTitle);
  account.recoveryKey = await readRecoveryKey(page);
  await page.getByRole('checkbox', { name: copy(COPY.keysAcknowledge), exact: true }).check();
  await nextButton(page).click();
  await expectHeading(page, COPY.deviceTitle);
  await submitButton(page).click();
  await expectHeading(page, COPY.doneTitle);
  await page.getByRole('button', { name: copy(COPY.finish), exact: true }).click();
  await expectShell(page);
  return account;
}

/** The shell is up (the rail is present, even with no server) and no onboarding step is showing. */
export async function expectShell(page: Page): Promise<void> {
  await expect(railNav(page)).toBeVisible({ timeout: WAIT });
  await expect(onboardingFrame(page)).toHaveCount(0);
}

export async function joinCommunity(page: Page, peer: Peer, setup: PeerSetup): Promise<void> {
  const rail = railNav(page);
  await rail.getByRole('button', { name: copy(COPY.railJoin), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: copy(COPY.joinTitle), exact: true });
  await expect(dialog).toBeVisible({ timeout: WAIT });
  await dialog.getByLabel(copy(COPY.joinInvite), { exact: true }).fill(setup.invite_code);
  await dialog.getByRole('button', { name: copy(COPY.joinSubmit), exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: WAIT });
  await expect(railItem(page, peer.communityName)).toBeVisible({ timeout: WAIT });
}

export async function openChannel(page: Page, community: string, channel: string): Promise<void> {
  await railItem(page, community).click();
  await channelRow(page, channel).click();
  await expectComposerReady(page, channel);
}

/** The composer is enabled only while the channel's group is active (task 24; aria-disabled otherwise). */
export async function expectComposerReady(page: Page, channel: string): Promise<void> {
  await expect(composerBox(page, channel)).toBeEnabled({ timeout: WAIT });
}

/** Sends through the composer and waits until the row is confirmed; a duplicate row fails strict mode. */
export async function sendText(page: Page, channel: string, text: string): Promise<void> {
  const box = composerBox(page, channel);
  await box.fill(text);
  await box.press('Enter');
  await expect(messageRow(page, channel, text)).toHaveAttribute('data-state', 'ok', { timeout: WAIT });
}

export async function expectAccessible(page: Page, state: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  const findings = await runAxe(page);
  expect(findings, `axe (serious and critical, target-size on) in state "${state}"`).toEqual([]);
}

/** Presses Tab until `target` is the focused element; fails after `maxPresses`. Keyboard only. */
export async function tabTo(page: Page, target: Locator, maxPresses = 40): Promise<void> {
  await expect(target).toBeVisible({ timeout: WAIT });
  for (let i = 0; i <= maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    if (i < maxPresses) await page.keyboard.press('Tab');
  }
  throw new Error(`Tab did not reach the target within ${maxPresses} presses`);
}

// web-2a (task 21): rows by name, the sign-in ceremony, Settings.
export function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** A rail item or channel row by the name it shows: its accessible name is the name alone, or the name followed
 *  by ", " and the counts (shell.rail.itemLabel, shell.channels.rowLabel, shell.channels.rowLabelMuted). */
export function namedRow(scope: Locator, name: string): Locator {
  return scope.getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}(, |$)`) });
}
export function railItem(page: Page, community: string): Locator { return namedRow(railNav(page), community); }
export function channelRow(page: Page, channel: string): Locator { return namedRow(channelsNav(page), channel); }

/** The recovery key as written down: its 13 groups joined by `separator`. */
export function keyText(account: Account, separator = ' '): string { return account.recoveryKey.join(separator); }
/** A well-formed key that is not this account's: the first character replaced by another character of the alphabet. */
export function wrongKey(account: Account): string {
  const key = account.recoveryKey.join('');
  return `${key[0] === '0' ? '1' : '0'}${key.slice(1)}`;
}
export function keyField(page: Page): Locator { return page.getByLabel(copy(SIGNIN.keyLabel), { exact: true }); }
export function keySubmit(page: Page): Locator { return page.getByRole('button', { name: copy(SIGNIN.keySubmit), exact: true }); }

/** From a fresh profile to the recovery-key step: onboarding step 1's entry, the host login. */
export async function signInToKeyStep(page: Page, account: Account, instanceName: string): Promise<void> {
  await page.goto('/welcome');
  await expectHeading(page, COPY.connectTitle, { instance: instanceName });
  await page.getByRole('button', { name: copy(SIGNIN.entry), exact: true }).click();
  await expectHeading(page, SIGNIN.loginTitle, { instance: instanceName });
  await page.getByLabel(copy(SIGNIN.username), { exact: true }).fill(account.username);
  await page.getByLabel(copy(SIGNIN.password), { exact: true }).fill(account.password);
  await page.getByRole('button', { name: copy(SIGNIN.loginSubmit), exact: true }).click();
  await expectHeading(page, SIGNIN.keyTitle);
}
/** The key step to the shell: type, submit, the done step, `Open dilla`. */
export async function finishSignIn(page: Page, account: Account, instanceName: string, typed: string): Promise<void> {
  await keyField(page).fill(typed);
  await keySubmit(page).click();
  await expectHeading(page, SIGNIN.doneTitle);
  await expect(page.getByText(copy(SIGNIN.doneBody, { username: account.username, instance: instanceName }), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: copy(SIGNIN.doneNext), exact: true }).click();
  await expectShell(page);
}
export async function signIn(page: Page, account: Account, instanceName: string, typed = keyText(account)): Promise<void> {
  await signInToKeyStep(page, account, instanceName);
  await finishSignIn(page, account, instanceName, typed);
}

export type SettingsSection = 'devices' | 'notifications' | 'appearance';
export function settingsDialog(page: Page): Locator { return page.getByRole('dialog', { name: copy('settings.title'), exact: true }); }
/** The rail's settings button, then the section from the settings navigation; resolves with the dialog. */
export async function openSettings(page: Page, section: SettingsSection): Promise<Locator> {
  await railNav(page).getByRole('button', { name: copy('shell.rail.settings'), exact: true }).click();
  const dialog = settingsDialog(page);
  await expect(dialog).toBeVisible({ timeout: WAIT });
  await dialog.getByRole('navigation', { name: copy('settings.nav.label'), exact: true })
    .getByRole('button', { name: copy(`settings.nav.${section}`), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/${section}$`), { timeout: WAIT });
  return dialog;
}
/** Escape closes Settings and returns to the route it was opened from (L-TS-27). */
export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(settingsDialog(page)).toBeHidden({ timeout: WAIT });
}
export function deviceRows(page: Page): Locator { return settingsDialog(page).locator(CLASS.deviceRow); }

// ---------------------------------------------------------------------------------------------------
// Probes.

export interface KekSummary {
  count: number; keys: string[]; v: number; type: string; extractable: boolean;
  algorithm: string; length: number; usages: string[]; iv: number; ct: number; exportRefused: boolean;
}

/** Reads the L-TS-05 record from the page's own origin and tries to export its wrap key. */
export async function readKekRecord(page: Page): Promise<KekSummary> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((done, fail) => {
      const open = indexedDB.open('dilla-device', 1);
      open.onsuccess = () => done(open.result);
      open.onerror = () => fail(open.error);
    });
    const read = <T,>(req: IDBRequest<T>) => new Promise<T>((done, fail) => {
      req.onsuccess = () => done(req.result);
      req.onerror = () => fail(req.error);
    });
    const store = db.transaction('kek', 'readonly').objectStore('kek');
    const [keys, records] = await Promise.all([read(store.getAllKeys()), read(store.getAll())]);
    db.close();
    const rec = records[0] as { v: number; wrapKey: CryptoKey; iv: Uint8Array; ct: Uint8Array };
    let exportRefused = false;
    try { await crypto.subtle.exportKey('raw', rec.wrapKey); } catch { exportRefused = true; }
    return {
      count: records.length,
      keys: keys.map(String),
      v: rec.v,
      type: rec.wrapKey.type,
      extractable: rec.wrapKey.extractable,
      algorithm: rec.wrapKey.algorithm.name,
      length: (rec.wrapKey.algorithm as AesKeyAlgorithm).length,
      usages: [...rec.wrapKey.usages].sort(),
      iv: rec.iv.byteLength,
      ct: rec.ct.byteLength,
      exportRefused,
    };
  });
}

/** Deletes every KEK record; the encrypted OPFS store stays behind (the store-lost condition). */
export async function clearKek(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done, fail) => {
    const open = indexedDB.open('dilla-device', 1);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kek', 'readwrite');
      tx.objectStore('kek').clear();
      tx.oncomplete = () => { db.close(); done(); };
      tx.onerror = () => fail(tx.error);
    };
  }));
}

/** Moves the test host's fake clock forward (internal/dillad/dilladtest/seed.go:35-51). */
export async function advanceClock(seconds: number): Promise<void> {
  const res = await fetch(`${CONTROL_URL}/debug/clock`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds }),
  });
  expect(res.status, await res.text()).toBe(204);
}

export interface ManifestFile { path: string; sha256: string; size: number; }
/** The manifest of the build the test host serves (-web-root packages/web/dist). */
export function readManifest(): { v: number; files: ManifestFile[] } {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'packages', 'web', 'dist', 'dilla-manifest.json'), 'utf8')) as { v: number; files: ManifestFile[] };
}
