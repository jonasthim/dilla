import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { SETTINGS } from '@dilla/client-core';
import type { Command } from '@dilla/client-core';
import { PHONE_QUERY } from '../layout.ts';
import { t } from '../strings/index.ts';
import { A, callState, GENV, MEMBERS, renderVoiceShell, TEXT, type VoiceHarnessOptions } from '../test/fake-client.ts';
import { ME } from '../test/fixtures.ts';
import { focusUserSettings } from './Shell.tsx';

// web3.8 WS6: the desktop user panel at the bottom left (R23-R25), the call panel above it, settings behind the gear.
function media(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
  // eslint-disable-next-line no-restricted-properties -- clears the tab memory the shell writes
  window.sessionStorage.clear();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

const main = () => within(screen.getByRole('main'));
const panel = () => document.querySelector<HTMLElement>('.d-user-panel');
const inPanel = () => within(panel()!);
const gear = () => inPanel().getByRole('button', { name: t('panel.settings') });
const stageBar = () => within(main().getByRole('toolbar', { name: 'voice channel controls' }));

/** The shell, with the worker's setSetting applied to the settings slice as the real worker publishes it. */
function shell(o: VoiceHarnessOptions = {}) {
  const app = renderVoiceShell({ path: `/c/${A}/${TEXT}`, ...o });
  const inner = app.client.handler;
  app.client.handler = (command: Command) => {
    if (command.m === 'setSetting') {
      const next = { ...(app.client.get('settings') ?? {}) };
      if (command.value === null) delete next[command.key]; else next[command.key] = command.value;
      app.client.publish('settings', next);
    }
    return inner(command);
  };
  return app;
}
const writes = (app: ReturnType<typeof shell>) => app.client.callsOf('setSetting').map(c => c.value);

async function joinVoice(app: ReturnType<typeof shell>) {
  window.history.pushState(null, '', `/c/${A}/${GENV}`);
  act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
  await app.user.click(await main().findByRole('button', { name: 'join voice' }));
  await waitFor(() => expect(app.sessions).toHaveLength(1));
  app.client.publish('call', callState({ phase: 'in', channelId: GENV, callId: GENV }));
  await main().findByRole('toolbar', { name: 'voice channel controls' });
}

describe('the desktop user panel', () => {
  it('shows the display name and @username', async () => {
    const app = shell();
    await screen.findByRole('main');
    expect(inPanel().getByText('@ada')).toBeInTheDocument();
    expect(panel()).toHaveTextContent('ada');
    app.client.publish(`members:${A}`, MEMBERS.map(m => (m.userId === ME.id ? { ...m, display: 'Ada Lovelace' } : m)));
    await waitFor(() => expect(panel()).toHaveTextContent('Ada Lovelace'));
    expect(inPanel().getByText('@ada')).toBeInTheDocument();
  });

  it('outside a call, mute writes voice.self muted and shows pressed; deafen then writes deafened, and again muted', async () => {
    const app = shell();
    await screen.findByRole('main');
    const mute = () => inPanel().getByRole('button', { name: t('voice.mute') });
    const deafen = () => inPanel().getByRole('button', { name: t('voice.deafen') });
    expect(mute()).toHaveAttribute('aria-pressed', 'false');
    await app.user.click(mute());
    expect(writes(app)).toEqual(['muted']);
    expect(app.client.callsOf('setSetting')[0].key).toBe(SETTINGS.voiceSelf);
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'true'));
    await app.user.click(deafen());
    expect(writes(app)).toEqual(['muted', 'deafened']);
    await waitFor(() => expect(deafen()).toHaveAttribute('aria-pressed', 'true'));
    await app.user.click(deafen());
    expect(writes(app)).toEqual(['muted', 'deafened', 'muted']);
    await waitFor(() => expect(deafen()).toHaveAttribute('aria-pressed', 'false'));
    expect(mute()).toHaveAttribute('aria-pressed', 'true');
  });

  it('outside a call, mute from deafened clears the setting (R25), and mute again sets it', async () => {
    const app = shell({ settings: { [SETTINGS.voiceSelf]: 'deafened' } });
    await screen.findByRole('main');
    await app.user.click(inPanel().getByRole('button', { name: t('voice.mute') }));
    expect(writes(app)).toEqual([null]);
    await app.user.click(inPanel().getByRole('button', { name: t('voice.mute') }));
    expect(writes(app)).toEqual([null, 'muted']);
  });

  it('the next join starts muted after a mute before the call', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.click(inPanel().getByRole('button', { name: t('voice.mute') }));
    await joinVoice(app);
    expect(app.module.startPageCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(app.module.startPageCall).mock.calls[0][2].self).toBe('muted');
  });

  it('in a call, mute calls the session and the button follows the session', async () => {
    const app = shell();
    await joinVoice(app);
    await app.user.click(inPanel().getByRole('button', { name: t('voice.mute') }));
    expect(app.log).toContain('muted:true');
    expect(app.session.state.muted).toBe(true);
    expect(inPanel().getByRole('button', { name: t('voice.mute') })).toHaveAttribute('aria-pressed', 'true');
    // The session's own deafen shows on the panel too.
    act(() => app.session.update({ deafened: true }));
    expect(inPanel().getByRole('button', { name: t('voice.deafen') })).toHaveAttribute('aria-pressed', 'true');
  });

  it('the gear opens /settings/devices', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.click(gear());
    expect(window.location.pathname).toBe('/settings/devices');
  });

  it('the name block opens Settings with the mouse and is no tab stop', async () => {
    const app = shell();
    await screen.findByRole('main');
    const who = inPanel().getByText('@ada').closest('.d-user-panel__who') as HTMLElement;
    expect(who).not.toHaveAttribute('role');
    expect(who).not.toHaveAttribute('tabindex');
    await app.user.click(who);
    expect(window.location.pathname).toBe('/settings/devices');
  });

  it('focusUserSettings focuses the gear, where focus returns when Settings closes', async () => {
    shell();
    await screen.findByRole('main');
    focusUserSettings();
    expect(gear()).toHaveFocus();
  });

  it('the rail has no settings button on desktop', async () => {
    shell();
    const rail = await screen.findByRole('navigation', { name: t('shell.rail.label') });
    expect(within(rail).queryByRole('button', { name: t('shell.rail.settings') })).toBeNull();
  });

  it('panel controls are named, and the panel sits in the bottom-left area', async () => {
    shell();
    await screen.findByRole('main');
    expect(screen.getByRole('toolbar', { name: t('panel.region') })).toBeInTheDocument();
    expect(panel()!.closest('.d-app-shell__panel')).not.toBeNull();
  });
});

