import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { t } from '../../strings/index.ts';
import {
  BOB, bobChanged, callState, DM, GENV, MUSIC, renderVoiceShell, type VoiceHarnessOptions,
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
