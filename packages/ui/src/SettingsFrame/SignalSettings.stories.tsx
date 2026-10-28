import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSyncExternalStore, type ReactNode } from 'react';
import { SettingsFrame } from './SettingsFrame.tsx';
import { SettingsNav } from '../SettingsNav/SettingsNav.tsx';
import { SettingsRow } from '../SettingsRow/SettingsRow.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { Toggle } from '../Toggle/Toggle.tsx';
import { Button } from '../Button/Button.tsx';
import { KeyboardTable } from '../KeyboardTable/KeyboardTable.tsx';
import { VoiceSettings } from '../VoiceSettings/VoiceSettings.tsx';
import { DeviceRow } from '../DeviceRow/DeviceRow.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
// The shipped copy and section registry of @dilla/web, so these whole screens draw what Settings draws.
import { t } from '../../../web/src/strings/index.ts';
import { SETTINGS_ICONS, SETTINGS_REGISTRY } from '../../../web/src/settings/registry.ts';
import '../../../web/src/settings/workspace.css';

/**
 * Task 10, restyle rule 3e: the whole Settings workspace as packages/web composes it (screens/Settings.tsx: the identity,
 * SettingsNavigation's search field and SettingsNav with the registry's groups and glyphs, sign out after it; each section
 * as its screens/settings/*.tsx draws it), at 1280 × 800 and on a 390 × 844 phone.
 */
const meta: Meta = { title: 'Settings/SignalSettings', parameters: { layout: 'fullscreen' } };
export default meta;
type Story = StoryObj;
const noop = () => {};

