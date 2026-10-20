import { useId, useRef, useState } from 'react';
import type { PresenceChoice } from '@dilla/client-core';
import { Icon } from '@dilla/ui';
import { useCore } from '../core/context.tsx';
import { useSlice } from '../core/use-slice.ts';
import { t } from '../strings/index.ts';

const CHEVRON = 'chevron-down';
const CHECK = 'check';
const CHOICES: readonly PresenceChoice[] = ['online', 'idle', 'dnd', 'invisible'];

/**
 * One account-wide preference, shared by every signed-in device. A 44 row of the phone's row grammar (H6) naming the choice;
 * it opens the four choices as rows under it, and a choice closes them and returns focus to the row.
 */
export function PresencePicker(): React.JSX.Element {
  const client = useCore();
  const listId = useId();
  const choice = useSlice('account')?.presenceChoice ?? 'online';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLButtonElement>(null);
  const choose = (next: PresenceChoice) => {
    setOpen(false);
    row.current?.focus();
    if (next === choice) return;
    setPending(true); setError(false);
    void client.call({ m: 'setPresenceChoice', choice: next }).catch(() => setError(true)).finally(() => setPending(false));
  };
  return <div className="dw-presence-picker">
    <button ref={row} type="button" className="dw-phone-row" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-disabled={pending ? true : undefined} onClick={() => { if (!pending) setOpen(o => !o); }}>
      <span className="dw-phone-row__text">
        <span className="dw-phone-row__meta">{t('presence.label')}</span>
        <span>{t(`presence.${choice}`)}</span>
      </span>
      <Icon name={CHEVRON} size={18} />
    </button>
    {open ? <div id={listId} role="group" aria-label={t('presence.label')} className="dw-presence-picker__choices">
      {CHOICES.map(value => (
        <button key={value} type="button" className="dw-phone-row" aria-pressed={value === choice} onClick={() => choose(value)}>
          <span className="dw-phone-row__text"><span>{t(`presence.${value}`)}</span></span>
          {value === choice ? <Icon name={CHECK} size={18} /> : null}
        </button>
      ))}
    </div> : null}
    {error ? <span role="alert" className="dw-phone-row__meta">{t('presence.error')}</span> : null}
  </div>;
}
