import { t } from '../../strings/index.ts';

/**
 * The modifier shortcuts: search (web-2c, Flow 05) and, while in voice, mute and deafen (web-3, flow 06); there is no
 * unmodified global shortcut (decision 1, WCAG 2.1.4).
 */
export function Keyboard(): React.JSX.Element {
  return <section className="dw-settings-section" aria-labelledby="keyboard-title"><h2 id="keyboard-title" tabIndex={-1}>{t('keyboard.title')}</h2>
    <ul><li><kbd>{t('keyboard.searchAll')}</kbd> {t('search.open')}</li><li><kbd>{t('keyboard.searchChannel')}</kbd> {t('search.scope.channel')}</li>
      <li><kbd>{t('keyboard.mute')}</kbd> {t('keyboard.muteAction')}</li><li><kbd>{t('keyboard.deafen')}</kbd> {t('keyboard.deafenAction')}</li></ul>
  </section>;
}