describe('the R25 unmute row and the announcements outside a call', () => {
  const mute = () => inPanel().getByRole('button', { name: t('voice.mute') });
  const said = () => screen.getByTestId('shell-announcer');

  it('mute, then mute again, writes muted then none and ends unpressed (button)', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.click(mute());
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'true'));
    await app.user.click(mute());
    expect(writes(app)).toEqual(['muted', null]);
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'false'));
  });

  it('mute, then mute again, writes muted then none and ends unpressed (Ctrl+Shift+M)', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'true'));
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    expect(writes(app)).toEqual(['muted', null]);
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'false'));
  });

  it('announces mute and deafen through the shell announcer, from the button and from the shortcut', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.click(mute());
    await waitFor(() => expect(said()).toHaveTextContent(t('voice.announce.muted')));
    await app.user.click(mute());
    await waitFor(() => expect(said()).toHaveTextContent(t('voice.announce.unmuted')));
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    await waitFor(() => expect(said()).toHaveTextContent(t('voice.announce.deafened')));
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    await waitFor(() => expect(said()).toHaveTextContent(t('voice.announce.undeafened')));
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    await waitFor(() => expect(said()).toHaveTextContent(t('voice.announce.unmuted')));
  });
});

describe('the shortcuts outside a call (C-10)', () => {
  it('Ctrl+Shift+M and Ctrl+Shift+D make the same writes as the buttons on desktop', async () => {
    const app = shell();
    await screen.findByRole('main');
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    expect(writes(app)).toEqual(['muted']);
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(writes(app)).toEqual(['muted', 'deafened']);
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(writes(app)).toEqual(['muted', 'deafened', 'muted']);
  });

  it('do nothing on the phone shell', async () => {
    media(true);
    const app = shell();
    await screen.findByRole('navigation', { name: t('nav.tabs.label') });
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    await app.user.keyboard('{Control>}{Shift>}D{/Shift}{/Control}');
    expect(app.client.callsOf('setSetting')).toEqual([]);
    expect(document.querySelector('.d-user-panel')).toBeNull();
  });
});

