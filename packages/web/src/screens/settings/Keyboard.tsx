import { t } from '../../strings/index.ts';

/** The two modifier shortcuts web-2c binds (Flow 05 keyboard map); there is no unmodified global shortcut. */
export function Keyboard(): React.JSX.Element {
  return <section className="dw-settings-section" aria-labelledby="keyboard-title"><h2 id="keyboard-title" tabIndex={-1}>{t('settings.nav.keyboard')}</h2>
    <ul><li><kbd>{t('keyboard.searchAll')}</kbd> {t('search.open')}</li><li><kbd>{t('keyboard.searchChannel')}</kbd> {t('search.scope.channel')}</li></ul>
  </section>;
}
