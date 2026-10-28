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
      // Task 9 fix round 2: both chords open the one palette (no scoped search any more).
      { action: t('search.open'), keys: [t('keyboard.searchAll'), t('keyboard.searchChannel')] },
      { action: t('keyboard.muteAction'), keys: [t('keyboard.mute')] },
      { action: t('keyboard.deafenAction'), keys: [t('keyboard.deafen')] },
      // Ruling Z: the DM call lives in the DM row's menu and under this chord, not as a header button.
      { action: t('keyboard.dmCallAction'), keys: [t('keyboard.dmCall')] },
    ]} />
    <p><button type="button" className="d-link" onClick={() => void navigate({ name: 'settings', section: 'voice', from: null }, true)}>{t('settings.nav.voice')}</button></p>
  </section>;
}
