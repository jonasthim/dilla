// The voice suite's page contract and its native peer (L-E2E-31 helpers): `joinVoice`, `tileState`, `audioRunning`,
// `heard`, `notificationsSeen`, and reads of what the recorders of peer-browser.ts saw. Every wait waits for a state —
// `data-voice-state`, `data-call-phase`, `data-ring`, `data-media-state`, the voice snapshot, a media counter — never
// for a duration (lesson c), and none asserts on how late LiveKit shows a joiner (media card 23).
import { randomInt } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import type { CallState, Ring, TrustSummary, VoiceState } from '../../../packages/client-core/src/state/types';
import {
  WebDriver, testHostUrl, testkitEnv, type PeerActor, type PeerCallCheck, type PeerCallJoined, type PeerCallMembers,
  type PeerCallRead, type PeerCallStarted, type PeerSetup,
} from '../../web/support/driver';
import {
  channelsNav, closeSettings, copy, dmComposer, dmsNav, escapeRegExp, expectAccessible, expectShell, instanceInvite, messageRow, namedRow,
  openSettings, railItem, railNav, sendText, sidebarTab, signUp, type Account, type SettingsSection,
} from '../../web/support/app';
import { mediaWorkers, type Person } from './peer-browser';

export { closeSettings, copy, instanceInvite };
/** The shell is up again (after a reload): the rail shows and no onboarding step does. */
export async function expectShellReady(page: Page): Promise<void> { await expectShell(page); }
/** One wait for one state (Global Constraints: at least 30 s locally, 90 s in CI). */
export const WAIT = process.env.CI === 'true' ? 90_000 : 30_000;
export const POLL = { timeout: WAIT, intervals: [100, 250, 500, 1000] };

// ---------------------------------------------------------------------------------------------------
// The native peer: a web-driver process against the voice host (8481), one per role in a test.

export class VoicePeer {
  communityName = '';
  setupAnswer: PeerSetup | null = null;
  private constructor(readonly driver: WebDriver, readonly seed: number) {}

  static async start(): Promise<VoicePeer> {
    const seed = randomInt(1, 0xff_ffff);
    return new VoicePeer(await WebDriver.start(testHostUrl(), testkitEnv(), seed), seed);
  }

  /** A community with the text channel `general` (its group registered) and the voice channel `general-voice`
   *  (L-E2E-30 `setup {voice}`). */
  async setup(o: { password?: string } = {}): Promise<PeerSetup & { voice_channel_id: string }> {
    this.communityName = `v-${this.seed.toString(16)}`;
    const s = await this.driver.setup({ community: this.communityName, channel: 'general', voice: true, ...o });
    if (s.voice_channel_id === null) throw new Error('setup {voice: true} answered no voice channel');
    this.setupAnswer = s;
    await this.driver.register();
    return s as PeerSetup & { voice_channel_id: string };
  }
  /** Commits the browsers' Adds to `general` until its roster holds the peer and `browsers` more devices: each browser
   *  then knows the others by name (the members slice) and holds the peer's identity (trust). */
  async seat(browsers: number): Promise<string[]> { return this.waitForDevices(browsers + 1, this.setupDone.channel_id); }
  readonly voiceName = 'general-voice';
  readonly textName = 'general';
  get setupDone(): PeerSetup {
    if (this.setupAnswer === null) throw new Error('setup first');
    return this.setupAnswer;
  }
  register(): Promise<{ group_id: string; epoch: number }> { return this.driver.register(); }
  callJoin(channel: string, actor: PeerActor = 'peer'): Promise<PeerCallJoined> { return this.driver.callJoin(channel, actor); }
  callLeave(channel: string, actor: PeerActor = 'peer'): Promise<void> { return this.driver.callLeave(channel, actor); }
  callMembers(channel: string, actor: PeerActor = 'peer'): Promise<PeerCallMembers> { return this.driver.callMembers(channel, actor); }
  callStart(channel: string, actor: PeerActor = 'peer'): Promise<PeerCallStarted> { return this.driver.callStart(channel, actor); }
  callCheck(channel: string, actor: PeerActor = 'peer'): Promise<PeerCallCheck> { return this.driver.callCheck(channel, actor); }
  callRead(channel: string, actor: PeerActor = 'peer'): Promise<PeerCallRead> { return this.driver.callRead(channel, actor); }
  syncDm(channelId: string): Promise<{ members: number }> { return this.driver.syncDm(channelId); }
  callDecline(call: string, actor: PeerActor = 'peer'): Promise<void> { return this.driver.callDecline(call, actor); }
  forgeDevice(): Promise<{ device_id: string; version: number }> { return this.driver.forgeDevice(); }
  enrol(): Promise<{ device_id: string }> { return this.driver.enrol(); }
  rotateUmk(): Promise<{ user: string; version: number }> { return this.driver.rotateUmk(); }
  typing(channel: string, on: boolean): Promise<void> { return this.driver.typing(channel, on); }
  openDm(userId: string): Promise<{ channel_id: string; group_id: string; created: boolean }> { return this.driver.openDm(userId); }
  async syncDmMembers(channelId: string): Promise<number> { return (await this.driver.syncDm(channelId)).members; }
  sync(channel?: string): Promise<{ members: number }> { return this.driver.sync(channel); }
  async devices(channel?: string): Promise<string[]> { return (await this.driver.members(channel)).devices; }
  close(): Promise<void> { return this.driver.close(); }

