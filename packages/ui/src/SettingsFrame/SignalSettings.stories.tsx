import type { Meta, StoryObj } from '@storybook/react-vite';
import { useSyncExternalStore, type ReactNode } from 'react';
import { SettingsFrame } from './SettingsFrame.tsx';
import { SettingsNav } from '../SettingsNav/SettingsNav.tsx';
import { SettingsRow } from '../SettingsRow/SettingsRow.tsx';
import { Segmented } from '../Segmented/Segmented.tsx';
import { Toggle } from '../Toggle/Toggle.tsx';
import { KeyboardTable } from '../KeyboardTable/KeyboardTable.tsx';
import { VoiceSettings } from '../VoiceSettings/VoiceSettings.tsx';
import { DeviceRow } from '../DeviceRow/DeviceRow.tsx';
import { PhoneLayoutProvider } from '../internal/phoneLayout.ts';
// The shipped copy and section registry of @dilla/web, so these whole screens draw what Settings draws.
import { t } from '../../../web/src/strings/index.ts';
import { SETTINGS_ICONS, SETTINGS_REGISTRY } from '../../../web/src/settings/registry.ts';
import '../../../web/src/settings/workspace.css';

/**
 * Task 10, restyle rule 3e: the whole Settings workspace as packages/web composes it (fix round 1: one workspace; the nav is
 * settings/SettingsNavigation.tsx's "You" group and the selected server's group under its name, with only the sections an
 * owner may use; each section as its screens/settings/*.tsx draws it), at 1280 × 800 and on a 390 × 844 phone.
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

const SERVER = 'Midgard Crew';
// An owner's server sections (availableSettings('server', access) with every permission).
const ITEMS = [
  ...SETTINGS_REGISTRY.filter(entry => entry.scope === 'user')
    .map(entry => ({ id: entry.id, label: t(entry.labelKey), group: t(entry.group), icon: SETTINGS_ICONS[entry.id] })),
  ...SETTINGS_REGISTRY.filter(entry => entry.scope === 'server')
    .map(entry => ({ id: `server:${entry.id}`, label: t(entry.labelKey), group: SERVER, icon: SETTINGS_ICONS[entry.id] })),
];
function Workspace({ active, children }: { active: string; children: ReactNode }) {
  const nav = <SettingsNav label={t('settings.nav.label')} activeId={active} onSelect={noop} items={ITEMS} />;
  return (
    <Responsive>
      <SettingsFrame open title={t('settings.title')} closeLabel={t('settings.close')} onClose={noop} nav={nav} phonePage="section">
        {children}
      </SettingsFrame>
    </Responsive>
  );
}

const MODES = [
  { value: 'all', label: t('notify.mode.all') }, { value: 'mentions', label: t('notify.mode.mentions') }, { value: 'nothing', label: t('notify.mode.nothing') },
];
// screens/settings/Notifications.tsx (fix round 1): the prototype's four rows for the selected server.
function Notifications() {
  return (
    <section className="dw-settings-section" aria-labelledby="notify-title">
      <h2 id="notify-title" tabIndex={-1}>{t('notify.title')}</h2>
      <p>{t('notify.sub')}</p>
      <SettingsRow id="notify-server" icon="bell" label={SERVER} hint={t('notify.server.hint')}>
        <Segmented id="notify-server-mode" label={t('notify.server.label', { server: SERVER })} options={MODES} value="mentions" onChange={noop} />
      </SettingsRow>
      <SettingsRow id="notify-everyone" icon="at-sign" label={t('notify.everyone.label')} hint={t('notify.everyone.hint')}>
        <Toggle id="notify-everyone-switch" label={t('notify.everyone.label')} checked onChange={noop} />
      </SettingsRow>
      <SettingsRow id="notify-desktop" icon="monitor-smartphone" label={t('notify.desktop.label')} hint={t('notify.desktop.hint')}>
        <Toggle id="notify-desktop-switch" label={t('notify.desktop.label')} checked={false} onChange={noop} />
      </SettingsRow>
      <SettingsRow id="notify-sounds" icon="volume-2" label={t('notify.sounds.label')} hint={t('notify.sounds.hint')}>
        <Toggle id="notify-sounds-switch" label={t('notify.sounds.label')} checked onChange={noop} />
      </SettingsRow>
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
          noiseHints: { automatic: t('signalSettings.voice.noiseHint.automatic'), lightweight: t('signalSettings.voice.noiseHint.lightweight'), off: t('signalSettings.voice.noiseHint.off') },
          noiseTag: t('signalSettings.voice.noiseTag') }}
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
        { action: t('signalSettings.keyboard.search'), keys: caps(t('keyboard.searchAll')) },
        { action: t('signalSettings.keyboard.searchChannel'), keys: caps(t('keyboard.searchChannel')) },
        { action: t('keyboard.muteAction'), keys: caps(t('keyboard.mute')) },
        { action: t('keyboard.deafenAction'), keys: caps(t('keyboard.deafen')) },
        { action: t('keyboard.dmCallAction'), keys: caps(t('keyboard.dmCall')) },
      ]} />
      <p><button type="button" className="d-link">{t('settings.nav.voice')}</button></p>
    </section>
  );
}

// screens/settings/Devices.tsx (fix round 1) with this browser and one more: the prototype's rows, Sign out on this browser's.
function Devices() {
  return (
    <section className="dw-settings-section" aria-labelledby="devices-title">
      <h2 id="devices-title" tabIndex={-1}>{t('devices.title')}</h2>
      <p>{t('devices.body')}</p>
      <ul className="dw-device-list">
        <DeviceRow name="3f9a2c1d" tier="web" own ownLabel={t('devices.thisBrowser')} lastSeen={t('devices.lastSeen', { when: '21:04' })}
          extraAction={{ label: t('devices.rename'), onAction: noop }} action={{ label: t('workspace.signOut'), onAction: noop }} />
        <DeviceRow name="b2d4e6f8" tier="native" lastSeen={t('devices.lastSeen', { when: '21:02' })}
          extraAction={{ label: t('devices.rename'), onAction: noop }} action={{ label: t('devices.revoke'), onAction: noop, danger: true }} />
      </ul>
    </section>
  );
}

export const NotificationsDesktop: Story = { render: () => <Workspace active="notifications"><Notifications /></Workspace> };
export const ProfilePhone: Story = { parameters: { phoneViewport: true }, render: () => <Workspace active="profile"><section className="dw-settings-section" aria-labelledby="p-title"><h2 id="p-title">{t('workspace.profile')}</h2></section></Workspace> };
export const VoiceDesktop: Story = { render: () => <Workspace active="voice"><Voice /></Workspace> };
export const VoicePushToTalk: Story = { render: () => <Workspace active="voice"><Voice ptt /></Workspace> };
export const KeyboardDesktop: Story = { render: () => <Workspace active="keyboard"><Keyboard /></Workspace> };
export const DevicesDesktop: Story = { render: () => <Workspace active="devices"><Devices /></Workspace> };
export const NotificationsPhone: Story = { parameters: { phoneViewport: true }, render: () => <Workspace active="notifications"><Notifications /></Workspace> };
export const VoicePhone: Story = { parameters: { phoneViewport: true }, render: () => <Workspace active="voice"><Voice /></Workspace> };