describe('one set of shortcuts and the call panel (R3)', () => {
  it('exactly one element carries aria-keyshortcuts with Shift+M while the stage is shown, and it is the panel’s', async () => {
    const app = shell();
    await joinVoice(app);
    const carriers = [...document.querySelectorAll('[aria-keyshortcuts*="Shift+M"]')];
    expect(carriers).toHaveLength(1);
    expect(panel()!.contains(carriers[0])).toBe(true);
    expect(document.querySelectorAll('[aria-keyshortcuts*="Shift+D"]')).toHaveLength(1);
    expect(stageBar().getByRole('button', { name: t('voice.mute') })).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('the call panel has camera, share and leave and no mute, and sits above the user panel', async () => {
    const app = shell();
    await joinVoice(app);
    const dock = screen.getByRole('toolbar', { name: 'voice controls' });
    expect(within(dock).getAllByRole('button').map(b => b.getAttribute('aria-label')))
      .toEqual([t('voice.cameraOn'), t('voice.shareOn'), t('voice.leave')]);
    const callPanel = document.querySelector('.dw-voice-dock')!;
    expect(callPanel.compareDocumentPosition(panel()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(callPanel.parentElement).toBe(panel()!.parentElement);
  });

  it('Ctrl+Shift+M in a call toggles the session, once', async () => {
    const app = shell({ settings: {} });
    await joinVoice(app);
    await app.user.keyboard('{Control>}{Shift>}M{/Shift}{/Control}');
    expect(app.log.filter(l => l === 'muted:true')).toHaveLength(1);
    expect(app.client.callsOf('setSetting').map(c => c.value)).toEqual(['muted']);
  });
});

describe('fail closed (security round 1)', () => {
  it('a mute pressed while the join is pending leaves the session muted once it starts', async () => {
    const app = shell();
    await screen.findByRole('main');
    window.history.pushState(null, '', `/c/${A}/${GENV}`);
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    const release = app.holdStart();
    await app.user.click(await main().findByRole('button', { name: 'join voice' }));
    await waitFor(() => expect(app.client.callsOf('callJoin')).toHaveLength(1));
    await app.user.click(inPanel().getByRole('button', { name: t('voice.mute') }));
    expect(writes(app)).toEqual(['muted']);
    // Until the session exists the panel shows the stored setting.
    expect(inPanel().getByRole('button', { name: t('voice.mute') })).toHaveAttribute('aria-pressed', 'true');
    release();
    await waitFor(() => expect(app.sessions).toHaveLength(1));
    await waitFor(() => expect(app.session.state.muted).toBe(true));
    expect(app.log).toContain('muted:true');
    expect(inPanel().getByRole('button', { name: t('voice.mute') })).toHaveAttribute('aria-pressed', 'true');
  });

  it('only ever toward privacy: with no setting the attach changes nothing, and a session started muted is never opened', async () => {
    const app = shell();
    await joinVoice(app);
    expect(app.log.filter(l => l.startsWith('muted:') || l.startsWith('deafened:'))).toEqual([]);
    act(() => app.session.update({ muted: true }));
    expect(app.log).not.toContain('muted:false');
  });

  it('two quick presses read one source: muted, then null', async () => {
    const app = shell();
    await screen.findByRole('main');
    // The worker answers late: the slice still says "none" when the second press lands.
    const inner = app.client.handler;
    const held: (() => void)[] = [];
    app.client.handler = (command: Command) => (command.m === 'setSetting'
      ? new Promise(resolve => { held.push(() => { void inner(command).then(resolve); }); }) : inner(command));
    const mute = () => inPanel().getByRole('button', { name: t('voice.mute') });
    await app.user.click(mute());
    await app.user.click(mute());
    expect(writes(app)).toEqual(['muted', null]);
    held.forEach(h => h());
  });

  it('a refused setSetting leaves the panel showing what is stored, and the next press writes again', async () => {
    const app = shell();
    await screen.findByRole('main');
    const inner = app.client.handler;
    let refuse = true;
    app.client.handler = (command: Command) => (command.m === 'setSetting' && refuse ? Promise.reject(new Error('E_INTERNAL')) : inner(command));
    const mute = () => inPanel().getByRole('button', { name: t('voice.mute') });
    await app.user.click(mute());
    expect(mute()).toHaveAttribute('aria-pressed', 'false');
    refuse = false;
    await app.user.click(mute());
    expect(writes(app)).toEqual(['muted', 'muted']);
    await waitFor(() => expect(mute()).toHaveAttribute('aria-pressed', 'true'));
  });
});
