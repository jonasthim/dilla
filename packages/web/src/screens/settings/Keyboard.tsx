import { t } from '../../strings/index.ts';

export function Keyboard(): React.JSX.Element {
  return <section className="dw-settings-section" aria-labelledby="keyboard-title"><h2 id="keyboard-title" tabIndex={-1}>{t('settings.nav.keyboard')}</h2>
    <ul><li><span>{t('keyboard.searchAll')}</span> {t('search.open')}</li><li>{t('keyboard.searchChannel')} {t('search.scope.channel')}</li></ul>
  </section>;
}
