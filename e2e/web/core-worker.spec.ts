import type { Page } from '@playwright/test';
import type { HarnessApi, HarnessResult } from '../../packages/client-core/harness/main';
import type {
  AccountState, ChannelSummary, Command, CommunitySummary, ConnectionState, MemberSummary, TimelineItem, TimelineState,
} from '../../packages/client-core/src/index';
import { WebDriver, instanceInvite, testHostUrl, testkitEnv, type PeerReceived } from './support/driver';
import { expect, test } from './support/persistent';

const CI = process.env.CI === 'true';
const WAIT = CI ? 90_000 : 30_000;
const HEX32 = /^[0-9a-f]{32}$/;
const CROCKFORD_GROUP = /^[0-9A-HJKMNP-TV-Z]{4}$/;

type HarnessWindow = Window & { dilla: HarnessApi };

async function call(page: Page, command: Command): Promise<HarnessResult> {
  return page.evaluate((c) => (window as unknown as HarnessWindow).dilla.call(c), command);
}

async function ok(page: Page, command: Command): Promise<unknown> {
  const result = await call(page, command);
  expect(result, `${command.m}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
  return result.ok ? result.value : undefined;
}

function slice<T>(page: Page, name: string): Promise<T | null> {
  return page.evaluate((n) => (window as unknown as HarnessWindow).dilla.get(n), name) as Promise<T | null>;
}

async function phaseOf(page: Page): Promise<string | null> {
  return (await slice<AccountState>(page, 'account'))?.phase ?? null;
}

async function openHarness(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('ready', { timeout: WAIT });
  await ok(page, { m: 'start' });
}

test('the core worker signs up, joins, reads and sends, survives a gateway restart and a reload, and keeps a second tab out', async ({ page, context }) => {
  test.setTimeout(CI ? 900_000 : 300_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const peer = await WebDriver.start(testHostUrl(), testkitEnv());
  const peerGot: PeerReceived[] = [];
  const peerReceives = async (body: string): Promise<PeerReceived> => {
    await expect.poll(async () => {
      peerGot.push(...(await peer.sync()).received);
      return peerGot.some((r) => r.body === body);
    }, { timeout: WAIT, message: `the peer receives ${JSON.stringify(body)}` }).toBe(true);
    return peerGot.find((r) => r.body === body)!;
  };
  try {
    const s = await peer.setup({ community: 'harness community', channel: 'general' });
    expect((await peer.register()).epoch).toBe(0);
    const username = `web${(peer.seed & 0xff_ffff).toString(16).padStart(6, '0')}`;
    const timeline = async (): Promise<TimelineItem[]> =>
      (await slice<TimelineState>(page, `timeline:${s.channel_id}`))?.items ?? [];

    await test.step('sign up through the bridge with an instance invite', async () => {
      await openHarness(page);
      await expect.poll(() => phaseOf(page), { timeout: WAIT }).toBe('needs-signup');
      const fresh = (await slice<AccountState>(page, 'account'))!;
      expect(fresh.instance).toMatchObject({ name: 'dilla.test', registrationMode: 0 });
      expect(fresh.instance!.id).toMatch(HEX32);
      expect(fresh.recoveryKey).toBeNull();
      await ok(page, { m: 'signupBegin' });
      const keys = (await slice<AccountState>(page, 'account'))!;
      expect(keys.phase).toBe('signup-keys');
      expect(keys.recoveryKey).toHaveLength(13);
      for (const group of keys.recoveryKey!) expect(group).toMatch(CROCKFORD_GROUP);
      // An instance invite names no community, so the signup joins nothing (L-TS-09 signupSubmit result).
      expect(await ok(page, {
        m: 'signupSubmit', invite: instanceInvite(), username, display: 'Web Harness',
        password: keys.instance!.passwordSignup ? 'harness password 1' : null, recoveryKeyAcknowledged: true,
      })).toEqual({ communityId: null, joinError: null });
      const ready = (await slice<AccountState>(page, 'account'))!;
      expect(ready.phase).toBe('ready');
      expect(ready.user?.username).toBe(username);
      expect(ready.user?.id).toMatch(HEX32);
      expect(ready.deviceId).toMatch(HEX32);
      expect(ready.recoveryKey).toBeNull();
      expect(ready.error).toBeNull();
      await expect.poll(async () => (await slice<ConnectionState>(page, 'connection'))?.status, { timeout: WAIT }).toBe('online');
      expect(await slice<CommunitySummary[]>(page, 'communities')).toEqual([]);
    });

    const me = (await slice<AccountState>(page, 'account'))!;
    const userId = me.user!.id;
    const deviceId = me.deviceId!;

    await test.step("join the peer's community with its invite and see its channel and members", async () => {
      expect(await ok(page, { m: 'joinCommunity', invite: s.invite_code })).toEqual({ communityId: s.community_id });
      expect(await slice<CommunitySummary[]>(page, 'communities')).toEqual([{ id: s.community_id, name: 'harness community' }]);
      await ok(page, { m: 'selectCommunity', communityId: s.community_id });
      expect(await slice<ChannelSummary[]>(page, `channels:${s.community_id}`)).toEqual([{
        id: s.channel_id, communityId: s.community_id, kind: 0, mode: 0, name: 'general', topic: '',
        parentId: null, position: 0, group: 'none',
      }]);
      const members = (await slice<MemberSummary[]>(page, `members:${s.community_id}`))!;
      expect(members).toHaveLength(2);
      expect(members).toEqual(expect.arrayContaining([
        { userId: s.user_id, username: s.username, display: s.display, kind: 0 },
        { userId, username, display: 'Web Harness', kind: 0 },
      ]));
    });

    await test.step('open the channel by external join; the peer sees this device', async () => {
      await ok(page, { m: 'openChannel', channelId: s.channel_id });
      await expect.poll(async () => (await slice<TimelineState>(page, `timeline:${s.channel_id}`))?.group, { timeout: WAIT }).toBe('active');
      expect((await slice<ChannelSummary[]>(page, `channels:${s.community_id}`))?.[0]?.group).toBe('active');
      await expect.poll(async () => (await peer.members()).devices, { timeout: WAIT })
        .toEqual(expect.arrayContaining([s.device_id, deviceId]));
    });

    await test.step("receive the peer's message with the peer's authenticated sender", async () => {
      await peer.send('hello from the peer');
      await expect.poll(async () => (await timeline()).find((i) => i.body === 'hello from the peer') ?? null, { timeout: WAIT })
        .toMatchObject({ state: 'ok', reason: '', senderUser: s.user_id, senderDevice: s.device_id, own: false, web: false, bot: false });
    });

    await test.step('send; the peer decrypts it from this device at the browser tier', async () => {
      const sent = (await ok(page, { m: 'send', channelId: s.channel_id, text: 'hello from the browser' })) as { msgId: string };
      expect(sent.msgId).toMatch(HEX32);
      // One item for the message throughout, keyed o<msgId> while pending and after it is stored (L-TS-08 key rule).
      await expect.poll(async () => (await timeline()).filter((i) => i.msgId === sent.msgId).map((i) => [i.key, i.state]), { timeout: WAIT })
        .toEqual([[`o${sent.msgId}`, 'ok']]);
      expect((await timeline()).find((i) => i.msgId === sent.msgId))
        .toMatchObject({ own: true, web: true, senderUser: userId, senderDevice: deviceId, body: 'hello from the browser' });
      expect(await peerReceives('hello from the browser')).toMatchObject({ sender_user: userId, sender_device: deviceId, tier: 1 });
    });

    await test.step('a message sent while the gateway was down arrives after it reconnects', async () => {
      await page.evaluate(() => (window as unknown as HarnessWindow).dilla.hook('gateway-stop'));
      await expect.poll(async () => (await slice<ConnectionState>(page, 'connection'))?.status, { timeout: WAIT }).toBe('offline');
      await peer.send('sent while the browser was away');
      await page.evaluate(() => (window as unknown as HarnessWindow).dilla.hook('gateway-start'));
      await expect.poll(async () => (await slice<ConnectionState>(page, 'connection'))?.status, { timeout: WAIT }).toBe('online');
      await expect.poll(async () => (await timeline()).some((i) => i.body === 'sent while the browser was away' && i.state === 'ok'), {
        timeout: WAIT, message: 'the message sent while the gateway was stopped arrives after the restart (catch-up on ready)',
      }).toBe(true);
    });

    const before = (await timeline()).filter((i) => i.state === 'ok').map((i) => `${i.key} ${i.body}`);
    expect(before).toHaveLength(3);

    await test.step('reload: ready from the stored device key, same identity, same timeline, messages flow both ways', async () => {
      await page.reload();
      await expect(page.locator('#status')).toHaveText('ready', { timeout: WAIT });
      await ok(page, { m: 'start' });
      await expect.poll(() => phaseOf(page), { timeout: WAIT }).toBe('ready');
      const again = (await slice<AccountState>(page, 'account'))!;
      expect(again.user).toEqual({ id: userId, username });
      expect(again.deviceId).toBe(deviceId);
      await ok(page, { m: 'selectCommunity', communityId: s.community_id });
      await ok(page, { m: 'openChannel', channelId: s.channel_id });
      await expect.poll(async () => (await timeline()).filter((i) => i.state === 'ok').map((i) => `${i.key} ${i.body}`), { timeout: WAIT })
        .toEqual(before);
      await peer.send('after the reload');
      await expect.poll(async () => (await timeline()).some((i) => i.body === 'after the reload' && i.state === 'ok'), { timeout: WAIT }).toBe(true);
      await ok(page, { m: 'send', channelId: s.channel_id, text: 'browser after the reload' });
      expect(await peerReceives('browser after the reload')).toMatchObject({ sender_user: userId, sender_device: deviceId, tier: 1 });
    });

    await test.step('a second page of the same origin waits as other-tab', async () => {
      const second = await context.newPage();
      second.on('pageerror', (e) => pageErrors.push(e.message));
      await openHarness(second);
      await expect.poll(() => phaseOf(second), { timeout: WAIT, message: 'the second page reports other-tab' }).toBe('other-tab');
      expect(await phaseOf(page)).toBe('ready');
      await second.close();
    });

    expect(pageErrors).toEqual([]);
  } finally {
    await peer.close();
  }
});
