import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import {
  A, BOB, BOB_DEV, MEMBERS, OWN_DEV, bobChanged, callState, DM, GENV, MUSIC, renderVoiceShell, TEXT, type VoiceHarnessOptions,
} from '../../test/fake-client.ts';
import { ME } from '../../test/fixtures.ts';
import { expectNoAxeViolations } from '../../test/setup.ts';
import { PHONE_QUERY } from '../../layout.ts';
import { isApplePlatform, voiceShortcutText } from './shortcuts.ts';

afterEach(() => { vi.unstubAllGlobals(); });

const main = () => within(screen.getByRole('main'));
// The dock holds its controls only while the stage is not on screen (web3.7): these step off the stage and back on it.
const go = (path: string) => { window.history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate')); };
async function offStage() {
  go(`/c/${A}/${TEXT}`);
  await screen.findByRole('toolbar', { name: 'voice controls' });
}
async function onStage() {
  go(`/c/${A}/${GENV}`);
  await main().findByRole('toolbar', { name: 'voice channel controls' });
}
const UMK = { code: 'E_UMK_CHANGED', detail: '', status: 0, retryAfterMs: null };

/** Joins voice 'general' from its voice view; the worker then reports the call in. */
async function inVoice(o: VoiceHarnessOptions = {}) {
  const app = renderVoiceShell(o);
  await app.user.click(await main().findByRole('button', { name: 'join voice' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
  await main().findByRole('toolbar', { name: 'voice channel controls' });
  return app;
}

describe('voice in the shell', () => {
  it('shows the AFK channel as an ordinary voice view with a join button and the muted stage line', async () => {
    renderVoiceShell({ path: `/c/${A}/${MUSIC}`, voice: { [MUSIC]: { callId: MUSIC, participants: [
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 0, own: false, web: false, bot: false }] } } });
    const app = screen.getByRole('main');
    expect(await within(app).findByRole('button', { name: 'join voice' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: t('voice.afk.title') })).toBeNull();
  });

  it('in the AFK call every tile and row shows the muted glyph, the stage says so, and mic, camera and share are disabled', async () => {
    const app = renderVoiceShell({ path: `/c/${A}/${MUSIC}`, voice: { [MUSIC]: { callId: MUSIC, participants: [
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 0, own: false, web: false, bot: false }] } } });
    app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false });
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(vi.mocked(app.module.startPageCall).mock.calls[0][2].listenOnly).toBe(true);
    app.client.publish('call', callState({ phase: 'in', channelId: MUSIC, callId: MUSIC }));
    await main().findByRole('toolbar', { name: 'voice channel controls' });
    expect(document.querySelector('.d-call-stage__outgoing')).toHaveTextContent(t('afk.stage.muted', { channel: 'music' }));
    for (const name of ['mute', 'camera', 'share screen']) {
      const control = main().getByRole('button', { name });
      expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(control).toHaveAccessibleDescription(new RegExp(t('afk.stage.muted', { channel: 'music' })));
      expect(control).not.toHaveAccessibleDescription(new RegExp(t('voice.why.paused')));
    }
    expect(main().getByRole('button', { name: 'leave' })).not.toHaveAttribute('aria-disabled', 'true');
    for (const tile of document.querySelectorAll('.dw-voice-stage .d-call-tile')) {
      expect(within(tile as HTMLElement).getByRole('img', { name: 'muted' })).toBeInTheDocument();
    }
    expect(document.querySelectorAll('.dw-voice-stage .d-call-tile').length).toBeGreaterThan(0);
    // The sidebar row of the AFK channel lists its people muted too.
    const people = [...document.querySelectorAll('.d-voice-row__person')];
    expect(people.length).toBeGreaterThan(0);
    for (const person of people) expect(person.querySelector('[data-state="muted"]')).not.toBeNull();
  });

  it('final review I-2: in the AFK call the dock\u2019s camera and share are disabled with the stage\u2019s AFK reason', async () => {
    const app = renderVoiceShell({ path: `/c/${A}/${MUSIC}`, voice: { [MUSIC]: { callId: MUSIC, participants: [
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 0, own: false, web: false, bot: false }] } } });
    app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false });
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: MUSIC, callId: MUSIC }));
    const dock = within(await screen.findByRole('toolbar', { name: t('voice.dock.region') }));
    for (const name of ['camera', 'share screen']) {
      const control = dock.getByRole('button', { name });
      expect(control).toHaveAttribute('aria-disabled', 'true');
      expect(control).toHaveAccessibleDescription(t('afk.stage.muted', { channel: 'music' }));
      await app.user.click(control);
    }
    expect(app.session.setCamera).not.toHaveBeenCalled();
    expect(dock.getByRole('button', { name: 'leave' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('final review I-2 control: in an ordinary call the dock\u2019s camera is live', async () => {
    await inVoice();
    const dock = within(screen.getByRole('toolbar', { name: t('voice.dock.region') }));
    expect(dock.getByRole('button', { name: 'camera' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('an ordinary voice call keeps its controls live and shows no muted-for-everyone line (control)', async () => {
    const app = await inVoice();
    expect(main().queryByText(t('afk.stage.muted', { channel: 'general' }))).toBeNull();
    for (const name of ['mute', 'camera']) expect(main().getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true');
    expect(vi.mocked(app.module.startPageCall).mock.calls[0][2].listenOnly).toBeFalsy();
  });

  it('reports actual input while a voice call remains open on another page', async () => {
    const app = await inVoice();
    app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false });
    expect(app.client.callsOf('afkActivity')).toHaveLength(1);
    expect(app.client.callsOf('afkActivity')[0]).toEqual({ m: 'afkActivity', communityId: A, channelId: GENV }); // desktop: not exempt
    app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false });
    expect(app.client.callsOf('afkActivity')).toHaveLength(1);
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000);
    go(`/dm/${DM}`);
    fireEvent.pointerMove(window);
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(2));
    expect(app.client.callsOf('afkActivity')[1]).toEqual({ m: 'afkActivity', communityId: A, channelId: GENV });
    dateNow.mockRestore();
  });

  it('reports a short microphone utterance before the next polling interval', async () => {
    const app = await inVoice();
    app.client.publish(`afk:${A}`, { channelId: MUSIC, timeoutSeconds: 300, pending: false });
    expect(app.client.callsOf('afkActivity')).toHaveLength(1);
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now + 6_000);
    act(() => app.session.update({ speaking: true }));
    await waitFor(() => expect(app.client.callsOf('afkActivity')).toHaveLength(2));
    act(() => app.session.update({ speaking: false }));
    dateNow.mockRestore();
  });

  it('retries a restored call after a transient start failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const app = renderVoiceShell({ update: { currentEntry: '/assets/new.js', watch: () => () => undefined,
      store: { save: () => Promise.resolve(), load: async () => { await gate; return { state: { call: { channelId: GENV, camera: true, sharing: false } }, files: [] }; },
        remove: () => Promise.resolve() }, reload: vi.fn() } });
    let attempts = 0;
    app.client.handler = command => {
      if (command.m === 'callJoin' && ++attempts === 1) return Promise.reject(Object.assign(new Error('temporary'), { code: 'E_DISCONNECTED' }));
      if (command.m === 'callJoin') app.client.set('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
      return Promise.resolve(null);
    };
    release();
    await waitFor(() => expect(attempts).toBe(2), { timeout: 4_000 });
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(app.session.setCamera).toHaveBeenCalledWith(true);
  });
  it('rejoins after a lost media connection and keeps the call available', async () => {
    const app = await inVoice();
    act(() => {
      app.session.update({ camera: true, sharing: true });
      app.session.update({ phase: 'ended', error: 'E_DISCONNECTED' });
      app.client.publish('call', callState({ phase: 'removed', channelId: GENV,
        error: { code: 'E_DISCONNECTED', detail: '', status: 0, retryAfterMs: null } }));
    });
    await waitFor(() => expect(app.sessions).toHaveLength(2), { timeout: 4_000 });
    expect(app.client.callsOf('callJoin')).toHaveLength(2);
    expect(app.session.setCamera).toHaveBeenCalledWith(true);
    expect(screen.getByText(t('update.sharingStopped'))).toBeInTheDocument();
  });
  it('lets the person cancel a pending automatic voice rejoin', async () => {
    const app = await inVoice();
    act(() => app.session.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await app.user.click(screen.getByRole('button', { name: 'leave' }));
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(app.sessions).toHaveLength(1);
  });
  it('stops automatic rejoin when the call refuses the device permanently', async () => {
    const app = await inVoice();
    app.client.handler = command => command.m === 'callJoin'
      ? Promise.reject(Object.assign(new Error('E_FORBIDDEN'), { code: 'E_FORBIDDEN' }))
      : Promise.resolve(null);
    act(() => app.session.update({ phase: 'ended', error: 'E_DISCONNECTED' }));
    await waitFor(() => expect(app.client.callsOf('callJoin')).toHaveLength(2), { timeout: 4_000 });
    await waitFor(() => expect(screen.queryByText(t('update.rejoiningVoice'))).toBeNull());
    await new Promise(resolve => setTimeout(resolve, 2_100));
    expect(app.client.callsOf('callJoin')).toHaveLength(2);
  });
  it('keeps a just-ended room for the update refresh to rejoin', async () => {
    let changed!: (entry: string) => void;
    const save = vi.fn<(...args: [unknown, unknown, readonly File[]]) => Promise<void>>().mockResolvedValue();
    const reload = vi.fn();
    const app = await inVoice({ update: { currentEntry: '/assets/old.js',
      watch: options => { changed = entry => options.changed(entry); return () => undefined; },
      store: { save, load: () => Promise.resolve(null), remove: () => Promise.resolve() }, reload } });
    act(() => app.session.update({ phase: 'ended', error: 'E_CALL_ENDED' }));
    act(() => changed('/assets/new.js'));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[1]).toMatchObject({ call: { channelId: GENV } });
  });
  it('reopens a community voice room closed while an update is in progress', async () => {
    let changed!: (entry: string) => void;
    const app = await inVoice({ update: { currentEntry: '/assets/old.js',
      watch: options => { changed = entry => options.changed(entry); return () => undefined; },
      store: { save: () => new Promise<void>(() => undefined), load: () => Promise.resolve(null), remove: () => Promise.resolve() },
      reload: vi.fn() } });
    act(() => changed('/assets/new.js'));
    act(() => {
      app.session.update({ phase: 'ended', error: 'E_CALL_ENDED' });
      app.client.publish('call', callState({ phase: 'removed', channelId: GENV,
        error: { code: 'E_CALL_ENDED', detail: '', status: 0, retryAfterMs: null } }));
    });
    await waitFor(() => expect(app.sessions).toHaveLength(2), { timeout: 4_000 });
    expect(app.client.callsOf('callJoin')).toHaveLength(2);
  });
  it('Control+Shift+M toggles mute only while in voice; a bare "m" does nothing', async () => {
    const app = await inVoice();
    await app.user.keyboard('m');
    expect(app.session.muted).toBe(false);
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    expect(app.session.muted).toBe(true);
    await app.user.keyboard('{Meta>}{Shift>}M{/Shift}{/Meta}');
    expect(app.session.muted).toBe(false);
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(app.session.deafened).toBe(true);
    expect(screen.getByText(t('voice.announce.deafened'))).toBeInTheDocument();
  });

  it('binds no shortcut outside voice', async () => {
    const app = renderVoiceShell();
    await main().findByRole('button', { name: 'join voice' });
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    expect(app.sessions).toHaveLength(0);
    expect(app.client.calls.filter(c => c.m === 'voiceSelf')).toHaveLength(0);
  });

  it('a blocked call shows voice.blockedChanged and does not pause the DM composer', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}`, call: callState({ phase: 'blocked', channelId: DM, error: UMK, changedUser: BOB }) });
    expect(await screen.findByText(t('voice.blockedChanged', { name: 'bob' }))).toBeInTheDocument();
    const composer = screen.getByRole('textbox', { name: 'message @bob' });
    expect(composer).not.toHaveAttribute('aria-disabled');
    expect(composer).not.toHaveAttribute('readonly');
    // Ruling I2: with changedUser null the notice is voice.blockedJoin.
    app.client.publish('call', callState({ phase: 'blocked', channelId: DM, error: UMK, changedUser: null }));
    expect(await screen.findByText(t('voice.blockedJoin'))).toBeInTheDocument();
    expect(screen.queryByText(t('voice.blockedChanged', { name: 'bob' }))).toBeNull();
    expect(screen.getByRole('textbox', { name: 'message @bob' })).not.toHaveAttribute('aria-disabled');
  });

  it('a paused call shows the voice.paused banner, focuses its action once, and announces voice.resumed when it ends', async () => {
    const app = await inVoice({ trust: [bobChanged()], withSettings: true });
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    const text = t('voice.paused', { name: 'bob' });
    expect(await screen.findByText(text)).toBeInTheDocument();
    const action = main().getByRole('button', { name: 'compare safety numbers' });
    await waitFor(() => expect(action).toHaveFocus());
    // A re-render does not move focus again.
    main().getByRole('button', { name: 'leave' }).focus();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    expect(main().getByRole('button', { name: 'leave' })).toHaveFocus();
    expect(screen.getByText('paused in general')).toBeInTheDocument();
    expect(app.session.setPaused).toHaveBeenCalledWith(true);
    expect(app.session.setPaused).toHaveBeenCalledTimes(1);
    // The action opens Privacy's comparison for bob.
    await app.user.click(main().getByRole('button', { name: 'compare safety numbers' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/privacy'));
    await waitFor(() => expect(app.client.callsOf('safetyNumber')).toEqual([{ m: 'safetyNumber', userId: BOB, umk: 'cd'.repeat(32) }]));
    // The pause ends.
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(screen.getByText(t('voice.resumed'))).toBeInTheDocument();
    expect(screen.getByText(t('voice.resumed')).closest('[role="status"]')).not.toBeNull();
    expect(app.session.setPaused).toHaveBeenLastCalledWith(false);
    expect(app.sounds.played).toEqual([]);
  });

  it('a block or a removal leaves the page call and never resumes it', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: { ...UMK, code: 'E_DEVICE_UNLISTED' } }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('blocked'));
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
    expect(await screen.findByText(t('voice.blocked'))).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull();
  });

  it('an unsupported browser shows the dialog instead of joining, and focus returns to join voice', async () => {
    const app = renderVoiceShell({ supported: false });
    const join = await main().findByRole('button', { name: 'join voice' });
    await app.user.click(join);
    expect(await screen.findByRole('dialog', { name: 'Voice does not work in this browser' })).toBeInTheDocument();
    expect(app.client.callsOf('callJoin')).toEqual([]);
    expect(app.module.startPageCall).not.toHaveBeenCalled();
    await app.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(main().getByRole('button', { name: 'join voice' })).toHaveFocus();
  });

  it('switching voice channels leaves the first call before joining the second', async () => {
    const app = await inVoice();
    let release: () => void = () => undefined;
    app.session.leaveGate = new Promise<void>(resolve => { release = resolve; });
    await app.user.click(screen.getByRole('button', { name: 'voice music' }));
    await waitFor(() => expect(window.location.pathname).toContain(MUSIC));
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.log).toContain('leave:switch'));
    expect(app.log).not.toContain(`callJoin:${MUSIC}`);
    release();
    await waitFor(() => expect(app.log).toContain(`callJoin:${MUSIC}`));
    expect(app.log.indexOf('left:switch')).toBeLessThan(app.log.indexOf(`callJoin:${MUSIC}`));
    expect(app.client.callsOf('callJoin').map(c => c.channelId)).toEqual([GENV, MUSIC]);
  });

  it('joins with the stored options and moves focus to the first stage control, then leaves back to the row', async () => {
    const app = await inVoice({ settings: { 'voice.mode': 'ptt', 'voice.pttKey': 'F13', 'voice.noise': 'off' } });
    const opts = vi.mocked(app.module.startPageCall).mock.calls[0][2];
    expect(opts).toMatchObject({ mode: 'ptt', noise: 'off', input: '', output: '' });
    expect(app.module.bindPushToTalk).toHaveBeenCalledWith(expect.objectContaining({ code: 'F13' }));
    await waitFor(() => expect(main().getByRole('toolbar', { name: 'voice channel controls' }).querySelector('button')).toHaveFocus());
    expect(screen.getByRole('toolbar', { name: 'voice controls' })).toBeInTheDocument();
    expect(screen.getByText(t('layout.dock.connected'))).toBeInTheDocument();
    await app.user.click(main().getByRole('button', { name: 'leave' }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('user'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull());
    expect(screen.getByRole('button', { name: 'voice general' })).toHaveFocus();
  });

  it('a stored push-to-talk key that is not one key on its own binds nothing', async () => {
    const app = await inVoice({ settings: { 'voice.mode': 'ptt', 'voice.pttKey': 'KeyV' } });
    expect(app.module.bindPushToTalk).not.toHaveBeenCalled();
  });

  it('maps the microphone outcome to its notice without hiding video', async () => {
    const app = await inVoice();
    app.session.update({ mic: 'failed', error: 'E_MIC_PUBLISH' });
    expect(await screen.findByText(t('voice.micFailed'))).toBeInTheDocument();
    expect(document.querySelector('.d-call-stage')).not.toHaveAttribute('data-media-hidden');
    app.session.update({ mic: 'denied', error: null });
    expect(await screen.findByText(t('voice.micDenied'))).toBeInTheDocument();
  });

  it('lists who is in voice under their voice row in the one list, with no voice headings', async () => {
    renderVoiceShell({ voice: { [GENV]: { callId: GENV, participants: [
      { userId: BOB, deviceId: '29'.repeat(16), name: 'bob', flags: 1 | 2, own: false, web: true, bot: false },
    ] } } });
    expect(await screen.findByRole('button', { name: 'voice general' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'active voice' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'voice' })).toBeNull();
    expect(screen.getAllByText('bob').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: 'muted' }).length).toBeGreaterThan(0);
  });
});

// Security-scanner lead (fail-open state drift): the session follows the call slice on every change, whenever it arrives.
describe('the session follows the call slice', () => {
  const start = async (o: VoiceHarnessOptions = {}) => {
    const app = renderVoiceShell(o);
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.log).toContain(`callJoin:${GENV}`));
    return { app, release };
  };
  it('a paused slice that arrived while the start was pending pauses the session once it attaches', async () => {
    const { app, release } = await start();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
  });
  it('a blocked slice that arrived while the start was pending leaves the session once it attaches', async () => {
    const { app, release } = await start();
    app.client.publish('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('blocked'));
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
  });
  // WB client I1: the start is cancelled at once (the worker told with callLeave); no session is made for nobody.
  it('an unmount while the start is pending cancels the start and tells the worker', async () => {
    const { app, release } = await start();
    app.view.unmount();
    release();
    await waitFor(() => expect(app.log).toContain(`aborted:${GENV}`));
    // The abort's own callLeave, and the follow-up leave a next join would wait for.
    expect(app.client.callsOf('callLeave').length).toBeGreaterThan(0);
    expect(app.client.callsOf('callLeave').every(c => c.reason === 'user')).toBe(true);
    expect(app.sessions).toHaveLength(0);
  });
  it('an unmount in voice leaves the session and never unpauses it', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
    app.view.unmount();
    expect(app.session.leave).toHaveBeenCalledWith('user');
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
  });
  it('a slice that drops to idle, or names another channel, after the call was live leaves the session', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'idle' }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('removed'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull());
    app.view.unmount();
    const second = await inVoice();
    second.client.publish('call', callState({ phase: 'in', channelId: MUSIC, callId: MUSIC }));
    await waitFor(() => expect(second.session.leave).toHaveBeenCalledWith('removed'));
  });
  it('a pause or block for another channel is not applied to this session', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: MUSIC, callId: MUSIC, error: UMK, changedUser: BOB }));
    expect(app.session.setPaused).not.toHaveBeenCalled();
    expect(screen.queryByText(t('voice.paused', { name: 'bob' }))).toBeNull();
  });
  it('a start that resolves after the slice already left the call ends the session at once', async () => {
    const { app, release } = await start();
    app.client.publish('call', callState({ phase: 'idle' }));
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('removed'));
    expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull();
  });
  it('the latest slice wins when several arrive between two renders', async () => {
    const app = await inVoice();
    act(() => {
      app.client.set('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
      app.client.set('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    });
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('blocked'));
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
  });
  it('a setPaused that fails tears the session down rather than leave media running', async () => {
    const app = await inVoice();
    app.session.setPaused.mockImplementation(() => Promise.reject(new Error('E_INTERNAL')));
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('removed'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull());
  });
  it('a setPaused that throws, or a leave that throws, never escapes and never keeps the session attached', async () => {
    const app = await inVoice();
    app.session.setPaused.mockImplementation(() => { throw new Error('E_INTERNAL'); });
    app.session.leave.mockImplementation(() => { throw new Error('E_INTERNAL'); });
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('removed'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull());
  });
});

// Task-9 review, fix round 1.
describe('review round 1', () => {
  const lasting = () => document.querySelector('.dw-voice-lasting');
  const toLobby = async (app: ReturnType<typeof renderVoiceShell>) => {
    window.history.pushState(null, '', `/c/${A}/${TEXT}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice channel controls' })).toBeNull());
    void app;
  };

  it('I1: a block after a pause that already rendered leaves and never unpauses', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
    app.client.publish('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('blocked'));
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole('toolbar', { name: 'voice channel controls' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull();
  });

  it('I1: a removal leaves with "removed", shows voice.removed in the voice view and ends the dock', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'removed', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('removed'));
    expect(app.session.setPaused).not.toHaveBeenCalled();
    expect(await main().findByText(t('voice.removed'))).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull();
  });

  it('I2: switching the input mode in a call follows in the session; push to talk binds only once the session is in it', async () => {
    const app = await inVoice({ settings: { 'voice.pttKey': 'F13' } });
    expect(app.module.bindPushToTalk).not.toHaveBeenCalled();
    app.client.publish('settings', { 'voice.pttKey': 'F13', 'voice.mode': 'ptt' });
    expect(app.session.setMode).toHaveBeenCalledWith('ptt');
    await waitFor(() => expect(app.module.bindPushToTalk).toHaveBeenCalledWith(expect.objectContaining({ code: 'F13' })));
    expect(app.log.indexOf('mode:ptt')).toBeGreaterThanOrEqual(0);
    expect(document.querySelector('.d-voice-dock')).toHaveTextContent(t('settings.voice.ptt'));
    app.client.publish('settings', { 'voice.pttKey': 'F13' });
    expect(app.session.setMode).toHaveBeenLastCalledWith('vad');
    expect(document.querySelector('.d-voice-dock')).toHaveTextContent(t('settings.voice.vad'));
  });

  it('I2: a push-to-talk key is never bound while the session is not in push to talk', async () => {
    const app = await inVoice({ settings: { 'voice.pttKey': 'F13' } });
    // The session does not take the mode (an ended session ignores it): the key must not bind, or it would suggest a
    // closed microphone that is open.
    app.session.setMode.mockImplementation(() => undefined);
    app.client.publish('settings', { 'voice.pttKey': 'F13', 'voice.mode': 'ptt' });
    expect(app.session.setMode).toHaveBeenCalledWith('ptt');
    expect(app.module.bindPushToTalk).not.toHaveBeenCalled();
  });

  it('f10app m2: a rejoin that waits for its earlier Remove is announced in the dock status', async () => {
    const app = renderVoiceShell();
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    const status = () => document.querySelector('.d-voice-dock [role="status"]');
    await waitFor(() => expect(status()).not.toBeNull());
    app.client.publish('call', callState({ phase: 'joining', channelId: GENV }));
    expect(status()).not.toHaveTextContent(t('voice.announce.rejoining', { where: 'general' }));
    app.client.publish('call', callState({ phase: 'joining', channelId: GENV, rejoining: true }));
    await waitFor(() => expect(status()).toHaveTextContent('Rejoining general. This can take up to 30 seconds.'));
    release();
  });

  it('I3: the outgoing ring is announced in the dock status, once per change', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}` });
    await app.user.click(await main().findByRole('button', { name: 'call' }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing: { ringing: ['bob'], declined: [], notRung: [] } }));
    const status = () => document.querySelector('.d-voice-dock [role="status"]');
    await waitFor(() => expect(status()).toHaveTextContent('ringing bob'));
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing: { ringing: [], declined: ['bob'], notRung: [] } }));
    await waitFor(() => expect(status()).toHaveTextContent('bob declined.'));
  });

  it('I4 and m4: off the stage, the dock pause banner is a status with a described, full-size action that takes focus once', async () => {
    const app = await inVoice({ trust: [bobChanged()] });
    await toLobby(app);
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    const banner = await waitFor(() => { const b = document.querySelector('.dw-voice-dock__paused'); expect(b).not.toBeNull(); return b!; });
    expect(banner).toHaveAttribute('role', 'status');
    const action = within(banner as HTMLElement).getByRole('button', { name: 'compare safety numbers' });
    expect(action).toHaveAccessibleDescription(t('voice.paused', { name: 'bob' }));
    expect(action).not.toHaveAttribute('data-size', 'sm');
    await waitFor(() => expect(action).toHaveFocus());
    // Opening the voice view later does not take focus again for the same pause.
    await app.user.click(screen.getByRole('button', { name: 'voice general' }));
    await main().findByRole('button', { name: 'compare safety numbers' });
    expect(screen.getByRole('button', { name: 'voice general' })).toHaveFocus();
  });

  it('I6: a block off the stage is announced where it outlives the dock, and focus in the dock goes to the voice row', async () => {
    const app = await inVoice();
    await toLobby(app);
    screen.getByRole('toolbar', { name: 'voice controls' }).querySelector('button')!.focus();
    app.client.publish('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: { ...UMK, code: 'E_DEVICE_UNLISTED' } }));
    await waitFor(() => expect(lasting()).toHaveTextContent(t('voice.blocked')));
    expect(screen.getByRole('button', { name: 'voice general' })).toHaveFocus();
  });

  it('I6: a removal off the stage is announced too', async () => {
    const app = await inVoice();
    await toLobby(app);
    app.client.publish('call', callState({ phase: 'removed', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(lasting()).toHaveTextContent(t('voice.removed')));
  });

  it('"You left {where}." is announced in a status region that outlives the dock', async () => {
    const app = await inVoice();
    await app.user.click(main().getByRole('button', { name: 'leave' }));
    await waitFor(() => expect(lasting()).toHaveTextContent('You left general.'));
    expect(lasting()).toHaveAttribute('role', 'status');
  });

  it('m9: no join button while the sendBlocks slice is not known yet (a block counts as held)', () => {
    renderVoiceShell({ call: callState({ phase: 'blocked', channelId: GENV, error: { ...UMK, code: 'E_DEVICE_UNLISTED' } }) });
    expect(main().getByText(t('voice.blockedJoin'))).toBeInTheDocument();
    expect(main().queryByRole('button', { name: 'join voice' })).toBeNull();
  });

  // Integration ruling (2026-10-13): a block that came only from the call group (the channel's own sendBlocks entry is
  // clear, no changedUser) offers the join again. The call group was left and forgotten, so nothing can show the block
  // cleared; a new join is safe because call_join_check refuses a staged join before anything is posted, and RV-2 closes a
  // poisoned idle group. Attacker: a member (or the instance) who poisons one call group must not lock this person out of
  // the channel's voice for good.
  it('a call-group-only block keeps its notice and offers the join again', async () => {
    const app = renderVoiceShell({ sendBlocks: {},
      call: callState({ phase: 'blocked', channelId: GENV, error: { ...UMK, code: 'E_DEVICE_UNLISTED' }, changedUser: null }) });
    expect(main().getByText(t('voice.blockedRetry'))).toBeInTheDocument();
    await app.user.click(main().getByRole('button', { name: 'join voice' }));
    expect(app.client.calls.filter(c => c.m === 'callJoin')).toHaveLength(1);
  });

  it('a block of the DM text group keeps the call button hidden until the sendBlocks entry clears', async () => {
    const block = { code: 'E_DEVICE_UNLISTED' as const, own: false };
    const app = renderVoiceShell({ path: `/dm/${DM}`, sendBlocks: { [DM]: block },
      call: callState({ phase: 'blocked', channelId: DM, error: { ...UMK, code: 'E_DEVICE_UNLISTED' }, changedUser: null }) });
    expect(await main().findByText(t('voice.blockedJoin'))).toBeInTheDocument();
    expect(main().queryByRole('button', { name: 'call' })).toBeNull();
    act(() => app.client.publish('sendBlocks', {}));
    expect(await main().findByRole('button', { name: 'call' })).toBeInTheDocument();
  });

  it('a changed identity keeps the join hidden even with the sendBlocks entry clear', () => {
    renderVoiceShell({ sendBlocks: {}, trust: [bobChanged()], call: callState({ phase: 'blocked', channelId: GENV, error: UMK, changedUser: null }) });
    expect(main().queryByRole('button', { name: 'join voice' })).toBeNull();
  });

  // Web-3 task 10, concern 3: the block's cause verified clears it without a reload, named or not.
  it('a block by a named changed contact names them and offers the join again once they are verified', async () => {
    const app = renderVoiceShell({ sendBlocks: {}, trust: [bobChanged()],
      call: callState({ phase: 'blocked', channelId: GENV, error: UMK, changedUser: BOB }) });
    expect(main().getByText(t('voice.blockedChanged', { name: 'bob' }))).toBeInTheDocument();
    expect(main().queryByRole('button', { name: 'join voice' })).toBeNull();
    act(() => app.client.publish('trust', [{ ...bobChanged(), umk: 'cd'.repeat(32), verified: true, changedUmk: null }]));
    expect(await main().findByRole('button', { name: 'join voice' })).toBeInTheDocument();
  });

  it('an unnamed changed-identity block offers the join again once no contact is changed any more', async () => {
    const app = renderVoiceShell({ sendBlocks: {}, trust: [bobChanged()],
      call: callState({ phase: 'blocked', channelId: GENV, error: UMK, changedUser: null }) });
    expect(main().queryByRole('button', { name: 'join voice' })).toBeNull();
    act(() => app.client.publish('trust', [{ ...bobChanged(), umk: 'cd'.repeat(32), verified: true, changedUmk: null }]));
    expect(await main().findByRole('button', { name: 'join voice' })).toBeInTheDocument();
  });

  it('a block by a changed contact keeps the join hidden while that contact is changed', () => {
    renderVoiceShell({ sendBlocks: {}, trust: [bobChanged()],
      call: callState({ phase: 'blocked', channelId: GENV, error: UMK, changedUser: BOB }) });
    expect(main().queryByRole('button', { name: 'join voice' })).toBeNull();
  });

  it('the voice row’s join is reachable from the keyboard: Tab from the row reaches it', async () => {
    const app = renderVoiceShell({ path: `/c/${A}/${TEXT}` });
    screen.getByRole('button', { name: 'voice general' }).focus();
    await app.user.tab();
    expect(document.activeElement).toHaveAccessibleName('join voice');
    expect(document.activeElement?.closest('.d-voice-item')).toContainElement(screen.getByRole('button', { name: 'voice general' }));
  });

  // Product walk M4: the SFU's own speaking (the session's state.speaking), no longer the meter level.
  it('the own tile shows speaking when the SFU hears this device', async () => {
    const app = await inVoice();
    const own = () => document.querySelector('.d-call-tile[data-own="true"]');
    expect(own()).toHaveAttribute('data-speaking', 'false');
    act(() => app.session.update({ level: 8 }));
    expect(own()).toHaveAttribute('data-speaking', 'false');
    act(() => app.session.update({ speaking: true }));
    expect(own()).toHaveAttribute('data-speaking', 'true');
  });

  it('I7: in a DM call a "messages" toggle swaps the stage for the log and composer', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}` });
    await app.user.click(await main().findByRole('button', { name: 'call' }));
    await main().findByRole('toolbar', { name: 'call controls' });
    const box = document.querySelector('.dw-dm-call')!;
    expect(box).toHaveAttribute('data-view', 'stage');
    const toggle = main().getByRole('button', { name: 'messages' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await app.user.click(toggle);
    expect(box).toHaveAttribute('data-view', 'messages');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('web3.9 WEB-AFK: the AFK channel in the shell', () => {
  const afkSlice = (over: Record<string, unknown> = {}) => ({ channelId: MUSIC, timeoutSeconds: 300, pending: false, ...over });
  it('the AFK row is a plain voice row: not held, with the voice glyph and a join; no move or leave command exists', async () => {
    const app = renderVoiceShell({ voice: { [MUSIC]: { callId: MUSIC, participants: [
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 0, own: false, web: false, bot: false }] } } });
    app.client.publish(`afk:${A}`, afkSlice());
    const row = (await screen.findByRole('button', { name: 'voice music' })).closest('li') as HTMLElement;
    expect(row.querySelector('svg[data-icon="volume-2"]')).not.toBeNull();
    expect(row.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(within(row).getByRole('button', { name: /join/i })).toBeInTheDocument();
    await app.user.click(within(row).getByRole('button', { name: /join/i }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(vi.mocked(app.module.startPageCall).mock.calls[0][2].listenOnly).toBe(true);
  });

  it('while in an ordinary call, the open AFK channel offers a join and no move or leave control', async () => {
    const app = await inVoice();
    app.client.publish(`afk:${A}`, afkSlice());
    go(`/c/${A}/${MUSIC}`);
    expect(await main().findByRole('button', { name: 'join voice' })).toBeInTheDocument();
    expect(screen.queryByText(/move to afk|leave afk/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /move to afk|leave afk/i })).toBeNull();
  });

  it('Shell hands the slice’s seq to useCall: a second sweep’s read (a higher seq, no false read between) moves again', async () => {
    const app = renderVoiceShell();
    app.client.publish(`afk:${A}`, afkSlice({ pending: true, seq: 3 }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: MUSIC, callId: MUSIC }));
    // The person leaves the AFK call and joins general; later the sweep cuts that call and its read lands seq 4.
    await app.user.click(await screen.findByRole('button', { name: 'leave' }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalled());
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.sessions).toHaveLength(2));
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + 120_000);
    app.client.publish(`afk:${A}`, afkSlice({ pending: true, seq: 4 }));
    await waitFor(() => expect(app.client.callsOf('callJoin').filter(c => c.channelId === MUSIC)).toHaveLength(2));
    vi.restoreAllMocks();
  });

  it('a pending move joins the AFK channel once, and a republished read of it does not join again', async () => {
    const app = renderVoiceShell();
    app.client.publish(`afk:${A}`, afkSlice({ pending: true, seq: 3 }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(app.log.filter(l => l === `callJoin:${MUSIC}`)).toHaveLength(1);
    app.client.publish(`afk:${A}`, afkSlice({ pending: true, seq: 3 }));
    await new Promise(r => setTimeout(r, 200));
    expect(app.log.filter(l => l === `callJoin:${MUSIC}`)).toHaveLength(1);
    expect(vi.mocked(app.module.startPageCall).mock.calls[0][2].listenOnly).toBe(true);
  });

  it('a failed move shows afk.moved with a join button that joins the AFK channel', async () => {
    const app = renderVoiceShell();
    let fail = true;
    const base = app.client.handler;
    app.client.handler = command => command.m === 'callJoin' && command.channelId === MUSIC && fail
      ? Promise.reject(Object.assign(new Error('E_FORBIDDEN'), { code: 'E_FORBIDDEN' })) : base(command);
    app.client.publish(`afk:${A}`, afkSlice({ pending: true, seq: 4 }));
    const line = await screen.findByText(t('afk.moved', { channel: 'music' }));
    const banner = line.closest('.d-banner') as HTMLElement;
    fail = false;
    await app.user.click(within(banner).getByRole('button', { name: t('afk.moved.join') }));
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(app.client.callsOf('callJoin').filter(c => c.channelId === MUSIC)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText(t('afk.moved', { channel: 'music' }), { selector: '.d-banner *' })).toBeNull());
  });
});

describe('push to talk in the user panel (web3.9)', () => {
  const panelMic = () => within(screen.getByRole('toolbar', { name: t('panel.region') })).getByRole('button', { name: 'mute' });
  it('shows the PTT tag and the push to talk description in push-to-talk mode, the ring while heard', async () => {
    const app = await inVoice({ settings: { 'voice.mode': 'ptt', 'voice.pttKey': 'F13' } });
    expect(screen.getByText(t('layout.ptt.tag'))).toHaveAttribute('aria-hidden', 'true');
    expect(panelMic()).toHaveAccessibleDescription(new RegExp(t('settings.voice.ptt')));
    const ring = () => document.querySelector('.d-user-panel__avatar');
    expect(ring()).not.toHaveAttribute('data-speaking');
    act(() => app.session.update({ speaking: true }));
    expect(ring()).toHaveAttribute('data-speaking', 'true');
  });
  it('shows none of it in voice-activity mode (control)', async () => {
    await inVoice();
    expect(screen.queryByText(t('layout.ptt.tag'))).toBeNull();
  });
});

describe('WEB-DOCK review: a DM call stage carries the hearing line', () => {
  it('shows "hearing {attached} of {expected}" under a DM call\'s controls', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}` });
    await app.user.click(await main().findByRole('button', { name: 'call' }));
    await main().findByRole('toolbar', { name: 'call controls' });
    expect(document.querySelector('.dw-dm-call [data-audio-expected]')).toBeNull();
    act(() => app.session.update({ audio: { attached: 1, expected: 2 } }));
    const line = await waitFor(() => { const l = document.querySelector('.dw-dm-call [data-audio-expected]'); expect(l).not.toBeNull(); return l!; });
    expect(line).toHaveTextContent(t('voice.diag.tracks', { attached: 1, expected: 2 }));
  });
});

describe('web3.3: the browser holds call audio back', () => {
  it('the dock offers "turn on audio" with its hint; a key press starts audio; the line goes once audio plays', async () => {
    const app = await inVoice();
    const turnOn = () => screen.queryByRole('button', { name: t('voice.audioStart') });
    expect(turnOn()).toBeNull();
    expect(screen.queryByText(t('voice.audioBlocked'))).toBeNull();
    act(() => app.session.update({ audioBlocked: true }));
    const button = await screen.findByRole('button', { name: t('voice.audioStart') });
    expect(button).toHaveAccessibleDescription(t('voice.audioBlocked'));
    // Beside the call controls: in the dock, which shows wherever the person is while in a call.
    expect(button.closest('.dw-voice-dock')).not.toBeNull();
    // Review M1: the line is no status region of its own; the dock’s one status region says it, once per change.
    const line = document.querySelector('.dw-voice-dock__audio')!;
    expect(line.closest('[role="status"]')).toBeNull();
    const said = () => [...document.querySelectorAll('[role="status"]')].filter(r => r.textContent === t('voice.audioBlocked'));
    await waitFor(() => expect(said()).toHaveLength(1));
    expect(said()[0].closest('.dw-voice-dock')).not.toBeNull();
    // Said on the false→true change only: a later announcement is not overwritten by an update that keeps it blocked.
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    await waitFor(() => expect(said()).toHaveLength(0));
    act(() => app.session.update({ level: 3 }));
    expect(said()).toHaveLength(0);
    button.focus();
    await app.user.keyboard('{Enter}');
    expect(app.session.startAudio).toHaveBeenCalledTimes(1);
    act(() => app.session.update({ audioBlocked: false }));
    await waitFor(() => expect(turnOn()).toBeNull());
    expect(screen.queryByText(t('voice.audioBlocked'))).toBeNull();
  });
});

describe('web3.4 V2: the stage says how many it hears (web3.9: it left the dock)', () => {
  it('shows "hearing {attached} of {expected}" with its counts while any remote audio is expected, and nothing otherwise', async () => {
    const app = await inVoice();
    const line = () => document.querySelector('.dw-voice-stage [data-audio-expected]'); // web3.9 R26: on the stage, no longer in the dock
    expect(line()).toBeNull();
    // Deafened: a newcomer's track is expected but held back.
    act(() => app.session.update({ audio: { attached: 1, expected: 2 } }));
    const shown = await waitFor(() => { const l = line(); expect(l).not.toBeNull(); return l!; });
    expect(shown).toHaveTextContent(t('voice.diag.tracks', { attached: 1, expected: 2 }));
    expect(shown).toHaveAttribute('data-audio-attached', '1');
    expect(shown).toHaveAttribute('data-audio-expected', '2');
    // A diagnostic, not news: no status region of its own (the dock's one region says what changes).
    expect(shown.closest('[role="status"]')).toBeNull();
    await expectNoAxeViolations(document.querySelector('.dw-voice-stage__lines')!);
    act(() => app.session.update({ audio: { attached: 2, expected: 2 } }));
    await waitFor(() => expect(line()).toHaveAttribute('data-audio-attached', '2'));
    expect(line()).toHaveTextContent(t('voice.diag.tracks', { attached: 2, expected: 2 }));
    act(() => app.session.update({ audio: { attached: 0, expected: 0 } }));
    await waitFor(() => expect(line()).toBeNull());
  });

  it('fix 1: no hearing line while deafened or paused (nothing plays then); it returns after', async () => {
    const app = await inVoice();
    const shown = () => screen.queryByText(t('voice.diag.tracks', { attached: 2, expected: 2 }));
    act(() => app.session.update({ audio: { attached: 2, expected: 2 } }));
    await waitFor(() => expect(shown()).not.toBeNull());
    act(() => app.session.update({ deafened: true, muted: true }));
    await waitFor(() => expect(shown()).toBeNull());
    act(() => app.session.update({ deafened: false }));
    await waitFor(() => expect(shown()).not.toBeNull());
    act(() => app.session.update({ paused: true }));
    await waitFor(() => expect(shown()).toBeNull());
    act(() => app.session.update({ paused: false }));
    await waitFor(() => expect(shown()).not.toBeNull());
  });
});

describe('web3.3 fix round 2: the call context is made in the press (Minor 1); the hold joins the join announcement (Nit 3)', () => {
  it('makes the call’s AudioContext synchronously in the join press and hands that one to the session', async () => {
    const app = renderVoiceShell();
    const button = await main().findByRole('button', { name: 'join voice' });
    fireEvent.click(button);
    // Nothing of the join was awaited yet: the leave in flight, the module load and a switch’s leave all come after.
    expect(app.callContexts).toHaveLength(1);
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    expect(app.startedWith).toEqual([app.callContexts[0]]);
    expect(app.callContexts[0].closed).toBe(false);
  });

  it('closes the context when the browser cannot do voice, and never starts a call', async () => {
    const app = renderVoiceShell({ supported: false });
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    expect(await screen.findByRole('dialog', { name: 'Voice does not work in this browser' })).toBeInTheDocument();
    expect(app.callContexts).toHaveLength(1);
    expect(app.callContexts[0].closed).toBe(true);
    expect(app.startedWith).toEqual([]);
  });

  it('closes the context when the call module fails to load', async () => {
    const app = renderVoiceShell({ loadFails: true });
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.callContexts[0]?.closed).toBe(true));
    expect(app.startedWith).toEqual([]);
  });

  it('closes the context when building the start’s arguments throws before the session gets it', async () => {
    const app = renderVoiceShell();
    app.module.browserDeps = () => { throw new Error('E_INTERNAL'); };
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.callContexts[0]?.closed).toBe(true));
    expect(app.startedWith).toEqual([]);
  });

  it('closes the context of a join cancelled by another before it started; the next join brings its own', async () => {
    const app = await inVoice();
    let release: () => void = () => undefined;
    app.session.leaveGate = new Promise<void>(resolve => { release = resolve; });
    // A row click joins on a desktop (web3.9), so the stage is opened by the route here and joined from its button.
    const go = (id: string) => act(() => { window.history.pushState(null, '', `/c/${A}/${id}`); window.dispatchEvent(new PopStateEvent('popstate')); });
    go(MUSIC);
    await waitFor(() => expect(window.location.pathname).toContain(MUSIC));
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.log).toContain('leave:switch'));
    // While the switch’s leave runs, the person picks general again: the music join is superseded before it started.
    go(GENV);
    await waitFor(() => expect(window.location.pathname).toContain(GENV));
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    expect(app.callContexts).toHaveLength(3);
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(2));
    expect(app.callContexts[1].closed).toBe(true);
    expect(app.startedWith).toEqual([app.callContexts[0], app.callContexts[2]]);
    expect(app.callContexts[2].closed).toBe(false);
  });

  for (const when of ['at-start', 'same-tick'] as const) {
    it(`a hold ${when === 'at-start' ? 'the call starts in' : 'that arrives in the same tick as the join'} is said with "You joined", not instead of it`, async () => {
      const app = renderVoiceShell({ audioBlocked: when });
      await app.user.click(await main().findByRole('button', { name: 'join voice' }));
      await waitFor(() => expect(app.sessions).toHaveLength(1));
      const said = () => [...document.querySelectorAll('.dw-voice-dock [role="status"]')].map(r => r.textContent ?? '');
      await waitFor(() => expect(said().some(s => /^You joined /.test(s) && s.endsWith(` ${t('voice.audioBlocked')}`))).toBe(true));
    });
  }
});

// web3.7: the dock holds the controls only while the stage is off screen, and the stage holds them while it is on, so each
// test reads one, steps across (offStage, onStage), and reads the other. The call stays up across the step.
describe('VI-2: camera and screen share in the voice dock (plan 2026-10-15)', () => {
  const dock = () => within(screen.getByRole('toolbar', { name: 'voice controls' }));
  const userPanel = () => within(screen.getByRole('toolbar', { name: t('panel.region') }));
  const stage = () => within(main().getByRole('toolbar', { name: 'voice channel controls' }));
  // jsdom has no getDisplayMedia; the stage and the dock both read it, so give them one.
  const withCapture = () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn() } });
  };
  afterEach(() => { Reflect.deleteProperty(navigator, 'mediaDevices'); });

  it('the dock holds camera, share screen and leave, and its camera and share are the stage’s toggles', async () => {
    withCapture();
    const app = await inVoice();
    await offStage();
    expect(dock().getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual([t('voice.cameraOn'), t('voice.shareOn'), t('voice.leave')]);
    await app.user.click(dock().getByRole('button', { name: t('voice.cameraOn') }));
    await waitFor(() => expect(app.session.state.camera).toBe(true));
    expect(dock().getByRole('button', { name: t('voice.cameraOn') })).toHaveAttribute('aria-pressed', 'true');
    // One state: the stage's camera shows pressed too, and pressing it there turns the camera off again.
    await onStage();
    await waitFor(() => expect(stage().getByRole('button', { name: t('voice.cameraOn') })).toHaveAttribute('aria-pressed', 'true'));
    await app.user.click(stage().getByRole('button', { name: t('voice.cameraOn') }));
    await waitFor(() => expect(app.session.state.camera).toBe(false));
    await offStage();
    await app.user.click(dock().getByRole('button', { name: t('voice.shareOn') }));
    await waitFor(() => expect(app.session.state.sharing).toBe(true));
    await onStage();
    await waitFor(() => expect(stage().getByRole('button', { name: t('voice.shareOn') })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('without screen capture, share is aria-disabled in the dock as on the stage', async () => {
    await inVoice();
    expect(stage().getByRole('button', { name: t('voice.shareOn') })).toHaveAttribute('aria-disabled', 'true');
    await offStage();
    expect(dock().getByRole('button', { name: t('voice.shareOn') })).toHaveAttribute('aria-disabled', 'true');
    expect(dock().getByRole('button', { name: t('voice.cameraOn') })).not.toHaveAttribute('aria-disabled');
  });

  it('while paused, the dock’s camera and share are aria-disabled and do nothing; mute and leave stay live', async () => {
    withCapture();
    const app = await inVoice({ trust: [bobChanged()], withSettings: true });
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await screen.findByText('paused in general');
    for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) expect(stage().getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    await offStage();
    for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) {
      expect(dock().getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
      await app.user.click(dock().getByRole('button', { name }));
    }
    expect(app.session.state.camera).toBe(false);
    expect(app.session.state.sharing).toBe(false);
    expect(dock().getByRole('button', { name: t('voice.leave') })).not.toHaveAttribute('aria-disabled');
    for (const name of [t('voice.mute'), t('voice.deafen')]) expect(userPanel().getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
  });

  it('while joining, the dock’s camera and share are aria-disabled; the user panel’s mute and deafen and the dock’s leave stay live', async () => {
    withCapture();
    const app = renderVoiceShell();
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.client.callsOf('callJoin')).toHaveLength(1));
    await offStage();
    for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) expect(dock().getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    expect(dock().getByRole('button', { name: t('voice.leave') })).not.toHaveAttribute('aria-disabled');
    for (const name of [t('voice.mute'), t('voice.deafen')]) expect(userPanel().getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(dock().getByRole('button', { name: t('voice.cameraOn') })).not.toHaveAttribute('aria-disabled'));
    expect(dock().getByRole('button', { name: t('voice.shareOn') })).not.toHaveAttribute('aria-disabled');
  });

  it('only the user panel’s mute and deafen carry aria-keyshortcuts and are described by their shortcut; the stage’s tip shows it and they carry none', async () => {
    await inVoice();
    expect(stage().getByRole('button', { name: t('voice.mute') })).not.toHaveAttribute('aria-keyshortcuts');
    expect(stage().getByRole('button', { name: t('voice.deafen') })).not.toHaveAttribute('aria-keyshortcuts');
    expect(userPanel().getByRole('button', { name: t('voice.mute') })).toHaveAccessibleDescription('Ctrl Shift M');
    expect(userPanel().getByRole('button', { name: t('voice.deafen') })).toHaveAccessibleDescription('Ctrl Shift D');
    await offStage();
    expect(userPanel().getByRole('button', { name: t('voice.mute') })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+M Meta+Shift+M');
    expect(dock().queryByRole('button', { name: t('voice.mute') })).toBeNull();
    expect([...document.querySelectorAll('[aria-keyshortcuts]')].filter(e => e.getAttribute('aria-keyshortcuts')!.includes('Shift+M')))
      .toHaveLength(1);
  });

  // Jonas, 2026-10-15: a disabled camera or share says why (voice.why.*), in the dock and on the stage; the name stays.
  it('a disabled camera or share says why: not available, paused, connecting', async () => {
    const app = await inVoice();
    // No getDisplayMedia here: share says so, and camera, live, says nothing.
    const noShare = (bar: ReturnType<typeof dock>) => {
      const share = bar.getByRole('button', { name: t('voice.shareOn') });
      expect(share).toHaveAccessibleName(t('voice.shareOn'));
      expect(share).toHaveAccessibleDescription(t('voice.why.noShare'));
      expect(bar.getByRole('button', { name: t('voice.cameraOn') })).not.toHaveAttribute('aria-describedby');
    };
    const paused = (bar: ReturnType<typeof dock>) => {
      for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) {
        expect(bar.getByRole('button', { name })).toHaveAccessibleDescription(t('voice.why.paused'));
      }
    };
    noShare(stage());
    await offStage();
    noShare(dock());
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await screen.findByText('paused in general');
    paused(dock());
    await onStage();
    paused(stage());
  });

  it('while joining, the dock’s camera and share say connecting', async () => {
    withCapture();
    const app = renderVoiceShell();
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.client.callsOf('callJoin')).toHaveLength(1));
    await offStage();
    for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) {
      expect(dock().getByRole('button', { name })).toHaveAccessibleDescription(t('voice.why.joining'));
    }
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(dock().getByRole('button', { name: t('voice.cameraOn') })).not.toHaveAttribute('aria-describedby'));
    expect(dock().getByRole('button', { name: t('voice.shareOn') })).not.toHaveAttribute('aria-describedby');
  });
});

describe('voiceShortcutText', () => {
  it('writes ⌘⇧M and ⌘⇧D on Apple platforms and Ctrl+Shift+M and Ctrl+Shift+D elsewhere', () => {
    expect(voiceShortcutText(true)).toEqual({ mute: '⌘⇧M', deafen: '⌘⇧D' });
    expect(voiceShortcutText(false)).toEqual({ mute: 'Ctrl+Shift+M', deafen: 'Ctrl+Shift+D' });
  });

  it('reads the platform from userAgentData first, then navigator.platform', () => {
    expect(isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: 'Linux x86_64' })).toBe(true);
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ platform: 'iPhone' })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(false);
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isApplePlatform({ platform: '' })).toBe(false);
    // Review round 1 (#7): Chromium reports an empty UA-CH platform when it does not know; navigator.platform decides then.
    expect(isApplePlatform({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true);
  });
});

describe('web3.7: one set of call controls', () => {
  it('the dock keeps its toolbar while the stage is shown', async () => {
    await inVoice();
    expect(document.querySelector('.dw-voice-dock .d-voice-dock__controls')).not.toBeNull();
    expect(main().getByRole('toolbar', { name: 'voice channel controls' })).toBeInTheDocument();
    go(`/c/${A}/${TEXT}`);
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice channel controls' })).toBeNull());
    expect(document.querySelector('.dw-voice-dock .d-voice-dock__controls')).not.toBeNull();
  });

  it('repeats no element id while both toolbars are on screen', async () => {
    await inVoice();
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('join focuses the stage’s first control, and ArrowRight in the dock toolbar leaves the stage’s focus alone', async () => {
    const app = await inVoice();
    const first = () => main().getByRole('toolbar', { name: 'voice channel controls' }).querySelector('button')!;
    await waitFor(() => expect(first()).toHaveFocus());
    const dockFirst = screen.getByRole('toolbar', { name: 'voice controls' }).querySelector('button')!;
    dockFirst.focus();
    await app.user.keyboard('{ArrowRight}');
    expect(screen.getByRole('toolbar', { name: 'voice controls' }).contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(dockFirst);
    expect(main().getByRole('toolbar', { name: 'voice channel controls' }).contains(document.activeElement)).toBe(false);
  });
});

// A2 (web3.7.2): a phone that cannot capture a screen shows no share control; desktop keeps it, switched off with its reason.
describe('screen share without getDisplayMedia', () => {
  const asPhone = (phone: boolean) => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === PHONE_QUERY ? phone : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  it('on a phone there is no share button on the stage', async () => {
    asPhone(true);
    await inVoice();
    const stage = within(main().getByRole('toolbar', { name: 'voice channel controls' }));
    expect(stage.queryByRole('button', { name: t('voice.shareOn') })).toBeNull();
    expect(stage.getByRole('button', { name: t('voice.cameraOn') })).toBeInTheDocument();
  });

  it('on a phone the stage’s mute and deafen carry aria-keyshortcuts', async () => {
    asPhone(true);
    await inVoice();
    const bar = () => within(main().getByRole('toolbar', { name: 'voice channel controls' }));
    expect(bar().getByRole('button', { name: t('voice.mute') })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+M Meta+Shift+M');
    expect(bar().getByRole('button', { name: t('voice.deafen') })).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+D Meta+Shift+D');
  });

  it('on desktop the share button stays, aria-disabled', async () => {
    asPhone(false);
    await inVoice();
    const share = within(main().getByRole('toolbar', { name: 'voice channel controls' })).getByRole('button', { name: t('voice.shareOn') });
    expect(share).toHaveAttribute('aria-disabled', 'true');
  });
});

// web3.8 WS7: one tile per source (camera, screen, avatar), and R26's one auto-focus rule.
describe('the stage has one tile per source (web3.8 WS7)', () => {
  if (typeof globalThis.MediaStream === 'undefined') {
    (globalThis as { MediaStream?: unknown }).MediaStream = class MediaStream {};
  }
  const room = (flags: number) => ({ [GENV]: { callId: GENV, participants: [
    { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags, own: false, web: false, bot: false },
    { userId: 'carl', deviceId: 'c1', name: 'carl', flags: 0, own: false, web: false, bot: false },
    { userId: ME.id, deviceId: OWN_DEV, name: 'me', flags: 0, own: true, web: true, bot: false },
  ] } });
  const FLAG_MUTE = 1 << 1;
  const FLAG_SCREEN = 1 << 4;
  const ids = () => [...document.querySelectorAll<HTMLElement>('li.d-call-stage__tile')].map(e => e.dataset.tileId);
  const li = (id: string) => document.querySelector<HTMLElement>(`li.d-call-stage__tile[data-tile-id="${id}"]`)!;
  const focusedIds = () => [...document.querySelectorAll<HTMLElement>('li.d-call-stage__tile[data-focused="true"]')].map(e => e.dataset.tileId);
  const tile = (deviceId: string, userId: string, video: MediaStream | null, screen: MediaStream | null) =>
    ({ deviceId, userId, state: 'ok' as const, speaking: false, video, screen, screenAudio: false });

  it('a participant with a camera and a screen gives two tiles, "bob" and "bob’s screen", with no inset', async () => {
    const app = await inVoice({ voice: room(0) });
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, new MediaStream(), new MediaStream())] }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:screen`));
    expect(ids()).toContain(`${BOB_DEV}:person`);
    expect(within(li(`${BOB_DEV}:person`)).getByRole('button', { name: 'bob' })).toBeInTheDocument();
    expect(within(li(`${BOB_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'bob' }) })).toBeInTheDocument();
    expect(document.querySelector('.d-call-tile__inset')).toBeNull();
  });

  it('a participant who shares only a screen keeps an avatar tile with the volume and the muted glyph', async () => {
    const app = await inVoice({ voice: room(FLAG_MUTE | FLAG_SCREEN) });
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:screen`));
    const person = li(`${BOB_DEV}:person`);
    expect(person).toHaveAttribute('data-source', 'avatar');
    expect(within(person).getByRole('img', { name: 'muted' })).toBeInTheDocument();
    expect(within(person).getByRole('slider')).toBeInTheDocument();
    expect(within(li(`${BOB_DEV}:screen`)).queryByRole('slider')).toBeNull();
    expect(within(li(`${BOB_DEV}:screen`)).queryByRole('img', { name: 'muted' })).toBeNull();
  });

  it('#37: a remote screen without sound shows the mark; with sound it does not; the own screen never does', async () => {
    const app = await inVoice({ voice: room(FLAG_SCREEN) });
    const screenTile = (over: Partial<ReturnType<typeof tile>>) => ({ ...tile(BOB_DEV, BOB, null, new MediaStream()), ...over });
    act(() => app.session.update({ tiles: [screenTile({ screenAudio: false })], sharing: true, localScreen: new MediaStream() }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:screen`));
    expect(within(li(`${BOB_DEV}:screen`)).getByRole('img', { name: t('voice.state.noSound') })).toBeInTheDocument();
    expect(li(`${OWN_DEV}:screen`).querySelector('[data-state="no-sound"]')).toBeNull();
    expect(within(li(`${BOB_DEV}:screen`)).queryByRole('slider')).toBeNull();
    act(() => app.session.update({ tiles: [screenTile({ screenAudio: true })] }));
    await waitFor(() => expect(li(`${BOB_DEV}:screen`).querySelector('[data-state="no-sound"]')).toBeNull());
    // The mark is about the stream, not the person: bob's person tile never says it.
    expect(li(`${BOB_DEV}:person`).querySelector('[data-state="no-sound"]')).toBeNull();
  });

  it('#37 T5: a screen with sound has its own volume and mute; the mute sets the stream volume to 0, then restores it', async () => {
    const app = await inVoice({ voice: room(FLAG_SCREEN), settings: { [`voice.streamVolume.${BOB}`]: '70' } });
    act(() => app.session.update({ tiles: [{ ...tile(BOB_DEV, BOB, null, new MediaStream()), screenAudio: true }] }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:screen`));
    const screenLi = within(li(`${BOB_DEV}:screen`));
    expect(screenLi.getByRole('slider', { name: t('voice.streamVolume', { name: 'bob' }) })).toHaveValue('70');
    expect(screenLi.queryByRole('img', { name: t('voice.state.noSound') })).toBeNull();
    // the person's own voice range is a different range and a different key
    expect(within(li(`${BOB_DEV}:person`)).getByRole('slider', { name: t('voice.volume', { name: 'bob' }) })).toHaveValue('100');
    const mute = screenLi.getByRole('button', { name: t('voice.streamMute') });
    expect(mute).toHaveAttribute('aria-pressed', 'false');
    await app.user.click(mute);
    expect(app.session.setVolume).toHaveBeenCalledWith(BOB, 0, 'stream');
    expect(app.client.callsOf('setSetting')).toContainEqual({ m: 'setSetting', key: `voice.streamVolume.${BOB}`, value: '0' });
    expect(app.client.callsOf('setSetting').some(c => c.key === `voice.volume.${BOB}`)).toBe(false);
  });

  it('an audio-only participant gives one avatar tile', async () => {
    const app = await inVoice({ voice: room(0) });
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:person`));
    expect(ids().filter(i => i?.startsWith(BOB_DEV))).toEqual([`${BOB_DEV}:person`]);
  });

  it('the people of a call this device has not joined are avatar tiles', async () => {
    renderVoiceShell({ voice: room(0) });
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:person`));
    expect(ids()).toContain('c1:person');
  });

  it('the own camera tile is mirrored and the own screen tile is not', async () => {
    const app = await inVoice({ voice: room(0) });
    const cam = new MediaStream();
    const scr = new MediaStream();
    act(() => app.session.update({ camera: true, localCamera: cam, sharing: true, localScreen: scr }));
    await waitFor(() => expect(ids()).toContain(`${OWN_DEV}:screen`));
    expect(li(`${OWN_DEV}:person`).querySelector('video')).toHaveAttribute('data-mirror', 'true');
    expect(li(`${OWN_DEV}:person`).querySelector('video')!.srcObject).toBe(cam);
    expect(li(`${OWN_DEV}:screen`).querySelector('video')).not.toHaveAttribute('data-mirror');
    expect(li(`${OWN_DEV}:screen`).querySelector('video')!.srcObject).toBe(scr);
  });

  it('the person tile keeps its id when the camera goes on and off, so a focused person stays focused', async () => {
    const app = await inVoice({ voice: room(0) });
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] }));
    await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:person`));
    await app.user.click(within(li(`${BOB_DEV}:person`)).getByRole('button', { name: 'bob' }));
    expect(focusedIds()).toEqual([`${BOB_DEV}:person`]);
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, new MediaStream(), null)] }));
    await waitFor(() => expect(li(`${BOB_DEV}:person`)).toHaveAttribute('data-source', 'camera'));
    expect(focusedIds()).toEqual([`${BOB_DEV}:person`]);
    act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] }));
    await waitFor(() => expect(li(`${BOB_DEV}:person`)).toHaveAttribute('data-source', 'avatar'));
    expect(focusedIds()).toEqual([`${BOB_DEV}:person`]);
  });

  it('the own tile and its screen are named by the display name, as the user panel shows it', async () => {
    const app = await inVoice({ voice: room(0) });
    app.client.publish(`members:${A}`, MEMBERS.map(m => m.userId === ME.id ? { ...m, display: 'Ada L' } : m));
    act(() => app.session.update({ sharing: true, localScreen: new MediaStream() }));
    await waitFor(() => expect(ids()).toContain(`${OWN_DEV}:screen`));
    expect(within(li(`${OWN_DEV}:person`)).getByRole('button', { name: 'Ada L' })).toBeInTheDocument();
    expect(within(li(`${OWN_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'Ada L' }) })).toBeInTheDocument();
  });

  describe('R26: auto-focus', () => {
    it('another person’s new screen takes the focus, and the own share does not', async () => {
      const app = await inVoice({ voice: room(0) });
      act(() => app.session.update({ sharing: true, localScreen: new MediaStream() }));
      await waitFor(() => expect(ids()).toContain(`${OWN_DEV}:screen`));
      expect(focusedIds()).toEqual([]);
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
    });

    it('after Escape the same share does not take the focus again, and a second share does not steal it', async () => {
      const app = await inVoice({ voice: room(0) });
      const bobScreen = new MediaStream();
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen)] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen), tile('c1', 'carl', null, new MediaStream())] }));
      await waitFor(() => expect(ids()).toContain('c1:screen'));
      expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]);
      within(li(`${BOB_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'bob' }) }).focus();
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(focusedIds()).toEqual([]));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, new MediaStream(), bobScreen), tile('c1', 'carl', null, new MediaStream())] }));
      await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:person`));
      expect(focusedIds()).toEqual([]);
    });

    it('a pause and a resume, which withhold every remote stream, do not focus an unfocused share again', async () => {
      const app = await inVoice({ voice: room(FLAG_SCREEN) });
      const bobScreen = new MediaStream();
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen)] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      within(li(`${BOB_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'bob' }) }).focus();
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(focusedIds()).toEqual([]));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] })); // paused: the room still says bob shares
      await waitFor(() => expect(ids()).not.toContain(`${BOB_DEV}:screen`));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen)] })); // resumed
      await waitFor(() => expect(ids()).toContain(`${BOB_DEV}:screen`));
      expect(focusedIds()).toEqual([]);
    });

    it('a share that really ended (the room flag is gone) and restarted may focus again', async () => {
      const app = await inVoice({ voice: room(FLAG_SCREEN) });
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      within(li(`${BOB_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'bob' }) }).focus();
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(focusedIds()).toEqual([]));
      app.client.publish('voice', room(0));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] }));
      await waitFor(() => expect(ids()).not.toContain(`${BOB_DEV}:screen`));
      app.client.publish('voice', room(FLAG_SCREEN));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
    });

    it('when the focused share ends, another person’s new share takes the focus', async () => {
      const app = await inVoice({ voice: room(0) });
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null), tile('c1', 'carl', null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual(['c1:screen']));
    });

    it('leaving and joining again starts with a clean set: the same share focuses again', async () => {
      const app = await inVoice({ voice: room(FLAG_SCREEN) });
      const bobScreen = new MediaStream();
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen)] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      within(li(`${BOB_DEV}:screen`)).getByRole('button', { name: t('stage.screen', { name: 'bob' }) }).focus();
      await app.user.keyboard('{Escape}');
      await waitFor(() => expect(focusedIds()).toEqual([]));
      await app.user.click(main().getByRole('button', { name: 'leave' }));
      await main().findByRole('button', { name: 'join voice' });
      await app.user.click(main().getByRole('button', { name: 'join voice' }));
      await waitFor(() => expect(app.sessions).toHaveLength(2));
      app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
      await main().findByRole('toolbar', { name: 'voice channel controls' });
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, bobScreen)] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
    });

    it('the focused tile leaving returns the stage to the grid, and a new share focuses again', async () => {
      const app = await inVoice({ voice: room(0) });
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, null)] }));
      await waitFor(() => expect(ids()).not.toContain(`${BOB_DEV}:screen`));
      expect(focusedIds()).toEqual([]);
      expect(document.querySelector('[data-focused-stage]')).toBeNull();
      act(() => app.session.update({ tiles: [tile(BOB_DEV, BOB, null, new MediaStream())] }));
      await waitFor(() => expect(focusedIds()).toEqual([`${BOB_DEV}:screen`]));
    });
  });
});