  /** Syncs until the text group's roster holds `count` devices (the peer commits the browsers' Adds). */
  async waitForDevices(count: number, channel?: string): Promise<string[]> {
    let devices: string[] = [];
    await expect.poll(async () => {
      await this.sync(channel);
      devices = await this.devices(channel);
      return devices.length;
    }, POLL).toBe(count);
    return devices;
  }

  /** Polls the actor's call-group roster (each poll syncs and commits outstanding proposals) until `match` holds. */
  async waitForCallMembers(channel: string, match: (devices: string[]) => boolean, what: string, actor: PeerActor = 'peer'): Promise<string[]> {
    let devices: string[] = [];
    await expect.poll(async () => {
      devices = (await this.callMembers(channel, actor)).devices;
      return match(devices);
    }, { ...POLL, message: `the ${actor}'s call roster ${what}` }).toBe(true);
    return devices;
  }
}

/** The name the app shows for the peer: its display name, else its username. */
export function peerName(s: PeerSetup): string { return s.display !== '' ? s.display : s.username; }

// ---------------------------------------------------------------------------------------------------
// Onboarding and navigation.

let cachedInstance: string | null = null;
/** The instance name of `GET /v1/instance` (element 5), which onboarding shows. */
export async function instanceName(): Promise<string> {
  if (cachedInstance !== null) return cachedInstance;
  const { arr, decode } = await import('../../../packages/client-core/src/cbor/index');
  const res = await fetch(`${testHostUrl()}/v1/instance`, { headers: { accept: 'application/cbor' } });
  expect(res.status, 'GET /v1/instance').toBe(200);
  const name = arr(decode(new Uint8Array(await res.arrayBuffer())))[5];
  if (typeof name !== 'string' || name === '') throw new Error('GET /v1/instance: element 5 is not the instance name');
  cachedInstance = name;
  return name;
}

