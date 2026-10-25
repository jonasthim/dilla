import { KeyboardTable } from '@dilla/ui';
import { t } from '../../strings/index.ts';
import { useRoute } from '../../router.ts';

/**
 * The modifier shortcuts: search (web-2c, Flow 05) and, while in voice, mute and deafen (web-3, flow 06); there is no
 * unmodified global shortcut (decision 1, WCAG 2.1.4). One table (I3): the action on the left, its chord on the right.
 */
export function Keyboard(): React.JSX.Element {
  const [, navigate] = useRoute();
  return <section className="dw-settings-section" aria-labelledby="keyboard-title"><h2 id="keyboard-title" tabIndex={-1}>{t('keyboard.title')}</h2>
    <KeyboardTable caption={t('keyboard.title')} rows={[
      { action: t('search.open'), keys: [t('keyboard.searchAll')] },
      { action: t('search.scope.channel'), keys: [t('keyboard.searchChannel')] },
      { action: t('keyboard.muteAction'), keys: [t('keyboard.mute')] },
      { action: t('keyboard.deafenAction'), keys: [t('keyboard.deafen')] },
    ]} />
    <p><button type="button" className="d-link" onClick={() => navigate({ name: 'settings', section: 'voice', from: null }, true)}>{t('settings.nav.voice')}</button></p>
  </section>;
}
