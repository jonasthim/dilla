import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import {
  A, BOB, bobChanged, callState, DM, GENV, MUSIC, renderVoiceShell, TEXT, type VoiceHarnessOptions,
} from '../../test/fake-client.ts';
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
    act(() => app.session.update({ phase: 'ended', error: 'E_CALL_ENDED' }));
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
    expect(screen.queryByRole('toolbar', { name: 'voice controls' })).toBeNull();
    expect(screen.getByText('in general')).toBeInTheDocument();
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

  it('lists who is in voice under the rows, with the active voice heading and the voice heading', async () => {
    renderVoiceShell({ voice: { [GENV]: { callId: GENV, participants: [
      { userId: BOB, deviceId: '29'.repeat(16), name: 'bob', flags: 1 | 2, own: false, web: true, bot: false },
    ] } } });
    expect(await screen.findByRole('heading', { name: 'active voice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'voice' })).toBeInTheDocument();
    expect(screen.getAllByText('bob').length).toBeGreaterThan(0);
    expect(screen.getAllByText('muted').length).toBeGreaterThan(0);
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
    expect(document.activeElement?.closest('.dw-voice-section__item')).toContainElement(screen.getByRole('button', { name: 'voice general' }));
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

describe('web3.4 V2: the dock says how many it hears', () => {
  it('shows "hearing {attached} of {expected}" with its counts while any remote audio is expected, and nothing otherwise', async () => {
    const app = await inVoice();
    const line = () => document.querySelector('.dw-voice-dock [data-audio-expected]');
    expect(line()).toBeNull();
    // Deafened: a newcomer's track is expected but held back.
    act(() => app.session.update({ audio: { attached: 1, expected: 2 } }));
    const shown = await waitFor(() => { const l = line(); expect(l).not.toBeNull(); return l!; });
    expect(shown).toHaveTextContent(t('voice.diag.tracks', { attached: 1, expected: 2 }));
    expect(shown).toHaveAttribute('data-audio-attached', '1');
    expect(shown).toHaveAttribute('data-audio-expected', '2');
    // A diagnostic, not news: no status region of its own (the dock's one region says what changes).
    expect(shown.closest('[role="status"]')).toBeNull();
    await expectNoAxeViolations(document.querySelector('.dw-voice-dock')!);
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
    await app.user.click(screen.getByRole('button', { name: 'voice music' }));
    await waitFor(() => expect(window.location.pathname).toContain(MUSIC));
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.log).toContain('leave:switch'));
    // While the switch’s leave runs, the person picks general again: the music join is superseded before it started.
    await app.user.click(screen.getByRole('button', { name: 'voice general' }));
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
  const stage = () => within(main().getByRole('toolbar', { name: 'voice channel controls' }));
  // jsdom has no getDisplayMedia; the stage and the dock both read it, so give them one.
  const withCapture = () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn() } });
  };
  afterEach(() => { Reflect.deleteProperty(navigator, 'mediaDevices'); });

  it('the dock holds mute, deafen, camera, share screen and leave, and its camera and share are the stage’s toggles', async () => {
    withCapture();
    const app = await inVoice();
    await offStage();
    expect(dock().getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual([t('voice.mute'), t('voice.deafen'), t('voice.cameraOn'), t('voice.shareOn'), t('voice.leave')]);
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
    for (const name of [t('voice.mute'), t('voice.deafen'), t('voice.leave')]) expect(dock().getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
  });

  it('while joining, the dock’s camera and share are aria-disabled; mute, deafen and leave stay live', async () => {
    withCapture();
    const app = renderVoiceShell();
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.client.callsOf('callJoin')).toHaveLength(1));
    await offStage();
    for (const name of [t('voice.cameraOn'), t('voice.shareOn')]) expect(dock().getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
    for (const name of [t('voice.mute'), t('voice.deafen'), t('voice.leave')]) expect(dock().getByRole('button', { name })).not.toHaveAttribute('aria-disabled');
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
    await waitFor(() => expect(dock().getByRole('button', { name: t('voice.cameraOn') })).not.toHaveAttribute('aria-disabled'));
    expect(dock().getByRole('button', { name: t('voice.shareOn') })).not.toHaveAttribute('aria-disabled');
  });

  it('the dock’s and the stage’s mute and deafen are described by their shortcut, as this platform writes it', async () => {
    await inVoice();
    expect(stage().getByRole('button', { name: t('voice.mute') })).toHaveAccessibleDescription('Ctrl+Shift+M');
    await offStage();
    expect(dock().getByRole('button', { name: t('voice.mute') })).toHaveAccessibleDescription('Ctrl+Shift+M');
    expect(dock().getByRole('button', { name: t('voice.deafen') })).toHaveAccessibleDescription('Ctrl+Shift+D');
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
  it('the dock has no toolbar while the stage is shown, and the toolbar as before off the stage', async () => {
    const app = await inVoice();
    const dockToolbar = () => document.querySelector('.dw-voice-dock .d-voice-dock__controls');
    expect(document.querySelector('.dw-voice-dock')).not.toBeNull();
    expect(dockToolbar()).toBeNull();
    window.history.pushState(null, '', `/c/${A}/${TEXT}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'voice channel controls' })).toBeNull());
    expect(dockToolbar()).not.toBeNull();
    void app;
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

  it('on desktop the share button stays, aria-disabled', async () => {
    asPhone(false);
    await inVoice();
    const share = within(main().getByRole('toolbar', { name: 'voice channel controls' })).getByRole('button', { name: t('voice.shareOn') });
    expect(share).toHaveAttribute('aria-disabled', 'true');
  });
});
