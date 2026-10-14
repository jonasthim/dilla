import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import {
  A, BOB, bobChanged, callState, DM, GENV, MUSIC, renderVoiceShell, TEXT, type VoiceHarnessOptions,
} from '../../test/fake-client.ts';

afterEach(() => { vi.unstubAllGlobals(); });

const main = () => within(screen.getByRole('main'));
const UMK = { code: 'E_UMK_CHANGED', detail: '', status: 0, retryAfterMs: null };

/** Joins voice 'general' from its voice view; the worker then reports the call in. */
async function inVoice(o: VoiceHarnessOptions = {}) {
  const app = renderVoiceShell(o);
  await app.user.click(await main().findByRole('button', { name: 'join voice' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
  await main().findByRole('toolbar', { name: 'call controls' });
  return app;
}

describe('voice in the shell', () => {
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
    await waitFor(() => expect(main().getByRole('toolbar', { name: 'call controls' }).querySelector('button')).toHaveFocus());
    expect(screen.getByRole('toolbar', { name: 'voice controls' })).toBeInTheDocument();
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
  it('an unmount while the start is pending leaves the session when it resolves', async () => {
    const { app, release } = await start();
    app.view.unmount();
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('user'));
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
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'call controls' })).toBeNull());
    void app;
  };

  it('I1: a block after a pause that already rendered leaves and never unpauses', async () => {
    const app = await inVoice();
    app.client.publish('call', callState({ phase: 'paused', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.setPaused).toHaveBeenCalledWith(true));
    app.client.publish('call', callState({ phase: 'blocked', channelId: GENV, callId: GENV, error: UMK, changedUser: BOB }));
    await waitFor(() => expect(app.session.leave).toHaveBeenCalledWith('blocked'));
    expect(app.session.setPaused).not.toHaveBeenCalledWith(false);
    expect(screen.queryByRole('toolbar', { name: 'call controls' })).toBeNull();
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
    expect(screen.getByRole('toolbar', { name: 'voice controls' }).parentElement).toHaveTextContent(t('settings.voice.ptt'));
    app.client.publish('settings', { 'voice.pttKey': 'F13' });
    expect(app.session.setMode).toHaveBeenLastCalledWith('vad');
    expect(screen.getByRole('toolbar', { name: 'voice controls' }).parentElement).toHaveTextContent(t('settings.voice.vad'));
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
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing: { ringing: ['bob'], declined: [] } }));
    const status = () => document.querySelector('.d-voice-dock [role="status"]');
    await waitFor(() => expect(status()).toHaveTextContent('ringing bob'));
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM, outgoing: { ringing: [], declined: ['bob'] } }));
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
    expect(main().getByText(t('voice.blockedJoin'))).toBeInTheDocument();
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

  it('the own tile shows speaking from the input level', async () => {
    const app = await inVoice();
    const own = () => document.querySelector('.d-call-tile[data-own="true"]');
    expect(own()).toHaveAttribute('data-speaking', 'false');
    act(() => app.session.update({ level: 8 }));
    expect(own()).toHaveAttribute('data-speaking', 'true');
    act(() => app.session.update({ level: 8, muted: true }));
    expect(own()).toHaveAttribute('data-speaking', 'false');
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