/** Signs a fresh account up in this person's page and joins the peer's community with its invite. */
export async function onboard(person: Person, peer: VoicePeer, display: string): Promise<Account> {
  const account = await signUp(person.page, instanceInvite(), await instanceName(), display);
  const page = person.page;
  await railNav(page).getByRole('button', { name: copy('shell.rail.join'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: copy('join.title'), exact: true });
  await expect(dialog).toBeVisible({ timeout: WAIT });
  await dialog.getByLabel(copy('join.invite'), { exact: true }).fill(peer.setupDone.invite_code);
  await dialog.getByRole('button', { name: copy('join.submit'), exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: WAIT });
  await expect(railItem(page, peer.communityName)).toBeVisible({ timeout: WAIT });
  await expectShell(page);
  await openText(page, peer.communityName, peer.textName);
  return account;
}

/**
 * Seats the browsers in `general` and has each say hello there, so every page knows every other by name: a page loads a
 * community's member list once, and looks a sender up again only when a message names one it lacks (L-TS-09); a voice
 * participant who joined the server later would otherwise show as its id's first 8 characters (task 10 report, card).
 */
export async function introduce(peer: VoicePeer, people: readonly Person[], browsersSeated = people.length): Promise<void> {
  await peer.seat(browsersSeated);
  const said = people.map((p) => `hello from ${p.name} ${randomInt(0, 0xff_ffff).toString(16)}`);
  for (const [i, p] of people.entries()) await sendText(p.page, peer.textName, said[i]);
  for (const p of people) {
    for (const text of said) await expect(messageRow(p.page, peer.textName, text)).toBeVisible({ timeout: WAIT });
  }
}

/** Opens a DM with `name` from the DMs tab's `message someone` picker (a member of the open server); answers its id. */
export async function openDmWith(page: Page, community: string, name: string): Promise<string> {
  await railItem(page, community).click();
  await sidebarTab(page, 'dms').click();
  await page.getByRole('button', { name: copy('shell.dms.new'), exact: true }).click();
  const picker = page.getByRole('dialog', { name: copy('shell.dms.newTitle'), exact: true });
  await picker.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: copy('shell.dms.open'), exact: true }).click();
  await expect(page).toHaveURL(/\/dm\/[0-9a-f]{32}$/, { timeout: WAIT });
  await expect(dmComposer(page)).toBeEnabled({ timeout: WAIT });
  return new URL(page.url()).pathname.split('/')[2];
}
/** Alice and bob in the peer's server, their DM opened by alice and open on both sides, and the instance clock caught
 *  up with the wall clock (catchUpClock: a ring's expires_ts then means what it says on the page). Answers the DM. */
export async function dmPair(alice: Person, bob: Person, peer: VoicePeer): Promise<string> {
  await peer.setup();
  await onboard(alice, peer, 'alice');
  await onboard(bob, peer, 'bob');
  await introduce(peer, [alice, bob]);
  const dm = await openDmWith(alice.page, peer.communityName, 'bob');
  await openDm(bob.page, dm, 'alice');
  await catchUpClock();
  return dm;
}

/** A 1 s, 48 kHz, 16-bit mono WAV of a 660 Hz tone, built in the page. */
export async function buildWav(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const rate = 48_000;
    const samples = rate;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    ascii(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ascii(36, 'data'); v.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 660 * i) / rate) * 0.4 * 32767), true);
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

/** axe (serious and critical, target-size on) in the three themes, then at 360×740 in the first; restores both. */
export async function axeEverywhere(page: Page, state: string): Promise<void> {
  const viewport = page.viewportSize();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  try {
    for (const name of ['mesh', 'light', 'high-contrast'] as const) {
      await page.evaluate((n) => { document.documentElement.dataset.theme = n; }, name);
      await expectAccessible(page, `${state} in the ${name} theme`);
    }
    await page.evaluate((n) => { document.documentElement.dataset.theme = n; }, 'mesh');
    await page.setViewportSize({ width: 360, height: 740 });
    await expectAccessible(page, `${state} at 360×740`);
  } finally {
    if (viewport !== null) await page.setViewportSize(viewport);
    await page.evaluate((n) => { if (n === null) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = n; }, theme);
  }
}

/** Opens the DM `dmId` from the DMs tab, by its row's name (the other person's), once the page lists it. */
export async function openDm(page: Page, dmId: string, name: string): Promise<void> {
  await sidebarTab(page, 'dms').click();
  await namedRow(dmsNav(page), name).click();
  await expect(page).toHaveURL(new RegExp(`/dm/${dmId}$`), { timeout: WAIT });
  await expect(dmComposer(page)).toBeVisible({ timeout: WAIT });
}
/** The DM call strip's `call` (no live call) or `join call` button. */
export function stripButton(page: Page, key: 'call.start' | 'call.join'): Locator {
  return page.locator('.dw-call-strip').getByRole('button', { name: copy(key), exact: true });
}
/** The incoming rings on screen (L-UI-70), each with `data-ring` `incoming` or `busy`. */
export function rings(page: Page): Locator { return page.locator('.d-ring-banner__ring'); }

