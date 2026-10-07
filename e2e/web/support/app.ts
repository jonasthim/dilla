// The web e2e suite's page-level support (task 25): the native peer, the page contract the specs drive
// (the copy keys of en.ts, landmarks, the L-UI root classes, data-state), the CSP/console guard every test
// carries (every page and the core worker), the onboarding and shell drivers, and the probes of the
// device-key record and the instance clock. Every wait waits for a state, never for a duration (lesson c).
import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { test as persistentTest } from './persistent';
import { WebDriver, type PeerAttachRequest, type PeerAttached, type PeerDm, type PeerEnrolled, type PeerFetched, type PeerReceived, type PeerSendOptions, type PeerSetup } from './driver';
export type { PeerAttachment, PeerAttachRequest, PeerAttached, PeerDm, PeerEnrolled, PeerFetched, PeerOpenedDm, PeerReceived, PeerSendOptions, PeerSetup } from './driver';
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
  lightbox: 'dialog.d-lightbox',
  mention: '.d-mention',
  replyChip: '.d-reply-chip',
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
export type PeerMessage = PeerReceived & { sender_user: string; sender_device: string; tier: number; msg_id: string; type: number };
export function isPeerMessage(m: PeerReceived): m is PeerMessage {
  return m.msg_id !== null && m.type !== null && m.sender_user !== null && m.sender_device !== null && m.tier !== null;
}
interface SyncAnswer { epoch: number; members: number; received: PeerReceived[]; }

export class Peer {
  /** Every message the peer decrypted, across all syncs of this test. */
  readonly inbox: PeerReceived[] = [];
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

