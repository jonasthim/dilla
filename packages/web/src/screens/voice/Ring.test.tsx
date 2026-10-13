import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { callState, DM, GENV, renderVoiceShell, ring, type VoiceHarnessOptions } from '../../test/fake-client.ts';

afterEach(() => { vi.unstubAllGlobals(); });

const main = () => within(screen.getByRole('main'));

/** In voice 'general': the join answered and the worker reports the call in. */
async function inVoice(o: VoiceHarnessOptions = {}) {
  const app = renderVoiceShell(o);
  await app.user.click(await main().findByRole('button', { name: 'join voice' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
  await main().findByRole('toolbar', { name: 'call controls' });
  return app;
}

describe('rings (flow 06, R1–R8)', () => {
  it('an incoming ring shows the banner, plays the ring and raises one notification; state 0 stops all three', async () => {
    const app = renderVoiceShell({ permission: 'granted', settings: {} });
    app.client.publish('rings', [ring({ busy: false, quiet: false })]);
    expect(await screen.findByRole('alert')).toHaveTextContent('bob is calling');
    expect(app.sounds.ringing).toBe(true);
    expect(app.notifications).toHaveLength(1);
    expect(app.notifications[0].title).toBe('bob is calling');
    expect(app.notifications[0].options).toMatchObject({ body: 'Open dilla to answer.', tag: `dilla-ring-${DM}` });
    expect(document.querySelector('[data-doc-state="call-ring"]')).not.toBeNull();
    // The same ring republished raises nothing new.
    app.client.publish('rings', [ring({ busy: false, quiet: false })]);
    expect(app.notifications).toHaveLength(1);
    app.client.publish('rings', []);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(app.sounds.ringing).toBe(false);
    expect(app.notifications[0].closed).toBe(true);
  });

  it('a busy ring shows the banner with the busy text but plays nothing and notifies nobody', async () => {
    const app = await inVoice({ permission: 'granted' });
    app.client.publish('rings', [ring({ busy: true })]);
    expect(await screen.findByRole('alert')).toHaveTextContent('bob is calling. Answering leaves general.');
    expect(app.sounds.ringing).toBe(false);
    expect(app.notifications).toEqual([]);
  });

  it('a muted DM rings with the banner only (R1)', async () => {
    const app = renderVoiceShell({ permission: 'granted' });
    app.client.publish('rings', [ring({ quiet: true })]);
    expect(await screen.findByRole('alert')).toHaveTextContent('bob is calling');
    expect(app.sounds.ringing).toBe(false);
    expect(app.notifications).toEqual([]);
    expect(app.sounds.played).toEqual([]);
  });

  it('sound.ring off: banner and notification, no ring sound', async () => {
    const app = renderVoiceShell({ permission: 'granted', settings: { 'sound.ring': 'off' } });
    app.client.publish('rings', [ring()]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(app.notifications).toHaveLength(1);
    expect(app.sounds.ringing).toBe(false);
  });

  it('a DM whose notify mode is nothing rings without a notification', async () => {
    const app = renderVoiceShell({ permission: 'granted', settings: { [`notify.channel.${DM}`]: 'nothing' } });
    app.client.publish('rings', [ring()]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(app.notifications).toEqual([]);
    expect(app.sounds.ringing).toBe(true);
  });

  it('notification permission denied or default: banner and sound only, never a permission prompt from a ring', async () => {
    for (const permission of ['denied', 'default'] as const) {
      const app = renderVoiceShell({ permission });
      app.client.publish('rings', [ring()]);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(app.sounds.ringing).toBe(true);
      expect(app.notifications).toEqual([]);
      expect(app.requestPermission).not.toHaveBeenCalled();
      app.view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('no ring sound before the page saw a user activation; the banner still shows', async () => {
    const app = renderVoiceShell({ permission: 'granted', activated: false });
    app.client.publish('rings', [ring()]);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(app.sounds.ringing).toBe(false);
    expect(app.notifications).toHaveLength(1);
  });

  it('answer runs callJoin for the DM (leaving the current voice first when busy); decline runs callDecline', async () => {
    const app = await inVoice();
    app.client.publish('rings', [ring({ busy: true })]);
    await screen.findByRole('alert');
    // While it shows, the banner's buttons are the first controls of the main landmark.
    const buttons = main().getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('answer');
    expect(buttons[1]).toHaveTextContent('decline');
    const before = app.client.calls.length;
    await app.user.click(main().getByRole('button', { name: 'answer' }));
    await waitFor(() => expect(app.client.callsOf('callJoin').map(c => c.channelId)).toEqual([GENV, DM]));
    const after = app.client.calls.slice(before).filter(c => c.m === 'callLeave' || c.m === 'callJoin');
    expect(after).toEqual([{ m: 'callLeave', reason: 'switch' }, { m: 'callJoin', channelId: DM, vdec: 'vp8' }]);
    await waitFor(() => expect(window.location.pathname).toBe(`/dm/${DM}`));
    app.client.publish('rings', []);
    app.client.publish('call', callState({ phase: 'in', channelId: DM, callId: DM }));
    await waitFor(() => expect(main().getByRole('toolbar', { name: 'call controls' }).querySelector('button')).toHaveFocus());
    // A new ring is declined.
    const next = ring({ callId: 'ab'.repeat(16), channelId: 'ab'.repeat(16), ringTs: 1_900_000_100, callerName: 'carol' });
    app.client.publish('rings', [next]);
    await screen.findByRole('alert');
    expect(main().getAllByRole('button')[0]).toHaveTextContent('answer');
    await app.user.click(main().getByRole('button', { name: 'decline' }));
    expect(app.client.calls.at(-1)).toEqual({ m: 'callDecline', callId: 'ab'.repeat(16), ringTs: 1_900_000_100 });
  });

  it('a ring never moves focus', async () => {
    const app = renderVoiceShell({ path: `/dm/${DM}` });
    const composer = await screen.findByRole('textbox', { name: 'message @bob' });
    composer.focus();
    app.client.publish('rings', [ring()]);
    await screen.findByRole('alert');
    expect(composer).toHaveFocus();
  });

  it('clicking the notification focuses the window, opens the DM and closes it', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const app = renderVoiceShell({ permission: 'granted' });
    app.client.publish('rings', [ring()]);
    await screen.findByRole('alert');
    app.notifications[0].onclick?.(new Event('click'));
    expect(focus).toHaveBeenCalled();
    await waitFor(() => expect(window.location.pathname).toBe(`/dm/${DM}`));
    expect(app.notifications[0].closed).toBe(true);
  });
});
