import { useEffect, useRef, useState } from 'react';
import { Segmented, SettingsRow } from '@dilla/ui';
import { isThemePref, readTheme, writeTheme, type ThemePref } from '../../prefs.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { applyPreference } from '../../theme.ts';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';

const TITLE_ID = 'appearance-title';
const THEMES: readonly { value: ThemePref; key: StringKey }[] = [
  { value: 'system', key: 'appearance.theme.system' },
  { value: 'mesh', key: 'appearance.theme.mesh' },
  { value: 'light', key: 'appearance.theme.light' },
  { value: 'high-contrast', key: 'appearance.theme.contrast' },
];

/**
 * Settings → Appearance (L-TS-26, Q24): the theme. The choice applies at once and is kept in the page's own
 * IndexedDB record, which main.tsx reads before the first paint; a refused write still leaves the theme applied
 * for this page's life.
 */
export function Appearance(): React.JSX.Element {
  const client = useCore();
  const settings = useSlice('settings');
  const [value, setValue] = useState<ThemePref>('system');
  // A choice made before the stored preference arrives wins over it.
  const chosen = useRef(false);
  useEffect(() => {
    let live = true;
    void readTheme().then(stored => { if (live && !chosen.current) setValue(stored); });
    return () => { live = false; };
  }, []);

  const change = (next: string) => {
    if (!isThemePref(next)) return;
    chosen.current = true;
    setValue(next);
    applyPreference(window, next);
    writeTheme(next).catch(() => undefined);
  };
  const density = settings?.density === 'compact' ? 'compact' : 'regular';
  const motion = settings?.reduceMotion === 'on' || settings?.reduceMotion === 'off' ? settings.reduceMotion : 'system';
  const changeDensity = (next: string) => {
    if (next !== 'regular' && next !== 'compact') return;
    document.documentElement.dataset.density = next;
    void client.call({ m: 'setSetting', key: 'density', value: next });
  };
  const changeMotion = (next: string) => {
    if (next !== 'system' && next !== 'on' && next !== 'off') return;
    document.documentElement.dataset.reduceMotion = next;
    void client.call({ m: 'setSetting', key: 'reduceMotion', value: next });
  };

  return (
    <section className="dw-settings-section" aria-labelledby={TITLE_ID}>
      <h2 id={TITLE_ID}>{t('appearance.title')}</h2>
      <SettingsRow id="appearance-theme-row" label={t('appearance.theme.label')}>
        <Segmented id="appearance-theme" label={t('appearance.theme.label')} value={value} onChange={change}
          options={THEMES.map(o => ({ value: o.value, label: t(o.key) }))} />
      </SettingsRow>
      <SettingsRow id="appearance-density-row" label={t('appearance.density.label')}>
        <Segmented id="appearance-density" label={t('appearance.density.label')} value={density} onChange={changeDensity}
          options={[{ value: 'regular', label: t('appearance.density.regular') }, { value: 'compact', label: t('appearance.density.compact') }]} />
      </SettingsRow>
      <SettingsRow id="appearance-motion-row" label={t('appearance.motion.label')}>
        <Segmented id="appearance-motion" label={t('appearance.motion.label')} value={motion} onChange={changeMotion}
          options={[{ value: 'system', label: t('appearance.motion.system') }, { value: 'on', label: t('appearance.motion.reduced') },
            { value: 'off', label: t('appearance.motion.full') }]} />
      </SettingsRow>
    </section>
  );
}