/**
 * Moves the test host's instance clock up to the wall clock (it is a fake clock, frozen at the host's start but for
 * /debug/clock): a ring's op 53 carries an absolute `expires_ts`, which the page compares with its own clock, so a
 * ring sent on a clock minutes behind would read as already over.
 */
export async function catchUpClock(): Promise<void> {
  const control = process.env.DILLA_TESTKIT_CONTROL;
  if (!control) throw new Error('DILLA_TESTKIT_CONTROL is unset: the web globalSetup exports it');
  const state = await fetch(`${control}/debug/state`);
  expect(state.status, 'GET /debug/state').toBe(200);
  const now = ((await state.json()) as { now_unix: number }).now_unix;
  const behind = Math.floor(Date.now() / 1000) - now;
  if (behind <= 0) return;
  await advanceClock(behind);
}
/** Moves the instance clock `seconds` forward (POST /debug/clock). */
export async function advanceClock(seconds: number): Promise<void> {
  const control = process.env.DILLA_TESTKIT_CONTROL;
  const res = await fetch(`${control}/debug/clock`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds }),
  });
  expect(res.status, await res.text()).toBe(204);
}

/** Settings → Voice; resolves with the dialog. */
export async function openVoiceSettings(page: Page): Promise<Locator> {
  return openSettings(page, 'voice' as SettingsSection);
}

/** Settings → Voice → noise suppression off (the fake microphone's steady tone is what RNNoise removes), then closes. */
export async function noiseOff(page: Page): Promise<void> {
  const dialog = await openVoiceSettings(page);
  const toggle = dialog.getByRole('switch', { name: copy('settings.voice.noise'), exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: WAIT });
  await closeSettings(page);
}

/** Settings → Voice → push to talk with `code` as its key (one of PUSH_TO_TALK_KEYS), then closes Settings. */
export async function pushToTalk(page: Page, code: string): Promise<void> {
  const dialog = await openVoiceSettings(page);
  const ptt = dialog.getByRole('radiogroup', { name: copy('settings.voice.mode'), exact: true })
    .getByRole('radio', { name: copy('settings.voice.ptt'), exact: true });
  await ptt.click();
  await expect(ptt).toHaveAttribute('aria-checked', 'true', { timeout: WAIT });
  await dialog.getByRole('button', { name: copy('settings.voice.pttSet'), exact: true }).click();
  await page.keyboard.press(code);
  await expect(dialog.locator('.d-voice-settings__kbd')).toHaveText(code, { timeout: WAIT });
  await closeSettings(page);
}

/** The sidebar row of a voice channel (`voice {name}`). */
export function voiceRow(page: Page, name: string): Locator {
  return page.getByRole('button', { name: copy('voice.open', { name }), exact: true }).first();
}

/** Opens the community, then its text channel, and waits until its composer is shown. */
export async function openText(page: Page, community: string, channel: string): Promise<void> {
  await railItem(page, community).click();
  await namedRow(channelsNav(page), channel).click();
  await expect(page.getByRole('textbox', { name: copy('shell.composer.label', { channel }), exact: true })).toBeVisible({ timeout: WAIT });
}

/** Opens a voice channel's view from the sidebar. */
export async function openVoice(page: Page, community: string, name: string): Promise<void> {
  await railItem(page, community).click();
  await voiceRow(page, name).click();
  await expect(page.locator('.dw-voice-stage')).toBeVisible({ timeout: WAIT });
}

/** The voice dock (flow 06), present while this device is in voice. */
export function dock(page: Page): Locator { return page.locator('.dw-voice-dock'); }
/** The call stage or voice view of the open route. */
export function stage(page: Page): Locator { return page.locator('.dw-voice-stage'); }
/** The worker's call phase as the stage of the open route shows it (`data-call-phase`). */
export function phaseOf(page: Page): Locator { return page.locator('[data-call-phase]').first(); }