  register(): Promise<{ group_id: string; epoch: number }> { return this.driver.register(); }
  send(body: string, channelId?: string, opts?: PeerSendOptions): Promise<{ seq: number; msg_id: string }> { return this.driver.send(body, channelId, opts); }
  edit(msgId: string, body: string, channelId?: string): Promise<{ seq: number; msg_id: string }> {
    return this.driver.send(body, channelId, { type: 1, replyTo: msgId });
  }
  react(msgId: string, emoji: string, on: boolean, channelId?: string): Promise<{ seq: number; msg_id: string }> {
    return this.driver.send(emoji, channelId, { type: on ? 3 : 4, replyTo: msgId });
  }
  deleteMessage(msgId: string, seq: number, channelId?: string): Promise<{ seq: number }> {
    return this.driver.deleteMessage({ msgId, seq, ...(channelId === undefined ? {} : { channelId }) });
  }
  attach(a: PeerAttachRequest): Promise<PeerAttached> { return this.driver.attach(a); }
  fetchAttachment(seq: number, index: number, channelId?: string): Promise<PeerFetched> {
    return this.driver.fetchAttachment({ seq, index, ...(channelId === undefined ? {} : { channelId }) });
  }
  async blobStatus(blobId: string, channelId?: string): Promise<number> {
    return (await this.driver.blobStatus({ blobId, ...(channelId === undefined ? {} : { channelId }) })).status;
  }
  async waitForRow(match: (m: PeerMessage) => boolean, what: string, channelId?: string): Promise<PeerMessage> {
    let found: PeerMessage | undefined;
    await expect.poll(async () => {
      await this.sync(channelId);
      found = [...this.inbox].reverse().filter(isPeerMessage).find(match);
      return found !== undefined;
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000], message: `the peer never saw ${what}` }).toBe(true);
    if (found === undefined) throw new Error(`the peer never saw ${what}`);
    return found;
  }
  /** L-E2E-01 `update`: drains and applies, then commits a self Update and answers the new epoch. */
  update(): Promise<{ epoch: number }> { return this.driver.update(); }
  /** L-E2E-10 `enrol` through the driver's wrapper (driver.ts, this task). */
  enrol(): Promise<PeerEnrolled> { return this.driver.enrol(); }
  /** L-E2E-10 `revoke` through the driver's wrapper (driver.ts, this task). */
  revoke(deviceId: string): Promise<{ version: number }> { return this.driver.revoke(deviceId); }

  async sync(channelId?: string): Promise<SyncAnswer> {
    const answer = await this.driver.sync(channelId);
    this.inbox.push(...answer.received);
    return answer;
  }

  async devices(channelId?: string): Promise<string[]> {
    return (await this.driver.members(channelId)).devices;
  }

  /** Syncs until a message with exactly this body has been decrypted, and returns it. */
  async waitFor(body: string): Promise<PeerMessage> {
    await expect.poll(async () => {
      await this.sync();
      return this.inbox.some((m) => isPeerMessage(m) && m.body === body);
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(true);
    const found = this.inbox.filter(isPeerMessage).find((m) => m.body === body);
    if (!found) throw new Error(`the peer never decrypted ${JSON.stringify(body)}`);
    return found;
  }

  /** Syncs until the text group's roster holds `count` devices, and returns them. */
  async waitForDevices(count: number, channelId?: string): Promise<string[]> {
    let devices: string[] = [];
    await expect.poll(async () => {
      await this.sync(channelId);
      devices = await this.devices(channelId);
      return devices.length;
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(count);
    return devices;
  }

  readonly dmInbox: PeerReceived[] = [];
  async dms(): Promise<PeerDm[]> { return (await this.driver.dms()).dms; }
  async waitForDm(channelId: string): Promise<PeerDm> {
    let found: PeerDm | undefined;
    await expect.poll(async () => {
      found = (await this.dms()).find((d) => d.channel_id === channelId);
      return found !== undefined;
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(true);
    return found as PeerDm;
  }
  async openDm(userId: string): Promise<{ channelId: string; groupId: string; epoch: number; created: boolean }> {
    const o = await this.driver.openDm(userId);
    return { channelId: o.channel_id, groupId: o.group_id, epoch: o.epoch, created: o.created };
  }
  sendDm(channelId: string, body: string): Promise<{ seq: number }> { return this.driver.sendDm(channelId, body); }
  async syncDm(channelId: string): Promise<PeerReceived[]> {
    const answer = await this.driver.syncDm(channelId);
    this.dmInbox.push(...answer.received);
    return answer.received;
  }
  async waitForDmMembers(channelId: string, count: number): Promise<number> {
    let members = 0;
    await expect.poll(async () => {
      const answer = await this.driver.syncDm(channelId);
      this.dmInbox.push(...answer.received);
      members = answer.members;
      return members;
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(count);
    return members;
  }
  async waitForDmMessage(channelId: string, body: string): Promise<PeerMessage> {
    await expect.poll(async () => {
      await this.syncDm(channelId);
      return this.dmInbox.some((m) => isPeerMessage(m) && m.body === body);
    }, { timeout: WAIT, intervals: [250, 500, 1000, 2000] }).toBe(true);
    const found = this.dmInbox.filter(isPeerMessage).find((m) => m.body === body);
    if (!found) throw new Error(`the peer never decrypted ${JSON.stringify(body)} in its DM`);
    return found;
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
export async function signUp(page: Page, invite: string, instanceName: string, display = 'web tester'): Promise<Account> {
  const account: Account = {
    username: `w${randomInt(0, 0xffff_ffff).toString(16).padStart(8, '0')}`,
    display,
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

/** From a fresh profile through step 1: onboarding step 1's entry, then the recovery key, which the page holds until
 *  the login (the coordinator's ruling on REGISTRATION-DEVICES-02's concern 3); ends on the login step. */
export async function signInToLoginStep(page: Page, instanceName: string, typed: string): Promise<void> {
  await page.goto('/welcome');
  await expectHeading(page, COPY.connectTitle, { instance: instanceName });
  await page.getByRole('button', { name: copy(SIGNIN.entry), exact: true }).click();
  await expectHeading(page, SIGNIN.keyTitle);
  await keyField(page).fill(typed);
  await page.getByRole('button', { name: copy(SIGNIN.loginSubmit), exact: true }).click();
  await expectHeading(page, SIGNIN.loginTitle, { instance: instanceName });
}
/** The login step to the shell: the username and password, `Continue` (which enrols), the done step, `Open dilla`. */
export async function finishSignIn(page: Page, account: Account, instanceName: string): Promise<void> {
  await page.getByLabel(copy(SIGNIN.username), { exact: true }).fill(account.username);
  await page.getByLabel(copy(SIGNIN.password), { exact: true }).fill(account.password);
  await page.getByRole('button', { name: copy(SIGNIN.loginSubmit), exact: true }).click();
  await expectHeading(page, SIGNIN.doneTitle);
  await expect(page.getByText(copy(SIGNIN.doneBody, { username: account.username, instance: instanceName }), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: copy(SIGNIN.doneNext), exact: true }).click();
  await expectShell(page);
}
export async function signIn(page: Page, account: Account, instanceName: string, typed = keyText(account)): Promise<void> {
  await signInToLoginStep(page, instanceName, typed);
  await finishSignIn(page, account, instanceName);
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

// web-2a (task 22): the sidebar tabs, DMs, notifications.
export function sidebarTab(page: Page, tab: 'channels' | 'dms'): Locator {
  const label = copy(tab === 'channels' ? 'shell.tabs.channels' : 'shell.tabs.dms');
  // A tab's name is its label, followed by its Pill's hidden count when it has one.
  return page.getByRole('tablist', { name: copy('shell.tabs.label'), exact: true })
    .getByRole('tab', { name: new RegExp(`^${escapeRegExp(label)}`) });
}
export function dmsNav(page: Page): Locator { return page.getByRole('navigation', { name: copy('shell.dms.label'), exact: true }); }
/** The one message log on screen (a DM's log is named by the DM's name, which the spec does not fix). */
export function dmLog(page: Page): Locator { return page.getByRole('log'); }
export function dmComposer(page: Page): Locator { return page.locator(CLASS.composer).getByRole('textbox'); }

export interface ShownNotification { title: string; body: string; tag: string; closed: boolean; }
type Recorded = EventTarget & ShownNotification & { onclick: ((this: Recorded, e: Event) => unknown) | null; close(): void; click(): void };
type RecorderWindow = Window & { __dillaNotifications: Recorded[]; __dillaPermissionRequests: number };

/** Replaces window.Notification, before any page script runs, by a recorder that shows nothing: each
 *  `new Notification(title, options)` returns a stand-in with `onclick` and `close()` and is recorded;
 *  `permission` reads the browser's; `requestPermission` is counted and forwarded. An init script is
 *  injected by the protocol, so the page's CSP does not govern it. Call before the first navigation. */
export async function recordNotifications(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const native = window.Notification;
    const w = window as unknown as RecorderWindow;
    w.__dillaNotifications = [];
    w.__dillaPermissionRequests = 0;
    const Recording = function (title: string, options?: NotificationOptions): Recorded {
      const n = new EventTarget() as Recorded;
      n.title = title;
      n.body = options?.body ?? '';
      n.tag = options?.tag ?? '';
      n.closed = false;
      n.onclick = null;
      n.close = () => { n.closed = true; };
      n.click = () => { const e = new Event('click'); n.onclick?.call(n, e); n.dispatchEvent(e); };
      w.__dillaNotifications.push(n);
      return n;
    };
    Object.defineProperty(Recording, 'permission', { get: () => native.permission });
    Object.defineProperty(Recording, 'requestPermission', {
      value: (...args: Parameters<typeof Notification.requestPermission>) => {
        w.__dillaPermissionRequests += 1;
        return native.requestPermission(...args);
      },
    });
    Object.defineProperty(window, 'Notification', { value: Recording, configurable: true, writable: true });
  });
}
export async function notificationsShown(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(() => (window as unknown as RecorderWindow).__dillaNotifications
    .map((n) => ({ title: n.title, body: n.body, tag: n.tag, closed: n.closed })));
}
export async function permissionRequests(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as RecorderWindow).__dillaPermissionRequests);
}
/** What a click on the desktop notification does: the page's own onclick handler runs. */
export async function clickNotification(page: Page, index: number): Promise<void> {
  await page.evaluate((i) => { (window as unknown as RecorderWindow).__dillaNotifications[i].click(); }, index);
}

export type NotifyDefault = 'dmsMentions' | 'everything' | 'nothing';
/** Settings → Notifications → the default; waits for the radio to be checked from the settings slice, then closes. */
export async function setNotifyDefault(page: Page, mode: NotifyDefault): Promise<void> {
  const dialog = await openSettings(page, 'notifications');
  const radio = dialog.getByRole('radiogroup', { name: copy('notify.default.label'), exact: true })
    .getByRole('radio', { name: copy(`notify.default.${mode}`), exact: true });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true', { timeout: WAIT });
  await closeSettings(page);
}

// web-2b conversation page contract.
export function rowById(page: Page, channel: string, msgId: string): Locator {
  return logRegion(page, channel).locator(`${CLASS.messageRow}[data-msg-id="${msgId}"]`);
}
export function rowToolbar(row: Locator): Locator {
  return row.getByRole('toolbar', { name: copy('shell.message.toolbar'), exact: true });
}
export async function rowAction(row: Locator, action: 'react' | 'reply' | 'edit' | 'pin' | 'unpin' | 'delete'): Promise<void> {
  await row.focus();
  await rowToolbar(row).getByRole('button', { name: copy(`shell.message.${action}`), exact: true }).click();
}
export function reactionChip(row: Locator, emojiName: string, count: number): Locator {
  return row.getByRole('button', { name: copy('shell.message.reaction', { name: emojiName, count }), exact: true });
}
export function editorBox(page: Page): Locator { return page.getByRole('textbox', { name: copy('shell.edit.label'), exact: true }); }
export function mentionList(page: Page): Locator { return page.getByRole('listbox', { name: copy('shell.composer.mentions'), exact: true }); }
export function trayEntries(page: Page): Locator {
  return page.getByRole('list', { name: copy('shell.tray.label'), exact: true }).getByRole('listitem');
}
export function attachInput(page: Page): Locator { return page.locator('input.dw-attach-input'); }
export function lightbox(page: Page): Locator { return page.locator(CLASS.lightbox); }
export function pinsDialog(page: Page, channel: string): Locator {
  return page.getByRole('dialog', { name: copy('shell.pins.title', { channel }), exact: true });
}
export function deleteDialog(page: Page): Locator { return page.getByRole('dialog', { name: copy('shell.delete.title'), exact: true }); }
export function sha256Hex(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export interface DrawnImage { bytes: Buffer; sha256: string; type: string }
export async function drawImage(page: Page, o: { width: number; height: number; type: 'image/png' | 'image/webp'; quality?: number; seed: number }): Promise<DrawnImage> {
  const r = await page.evaluate(async ({ width, height, type, quality, seed }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (g === null) throw new Error('no 2d context');
    for (let y = 0; y < height; y += 20) {
      for (let x = 0; x < width; x += 20) {
        g.fillStyle = `hsl(${(x * 7 + y * 3 + seed * 41) % 360} 60% 50%)`;
        g.fillRect(x, y, 20, 20);
      }
    }
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
    if (blob === null) throw new Error('canvas.toBlob returned null');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { b64: btoa(bin), sha256: Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join(''), type: blob.type };
  }, o);
  if (r.type !== o.type) throw new Error(`the browser encoded ${r.type}, not ${o.type}`);
  return { bytes: Buffer.from(r.b64, 'base64'), sha256: r.sha256, type: r.type };
}

type FlashWindow = Window & { __dillaFlash?: { seen: boolean; stop(): void } };
export async function watchFlash(page: Page, msgId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as unknown as FlashWindow;
    w.__dillaFlash?.stop();
    const state = { seen: false, stop: () => undefined as void };
    const observer = new MutationObserver(() => {
      if (document.querySelector(`.d-message-row[data-msg-id="${id}"][data-flash="true"]`) !== null) state.seen = true;
    });
    state.stop = () => observer.disconnect();
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-flash'] });
    w.__dillaFlash = state;
  }, msgId);
}
export async function flashSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as FlashWindow;
    const seen = w.__dillaFlash?.seen ?? false;
    if (seen) w.__dillaFlash?.stop();
    return seen;
  });
}
