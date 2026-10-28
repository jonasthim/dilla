import { KeyboardTable } from '@dilla/ui';
import { t } from '../../strings/index.ts';

/** README §5.9: a chord such as 'Control/⌘+Shift+M' is drawn as one keycap per key. */
const caps = (chord: string): string[] => chord.split(/\+(?=.)/);
/**
 * The modifier shortcuts: search (web-2c, Flow 05) and, while in voice, mute and deafen (web-3, flow 06); there is no
 * unmodified global shortcut (decision 1, WCAG 2.1.4). One table (I3): the action on the left, its chord on the right.
 */
export function Keyboard(): React.JSX.Element {
  return <section className="dw-settings-section" aria-labelledby="keyboard-title"><h2 id="keyboard-title" tabIndex={-1}>{t('keyboard.title')}</h2><p>{t('signalSettings.keyboard.body')}</p>
    <KeyboardTable caption={t('keyboard.title')} rows={[
      // Task 9 fix round 2: both chords open the one palette (no scoped search any more), so one Search row carries both.
      { action: t('signalSettings.keyboard.search'), keys: [t('keyboard.searchAll'), t('keyboard.searchChannel')] },
      { action: t('keyboard.muteAction'), keys: caps(t('keyboard.mute')) },
      { action: t('keyboard.deafenAction'), keys: caps(t('keyboard.deafen')) },
      // Ruling Z: the DM call lives in the DM row's menu and under this chord, not as a header button.
      { action: t('keyboard.dmCallAction'), keys: caps(t('keyboard.dmCall')) },
    ]} />
  </section>;
}