/** `joinVoice`: opens the voice channel, presses `join voice`, and waits until the call phase is `in` and the page's
 *  session is connected (the dock's `data-phase`; leave and the controls act on a connected session). */
export async function joinVoice(page: Page, community: string, name: string): Promise<void> {
  await openVoice(page, community, name);
  await stage(page).getByRole('button', { name: copy('voice.join'), exact: true }).click();
  await connected(page);
}
/** The call phase is `in` and the dock shows a connected session. */
export async function connected(page: Page): Promise<void> {
  await expect(page.locator('[data-call-phase]').first()).toHaveAttribute('data-call-phase', 'in', { timeout: WAIT });
  await expect(dock(page).locator('.d-voice-dock')).toHaveAttribute('data-phase', 'connected', { timeout: WAIT });
}

/** Another person's tile on this page's stage, by the name it shows. */
export function tile(page: Page, name: string): Locator {
  return stage(page).locator('.d-call-tile:not([data-own])').filter({
    has: page.locator('.d-call-tile__name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
  });
}
/** `tileState`: the `data-voice-state` of that tile ('connecting', 'not-heard', 'ok' or 'unverified'). */
export async function tileState(page: Page, name: string): Promise<string | null> {
  return tile(page, name).getAttribute('data-voice-state', { timeout: WAIT });
}

// ---------------------------------------------------------------------------------------------------
// What the recorders saw (peer-browser.ts installRecorders).

type Recorded = {
  slices: Record<string, unknown>;
  keyPath: { messages: number; callKeys: number; findings: string[] };
  tones: { hz: number; state: string }[];
  ringTimers: Set<number>;
  blobs: { created: string[]; revoked: string[] };
};

export async function slice<T>(page: Page, name: string): Promise<T | undefined> {
  return page.evaluate((n) => (window as unknown as { __dw: Recorded }).__dw.slices[n], name) as Promise<T | undefined>;
}
export const callSlice = (page: Page) => slice<CallState>(page, 'call');
export const voiceSlice = (page: Page) => slice<VoiceState>(page, 'voice');
export const ringsSlice = (page: Page) => slice<Ring[]>(page, 'rings');

/** This page's own user and device, from the core worker's `account` slice. */
export async function self(page: Page): Promise<{ user: string; device: string }> {
  let out: { user: string; device: string } | null = null;
  await expect.poll(async () => {
    const a = await slice<{ user: { id: string } | null; deviceId: string | null }>(page, 'account');
    out = a?.user && a.deviceId ? { user: a.user.id, device: a.deviceId } : null;
    return out !== null;
  }, POLL).toBe(true);
  return out as unknown as { user: string; device: string };
}

/** The devices of a channel's live call in this page's voice snapshot (the worker's `voice` slice). */
export async function snapshotDevices(page: Page, channelId: string): Promise<string[]> {
  return ((await voiceSlice(page))?.[channelId]?.participants ?? []).map((p) => p.deviceId).sort();
}

/** Waits until this page's trust slice holds `userId` as changed (a new key no comparison verified yet). */
export async function changedSeen(page: Page, userId: string): Promise<void> {
  await expect.poll(async () => {
    const row = (await slice<TrustSummary[]>(page, 'trust'))?.find((r) => r.userId === userId);
    return row !== undefined && (row.changedUmk !== null || row.blocked === 'E_UMK_CHANGED');
  }, { ...POLL, message: `the trust slice holds ${userId} as changed` }).toBe(true);
}

/** The key-path record: how many `ret` and `slice` messages were scanned, the `callKeys` pushes seen, and findings. */
export async function keyPath(page: Page): Promise<Recorded['keyPath']> {
  return page.evaluate(() => (window as unknown as { __dw: Recorded }).__dw.keyPath);
}

/** `audioRunning`: the page made at least one AudioContext, and every one not closed is running (Firefox needs the
 *  PulseAudio sink headlessly; a suspended context reads silent everywhere). */
export async function audioRunning(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const ctxs = (window as unknown as { __dw: { contexts: AudioContext[] } }).__dw.contexts.filter((c) => c.state !== 'closed');
    return ctxs.length > 0 && ctxs.every((c) => c.state === 'running') ? 'running' : ctxs.map((c) => c.state).join(',') || 'none';
  }), { ...POLL, message: 'AudioContext.state' }).toBe('running');
}