// web3.9 (C4): a voice channel's stage opens with the channel header in its 48 bar; a DM call has none.
describe('the voice stage header (web3.9)', () => {
  it('shows the voice channel header in the stage bar on a desktop, with the volume glyph', async () => {
    renderVoiceShell({ path: `/c/${A}/${GENV}` });
    const stage = (await main().findByRole('button', { name: 'join voice' })).closest('section') as HTMLElement;
    const bar = stage.querySelector('.d-call-stage__bar') as HTMLElement;
    expect(within(bar).getByRole('heading', { name: 'general' })).toBeInTheDocument();
    expect(bar.querySelector('svg[data-icon="volume-2"]')).not.toBeNull();
  });

  it('a DM call stage has no channel header', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}` });
    await app.user.click(await main().findByRole('button', { name: 'call' }));
    await main().findByRole('toolbar', { name: 'call controls' });
    expect(document.querySelector('.d-call-stage__bar')).toBeNull();
  });
});

// web3.9 WEB-DOCK (R26): the dock as Discord's: no meter, "voice connected", channel · server, three icon buttons; speaking is a
// ring on the list row and on the tile and nothing else.
describe('WEB-DOCK: the voice dock as Discord\'s, and speaking as a ring', () => {
  const dockEl = () => document.querySelector<HTMLElement>('.dw-voice-dock')!;
  const remote = (speaking: boolean) => [{ deviceId: BOB_DEV, userId: BOB, state: 'ok' as const, speaking, video: null, screen: null, screenAudio: false }];

  it('has no meter, no level text and no line, and keeps the dock to its two lines and three buttons', async () => {
    const app = await inVoice({ settings: { 'voice.mode': 'ptt', 'voice.pttKey': 'Pause' } });
    act(() => app.session.update({ level: 40, audio: { attached: 1, expected: 2 } }));
    await offStage();
    const dock = dockEl();
    expect(dock.querySelector('.d-audio-meter, [role="meter"], .d-voice-dock__meter')).toBeNull();
    expect(dock).not.toHaveTextContent(t('settings.voice.level'));
    expect(dock.querySelector('.dw-voice-dock__mode, [data-audio-expected]')).toBeNull();
  });

  it('line 1 reads "voice connected" and opens Diagnostics; line 2 reads the channel and the server', async () => {
    const app = await inVoice();
    await offStage();
    const status = within(dockEl()).getByRole('button', { name: t('layout.dock.connected') });
    expect(dockEl().querySelector('.d-voice-dock__where')).toHaveTextContent('general · Midgard');
    await app.user.click(status);
    await waitFor(() => expect(window.location.pathname).toBe('/settings/diagnostics'));
  });

  it('camera, share and leave are 32px icon buttons', async () => {
    await inVoice();
    await offStage();
    const buttons = within(screen.getByRole('toolbar', { name: 'voice controls' })).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    for (const b of buttons) { expect(b).toHaveClass('d-icon-button'); expect(b).toHaveAttribute('data-size', '32'); }
  });

  it('a remote tile at volume 70 shows "70 %" in its chip', async () => {
    const app = await inVoice({ settings: { [`voice.volume.${BOB}`]: '70' } });
    act(() => app.session.update({ tiles: remote(false) }));
    await waitFor(() => expect(document.querySelector('.d-call-tile__chip')).toHaveTextContent('70 %'));
  });

  it('a speaking participant has the ring on the list row and on the tile and no other speaking mark', async () => {
    const app = await inVoice({ voice: { [GENV]: { callId: GENV, participants: [
      { userId: BOB, deviceId: BOB_DEV, name: 'bob', flags: 0, own: false, web: false, bot: false },
      { userId: ME.id, deviceId: OWN_DEV, name: 'me', flags: 0, own: true, web: true, bot: false },
    ] } } });
    act(() => app.session.update({ tiles: remote(true) }));
    const tile = await waitFor(() => { const e = document.querySelector('.d-call-tile[data-speaking="true"]'); expect(e).not.toBeNull(); return e!; });
    expect(tile.querySelector('.d-call-tile__avatar-ring')).toHaveAttribute('data-speaking', 'true');
    expect(tile.querySelector('[data-state="speaking"]')).toBeNull();
    await waitFor(() => expect(document.querySelector('.d-voice-row__person[data-speaking="true"]')).not.toBeNull());
    expect(document.querySelector('[data-state="speaking"]')).toBeNull();
    await offStage();
    expect(dockEl().querySelector('[data-speaking], [data-state="speaking"]')).toBeNull();
  });

  it('push to talk and the hearing count stand on the stage, not in the dock', async () => {
    const app = await inVoice({ settings: { 'voice.mode': 'ptt', 'voice.pttKey': 'Pause' } });
    act(() => app.session.update({ audio: { attached: 1, expected: 2 } }));
    const stage = main().getByRole('toolbar', { name: 'voice channel controls' }).closest('.dw-voice-stage')!;
    await waitFor(() => expect(stage.querySelector('.dw-voice-dock__mode')).toHaveTextContent(t('voice.dock.ptt', { key: 'Pause' })));
    expect(stage.querySelector('[data-audio-expected]')).toHaveTextContent(t('voice.diag.tracks', { attached: 1, expected: 2 }));
    expect(dockEl().querySelector('.dw-voice-dock__mode, [data-audio-expected]')).toBeNull();
  });
});

describe('FX2: a "sound from" picker for a share', () => {
  const from = () => main().queryByRole('combobox', { name: t('voice.shareAudio.from') });
  const POOL = { labeled: true, sources: [
    { id: 'mon-1', label: 'Monitor of Built-in Audio', monitor: true },
    { id: 'app-1', label: 'Browser sink', monitor: false },
  ] };
  const silentShare = async () => {
    const app = await inVoice();
    app.session.sharePool = POOL;
    act(() => app.session.update({ sharing: true, shareAudio: 'none', localScreen: new MediaStream() }));
    return app;
  };

  it('offers none and the devices while the share has no sound, and a pick goes to the session', async () => {
    const app = await silentShare();
    const select = await waitFor(() => { const e = from(); expect(e).not.toBeNull(); return e!; });
    expect([...select.querySelectorAll('option')].map(o => o.textContent)).toEqual([
      t('voice.shareAudio.fromNone'), 'Monitor of Built-in Audio', 'Browser sink']);
    await app.user.selectOptions(select, 'app-1');
    expect(app.session.setShareSource).toHaveBeenCalledWith('app-1');
    act(() => app.session.update({ shareSource: 'app-1', shareAudio: 'device' }));
    await waitFor(() => expect(from()).toHaveValue('app-1'));
    await app.user.selectOptions(from()!, '');
    expect(app.session.setShareSource).toHaveBeenLastCalledWith(null);
  });

  it('is not there before a share, nor while the browser gives the share its sound', async () => {
    const app = await inVoice();
    app.session.sharePool = POOL;
    expect(from()).toBeNull();
    act(() => app.session.update({ sharing: true, shareAudio: 'tab', shareSource: 'browser', localScreen: new MediaStream() }));
    await waitFor(() => expect(main().getByRole('button', { name: 'share screen' })).toHaveAttribute('aria-pressed', 'true'));
    expect(from()).toBeNull();
  });

  it('warns about a monitor by its label, and still lets it be picked', async () => {
    const app = await silentShare();
    const select = await waitFor(() => { const e = from(); expect(e).not.toBeNull(); return e!; });
    expect(main().queryByText(t('voice.shareAudio.monitorWarn'))).toBeNull();
    await app.user.selectOptions(select, 'mon-1');
    expect(app.session.setShareSource).toHaveBeenCalledWith('mon-1');
    act(() => app.session.update({ shareSource: 'mon-1', shareAudio: 'device' }));
    expect(await main().findByText(t('voice.shareAudio.monitorWarn'))).toBeInTheDocument();
  });

  it('says the microphone must be allowed when the browser hides the labels', async () => {
    const app = await inVoice();
    app.session.sharePool = { labeled: false, sources: [{ id: 'x', label: '', monitor: false }] };
    act(() => app.session.update({ sharing: true, shareAudio: 'none', localScreen: new MediaStream() }));
    expect(await main().findByText(t('voice.shareAudio.needsPermission'))).toBeInTheDocument();
    expect(from()).toBeNull();
  });

  it('the notice offers "pick a sound source", which moves focus to the select', async () => {
    const app = await silentShare();
    const pick = await main().findByRole('button', { name: t('voice.shareAudio.pick') });
    const select = await waitFor(() => { const e = from(); expect(e).not.toBeNull(); return e!; });
    await app.user.click(pick);
    expect(select).toHaveFocus();
  });
});
