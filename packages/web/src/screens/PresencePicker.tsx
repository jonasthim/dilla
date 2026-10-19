import { useId, useState } from 'react';
import type { PresenceChoice } from '@dilla/client-core';
import { useCore } from '../core/context.tsx';
import { useSlice } from '../core/use-slice.ts';
import { t } from '../strings/index.ts';

const CHOICES: readonly PresenceChoice[] = ['online', 'idle', 'dnd', 'invisible'];

/** One account-wide preference, shared by every signed-in device. */
export function PresencePicker(): React.JSX.Element {
  const client = useCore();
  const id = useId();
  const choice = useSlice('account')?.presenceChoice ?? 'online';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  return <span className="dw-presence-picker">
    <label htmlFor={id}>{t('presence.label')}</label>
    <select id={id} value={choice} disabled={pending} onChange={event => {
      const next = event.target.value as PresenceChoice;
      setPending(true); setError(false);
      void client.call({ m: 'setPresenceChoice', choice: next }).catch(() => setError(true)).finally(() => setPending(false));
    }}>
      {CHOICES.map(value => <option key={value} value={value}>{t(`presence.${value}`)}</option>)}
    </select>
    {error ? <span role="alert">{t('presence.error')}</span> : null}
  </span>;
}