/** The oscillator tones this page started, with their frequency and context state. */
export async function tones(page: Page): Promise<{ hz: number; state: string }[]> {
  return page.evaluate(() => (window as unknown as { __dw: Recorded }).__dw.tones);
}
/** The ring's pings (1000 Hz) this page played. */
export async function ringPings(page: Page): Promise<number> { return (await tones(page)).filter((t) => t.hz === 1000).length; }
/** True while the ring's 2 s timer runs (sounds.ts startRing; cleared by stopRing). */
export async function ringTimerLive(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __dw: Recorded }).__dw.ringTimers.size > 0);
}

/** `notificationsSeen`: each desktop notification the page raised, as `{title, tag, closed}`. */
export async function notificationsSeen(page: Page): Promise<{ title: string; tag: string; closed: boolean }[]> {
  return page.evaluate(() => (window as unknown as { __dillaNotifications: { title: string; tag: string; closed: boolean }[] })
    .__dillaNotifications.map((n) => ({ title: n.title, tag: n.tag, closed: n.closed })));
}

/** Reports the tab as hidden (or visible again) to the page, with a `visibilitychange`. */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => (window as unknown as { __dwSetHidden(h: boolean): void }).__dwSetHidden(h), hidden);
}

/** The `blob:` URLs the page minted and revoked. */
export async function blobs(page: Page): Promise<{ created: string[]; revoked: string[] }> {
  return page.evaluate(() => (window as unknown as { __dw: Recorded }).__dw.blobs);
}

/** Frames the media worker authenticated and bound to `deviceHex` (`__dillaMediaStats.verified`, N6); 0 without a worker. */
export async function heardCount(page: Page, deviceHex: string): Promise<number> {
  let n = 0;
  for (const wk of mediaWorkers(page)) {
    const v = await wk.evaluate((d) => (globalThis as unknown as { __dillaMediaStats?: { verified: Record<string, number> } })
      .__dillaMediaStats?.verified?.[d] ?? 0, deviceHex).catch(() => 0);
    n = Math.max(n, v);
  }
  return n;
}
/** `heard`: waits until this page's media worker has verified frames of `deviceHex`. */
export async function heard(page: Page, deviceHex: string): Promise<number> {
  await expect.poll(() => heardCount(page, deviceHex), { ...POLL, message: `frames verified as ${deviceHex}` }).toBeGreaterThan(0);
  return heardCount(page, deviceHex);
}
/** This page's own encrypted frames (`__dillaMediaStats.encrypted`, every key and slot summed): its own frame clock. */
export async function sentCount(page: Page): Promise<number> {
  let n = 0;
  for (const wk of mediaWorkers(page)) {
    const v = await wk.evaluate(() => {
      const s = (globalThis as unknown as { __dillaMediaStats?: { encrypted: Record<string, Record<string, number>> } }).__dillaMediaStats;
      let sum = 0;
      for (const slots of Object.values(s?.encrypted ?? {})) for (const x of Object.values(slots)) sum += x;
      return sum;
    }).catch(() => 0);
    n = Math.max(n, v);
  }
  return n;
}
/** Waits until `page` has encrypted `frames` more frames than `from` (a frame clock, never a sleep). */
export async function framesPass(page: Page, from: number, frames: number): Promise<number> {
  let now = from;
  await expect.poll(async () => { now = await sentCount(page); return now - from; }, { ...POLL, message: `${frames} own frames encrypted` })
    .toBeGreaterThanOrEqual(frames);
  return now;
}
