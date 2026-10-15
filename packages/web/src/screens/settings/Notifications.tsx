import { useEffect, useRef, useState } from 'react';
import { isMuted, SETTINGS } from '@dilla/client-core';
import { Banner, Button, Segmented, SettingsRow, Toggle } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice, useSlices } from '../../core/use-slice.ts';
import { askPermission, readPermission, type PermissionState } from '../../notify-permission.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { orderChannels } from '../shell-model.ts';

const TITLE_ID = 'notify-title';
const DEFAULTS: readonly { value: string; key: StringKey }[] = [
  { value: 'dms-mentions', key: 'notify.default.dmsMentions' },
  { value: 'everything', key: 'notify.default.everything' },
  { value: 'nothing', key: 'notify.default.nothing' },
];
const MODES: readonly { value: string; key: StringKey }[] = [
  { value: 'default', key: 'notify.channel.default' },
  { value: 'all', key: 'notify.channel.all' },
  { value: 'mentions', key: 'notify.channel.mentions' },
  { value: 'nothing', key: 'notify.channel.nothing' },
];
const SERVER_MODES: readonly { value: string; key: StringKey }[] = [
  { value: 'default', key: 'serverNotify.mode.default' },
  { value: 'all', key: 'serverNotify.mode.all' },
  { value: 'mentions', key: 'serverNotify.mode.mentions' },
  { value: 'nothing', key: 'serverNotify.mode.nothing' },
];
const PERMISSION_TEXT: Readonly<Record<Exclude<PermissionState, 'default'>, StringKey>> = {
  granted: 'notify.permission.granted',
  denied: 'notify.permission.denied',
  unsupported: 'notify.permission.unsupported',
};

/**
 * Settings → Notifications (Q09, Q30, L-TS-25). The browser's permission is read on render and asked for only
 * from the click of its button. The default and every text channel's and DM's mode and mute are written with
 * setSetting; the section keeps no copy of a setting and renders what the worker republishes.
 */
export function Notifications(): React.JSX.Element {
  const client = useCore();
  const communities = useSlice('communities') ?? [];
  const lists = useSlices(communities.map(c => `channels:${c.id}` as const));
  const dms = useSlice('dms') ?? [];
  const settings = useSlice('settings') ?? {};
  const [permission, setPermission] = useState<PermissionState>(() => readPermission());
  const [error, setError] = useState<UiError | null>(null);
  // After the ask button gives way to the answer, focus moves to the answer rather than to the page body.
  const answerRef = useRef<HTMLParagraphElement>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked && permission !== 'default') answerRef.current?.focus();
  }, [asked, permission]);

  const ask = () => {
    void askPermission().then(state => { setPermission(state); setAsked(true); });
  };
  const write = (key: string, value: string | null) => {
    setError(null);
    client.call({ m: 'setSetting', key, value }).catch((e: unknown) => setError(errorOf(e)));
  };

  const rows = [
    ...communities.flatMap((community, i) => orderChannels(lists[i] ?? [])
      .filter(c => c.kind === 0 && c.mode === 0)
      .map(c => ({ hex: c.id, label: t('notify.title.channel', { channel: c.name, server: community.name }) }))),
    ...dms.map(dm => ({ hex: dm.id, label: t('notify.title.dm', { sender: dm.name }) })),
  ];

  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID} tabIndex={-1}>{t('notify.title')}</h2>
      {error === null ? null : <Banner tone="danger">{t('settings.error.other', { code: error.code })}</Banner>}
      <p>{t('notify.body')}</p>
      <SettingsRow id="notify-permission" label={t('notify.permission.label')}>
        {permission === 'default'
          ? <Button size="sm" onClick={ask}>{t('notify.permission.ask')}</Button>
          : <p ref={answerRef} tabIndex={-1} className="dw-settings-answer">{t(PERMISSION_TEXT[permission])}</p>}
      </SettingsRow>
      <SettingsRow id="notify-default-row" label={t('notify.default.label')}>
        <Segmented id="notify-default" label={t('notify.default.label')}
          options={DEFAULTS.map(o => ({ value: o.value, label: t(o.key) }))}
          value={settings[SETTINGS.notifyDefault] ?? 'dms-mentions'}
          onChange={value => write(SETTINGS.notifyDefault, value)} />
      </SettingsRow>
      {/* Flow 06 § Sounds (R4): both on by default; each is an on/off switch. */}
      <h3>{t('settings.notify.sounds')}</h3>
      <SettingsRow id="sound-voice-row" label={t('settings.sound.voice')}>
        <Toggle id="sound-voice" label={t('settings.sound.voice')} checked={settings[SETTINGS.soundVoice] !== 'off'}
          onChange={on => write(SETTINGS.soundVoice, on ? 'on' : 'off')} />
      </SettingsRow>
      <SettingsRow id="sound-ring-row" label={t('settings.sound.ring')}>
        <Toggle id="sound-ring" label={t('settings.sound.ring')} checked={settings[SETTINGS.soundRing] !== 'off'}
          onChange={on => write(SETTINGS.soundRing, on ? 'on' : 'off')} />
      </SettingsRow>
      <h3>{t('serverNotify.title')}</h3>
      <p>{t('serverNotify.body')}</p>
      <ul className="dw-notify-list">
        {communities.map(community => (
          <li key={community.id}>
            <SettingsRow id={`notify-server-${community.id}`} label={community.name}>
              <div className="dw-notify-controls">
                <Segmented id={`notify-server-mode-${community.id}`} label={community.name}
                  options={SERVER_MODES.map(o => ({ value: o.value, label: t(o.key) }))}
                  value={settings[SETTINGS.notifyCommunity(community.id)] ?? 'default'}
                  onChange={value => write(SETTINGS.notifyCommunity(community.id), value === 'default' ? null : value)} />
                <Toggle id={`notify-server-mute-${community.id}`} label={t('serverNotify.mute')} showLabel
                  checked={settings[SETTINGS.muteCommunity(community.id)] === '1'}
                  onChange={on => write(SETTINGS.muteCommunity(community.id), on ? '1' : null)} />
                <Toggle id={`notify-server-everyone-${community.id}`} label={t('serverNotify.suppressEveryone')} showLabel
                  checked={settings[SETTINGS.everyoneCommunity(community.id)] === '1'}
                  onChange={on => write(SETTINGS.everyoneCommunity(community.id), on ? '1' : null)} />
              </div>
            </SettingsRow>
          </li>
        ))}
      </ul>
      <h3>{t('notify.channels.title')}</h3>
      <p>{t('notify.channels.body')}</p>
      <ul className="dw-notify-list">
        {rows.map(row => (
          <li key={row.hex}>
            <SettingsRow id={`notify-row-${row.hex}`} label={row.label}>
              <div className="dw-notify-controls">
                <Segmented id={`notify-mode-${row.hex}`} label={row.label}
                  options={MODES.map(o => ({ value: o.value, label: t(o.key) }))}
                  value={settings[SETTINGS.notifyChannel(row.hex)] ?? 'default'}
                  onChange={value => write(SETTINGS.notifyChannel(row.hex), value === 'default' ? null : value)} />
                <Toggle id={`notify-mute-${row.hex}`} label={t('notify.mute')} checked={isMuted(settings, row.hex)} showLabel
                  onChange={on => write(SETTINGS.muteChannel(row.hex), on ? '1' : null)} />
              </div>
            </SettingsRow>
          </li>
        ))}
      </ul>
    </section>
  );
}