const PHONE_QUERY = '(max-width: 47.99rem), (pointer: coarse) and (max-height: 31.99rem)';
function subscribe(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
const snapshot = () => window.matchMedia(PHONE_QUERY).matches;
function Responsive({ children }: { children: ReactNode }) {
  return <PhoneLayoutProvider value={useSyncExternalStore(subscribe, snapshot, () => false)}>{children}</PhoneLayoutProvider>;
}

const USER = SETTINGS_REGISTRY.filter(entry => entry.scope === 'user');
function Workspace({ active, children }: { active: string; children: ReactNode }) {
  const nav = <>
    <div className="dw-settings-search">
      <label htmlFor="s-search">{t('workspace.search')}</label>
      <input id="s-search" type="search" autoComplete="off" spellCheck={false} />
    </div>
    <SettingsNav label={t('settings.nav.label')} activeId={active} onSelect={noop}
      items={USER.map(entry => ({ id: entry.id, label: t(entry.labelKey), group: t(entry.group), icon: SETTINGS_ICONS[entry.id] }))} />
    <div className="dw-settings-signout"><Button variant="danger">{t('workspace.signOut')}</Button></div>
  </>;
  const identity = <div className="dw-settings-identity"><strong>Mira</strong><span>{t('workspace.username', { username: 'mira' })}</span></div>;
  return (
    <Responsive>
      <SettingsFrame open title={t('settings.title')} closeLabel={t('settings.close')} onClose={noop} nav={nav} identity={identity} phonePage="section">
        {children}
      </SettingsFrame>
    </Responsive>
  );
}

const DEFAULTS = [
  { value: 'dms-mentions', label: t('notify.default.dmsMentions') }, { value: 'everything', label: t('notify.default.everything') },
  { value: 'nothing', label: t('notify.default.nothing') },
];
const MODES = [
  { value: 'default', label: t('notify.channel.default') }, { value: 'all', label: t('notify.channel.all') },
  { value: 'mentions', label: t('notify.channel.mentions') }, { value: 'nothing', label: t('notify.channel.nothing') },
];
// screens/settings/Notifications.tsx with one server (Midgard Crew), its #general and one direct message.
function Notifications() {
  const general = t('notify.title.channel', { channel: 'general', server: 'Midgard Crew' });
  return (
    <section className="dw-settings-section" aria-labelledby="notify-title">
      <h2 id="notify-title" tabIndex={-1}>{t('notify.title')}</h2>
      <p>{t('notify.body')}</p>
      <SettingsRow id="notify-permission" icon="monitor-smartphone" label={t('notify.permission.label')}><Button size="sm">{t('notify.permission.ask')}</Button></SettingsRow>
      <SettingsRow id="notify-default-row" icon="bell" label={t('notify.default.label')}>
        <Segmented id="notify-default" label={t('notify.default.label')} options={DEFAULTS} value="dms-mentions" onChange={noop} />
      </SettingsRow>
      <h3>{t('settings.notify.sounds')}</h3>
      <SettingsRow id="sound-voice-row" icon="volume-2" label={t('settings.sound.voice')}>
        <Toggle id="sound-voice" label={t('settings.sound.voice')} checked onChange={noop} />
      </SettingsRow>
      <SettingsRow id="sound-ring-row" icon="volume-2" label={t('settings.sound.ring')}>
        <Toggle id="sound-ring" label={t('settings.sound.ring')} checked={false} onChange={noop} />
      </SettingsRow>
      <h3>{t('notify.channels.title')}</h3>
      <p>{t('notify.channels.body')}</p>
      <ul className="dw-notify-list">
        <li><SettingsRow id="notify-row-general" icon="hash" label={general}>
          <div className="dw-notify-controls">
            <Segmented id="notify-mode-general" label={general} options={MODES} value="default" onChange={noop} />
            <Toggle id="notify-mute-general" label={t('notify.mute')} checked={false} showLabel onChange={noop} />
          </div>
        </SettingsRow></li>
        <li><SettingsRow id="notify-row-ada" icon="at-sign" label={t('notify.title.dm', { sender: 'Ada' })}>
          <div className="dw-notify-controls">
            <Segmented id="notify-mode-ada" label="Ada" options={MODES} value="all" onChange={noop} />
            <Toggle id="notify-mute-ada" label={t('notify.mute')} checked={false} showLabel onChange={noop} />
          </div>
        </SettingsRow></li>
      </ul>
    </section>
  );
}

// screens/settings/Voice.tsx: VoiceSettings with the shipped labels and MicrophoneTest in its Mic test section.
function Voice({ ptt }: { ptt?: boolean }) {
  return (
    <section className="dw-settings-section" aria-labelledby="voice-settings-title">
      <h2 id="voice-settings-title" tabIndex={-1}>{t('settings.voice.section')}</h2>
      <p>{t('signalSettings.voice.body')}</p>
      <VoiceSettings inputs={[{ id: 'yeti', label: 'Blue Yeti' }]} outputs={[{ id: 'phones', label: 'Headphones' }]} input="" output=""
        canSelectOutput mode={ptt ? 'ptt' : 'vad'} pttKey={ptt ? 'F13' : null} capturing={false} noise="automatic" level={0}
        labels={{ input: t('settings.voice.input'), output: t('settings.voice.output'), systemDefault: t('settings.voice.systemDefault'),
          outputUnsupported: t('settings.voice.outputUnsupported'), mode: t('settings.voice.mode'), vad: t('settings.voice.vad'),
          ptt: t('settings.voice.ptt'), pttKey: t('settings.voice.pttKey'), pttNone: t('settings.voice.pttNone'), pttSet: t('settings.voice.pttSet'),
          pttPrompt: t('settings.voice.pttPrompt'), pttRefused: t('settings.voice.pttRefused'), noise: t('settings.voice.noise'),
          automatic: t('settings.voice.automatic'), lightweight: t('settings.voice.lightweight'), off: t('settings.voice.off'), level: t('settings.voice.level'),
          devices: t('signalSettings.voice.devices'), test: t('signalSettings.voice.test'), inputMode: t('signalSettings.voice.inputMode'), processing: t('signalSettings.voice.processing'),
          pttHint: t('signalSettings.voice.pttHint'),
          noiseHints: { automatic: t('signalSettings.voice.noiseHint.automatic'), lightweight: t('signalSettings.voice.noiseHint.lightweight'), off: t('signalSettings.voice.noiseHint.off') } }}
        test={<div data-setting="voice-test"><div>
          <p>{t('settings.voice.testHelp')}</p>
          <button type="button" className="d-btn">{t('settings.voice.test')}</button>
          <p role="status" />
        </div></div>}
        onInput={noop} onOutput={noop} onMode={noop} onCaptureKey={noop} onNoise={noop} />
      <p>{t('settings.voice.noisePending')}</p>
    </section>
  );
}

/** README §5.9: a chord such as 'Control/⌘+Shift+M' is drawn as one keycap per key. */
const caps = (chord: string): string[] => chord.split(/\+(?=.)/);
// screens/settings/Keyboard.tsx.
function Keyboard() {
  return (
    <section className="dw-settings-section" aria-labelledby="keyboard-title">
      <h2 id="keyboard-title" tabIndex={-1}>{t('keyboard.title')}</h2>
      <p>{t('signalSettings.keyboard.body')}</p>
      <KeyboardTable caption={t('keyboard.title')} rows={[
        { action: t('search.open'), keys: caps(t('keyboard.searchAll')) },
        { action: t('search.scope.channel'), keys: caps(t('keyboard.searchChannel')) },
        { action: t('keyboard.muteAction'), keys: caps(t('keyboard.mute')) },
        { action: t('keyboard.deafenAction'), keys: caps(t('keyboard.deafen')) },
        { action: t('keyboard.dmCallAction'), keys: caps(t('keyboard.dmCall')) },
      ]} />
      <p><button type="button" className="d-link">{t('settings.nav.voice')}</button></p>
    </section>
  );
}

// screens/settings/Devices.tsx with this browser and one more.
function Devices() {
  return (
    <section className="dw-settings-section" aria-labelledby="devices-title">
      <h2 id="devices-title" tabIndex={-1}>{t('devices.title')}</h2>
      <p>{t('devices.body')}</p>
      <ul className="dw-device-list">
        <DeviceRow name="3f9a2c1d" tier="web" tierLabel={t('devices.tier.web')} own ownLabel={t('devices.thisBrowser')} lastSeen={t('devices.lastSeen', { when: '21:04' })} />
        <DeviceRow name="b2d4e6f8" tier="native" tierLabel={t('devices.tier.native')} lastSeen={t('devices.lastSeen', { when: '21:02' })}
          action={{ label: t('devices.revoke'), onAction: noop, danger: true }} />
      </ul>
      <SettingsRow id="devices-signout" icon="log-out" label={t('devices.signOutTitle')}><Button variant="danger">{t('devices.signOut')}</Button></SettingsRow>
      <SettingsRow id="devices-forget" icon="trash-2" label={t('devices.forgetTitle')}><Button>{t('devices.forget')}</Button></SettingsRow>
    </section>
  );
}

export const NotificationsDesktop: Story = { render: () => <Workspace active="notifications"><Notifications /></Workspace> };
export const VoiceDesktop: Story = { render: () => <Workspace active="voice"><Voice /></Workspace> };
export const VoicePushToTalk: Story = { render: () => <Workspace active="voice"><Voice ptt /></Workspace> };
export const KeyboardDesktop: Story = { render: () => <Workspace active="keyboard"><Keyboard /></Workspace> };
export const DevicesDesktop: Story = { render: () => <Workspace active="devices"><Devices /></Workspace> };
export const NotificationsPhone: Story = { parameters: { phoneViewport: true }, render: () => <Workspace active="notifications"><Notifications /></Workspace> };
export const VoicePhone: Story = { parameters: { phoneViewport: true }, render: () => <Workspace active="voice"><Voice /></Workspace> };
