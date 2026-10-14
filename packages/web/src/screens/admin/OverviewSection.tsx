import { useEffect, useId, useRef, useState } from 'react';
import { Button, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { t } from '../../strings/index.ts';
import { SERVER_NAME_MAX_BYTES, nameProblem } from '../Create.tsx';
import { forbidden, refused, statusIs, useRun, type SectionProps } from './shared.ts';

/** Overview: rename the server. The name is checked as the instance checks it; a 409 means someone changed it meanwhile. */
export function OverviewSection({ communityId, serverName, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const fieldId = `${base}-name`;
  const [name, setName] = useState(serverName);
  const [saved, setSaved] = useState(false);
  // A refusal found before asking the server, and how many refusals of either kind were shown.
  const [local, setLocal] = useState<{ message: string; n: number } | null>(null);
  const action = useRun();
  // A rename made elsewhere reaches the field only if nothing is being typed (the field still holds the name last shown).
  const shownName = useRef(serverName);
  useEffect(() => {
    const before = shownName.current;
    shownName.current = serverName;
    setName(current => (current === before ? serverName : current));
  }, [serverName]);
  const error = local?.message ?? action.error;
  const shown = (local?.n ?? 0) + action.attempt;
  // A refusal puts focus in the field that holds it, also when the save button was pressed.
  useEffect(() => {
    if (shown > 0) document.getElementById(fieldId)?.focus();
  }, [shown, fieldId]);

  const submit = () => {
    if (action.busy) return;
    setSaved(false);
    const problem = nameProblem(name, SERVER_NAME_MAX_BYTES);
    if (problem !== null) {
      const key = problem === 'empty' ? 'admin.overview.error.empty' : problem === 'long' ? 'admin.overview.error.long' : 'admin.overview.error.refused';
      setLocal(l => ({ message: t(key), n: (l?.n ?? 0) + 1 }));
      return;
    }
    setLocal(null);
    void action.run(() => client.call({ m: 'renameCommunity', communityId, name: name.trim() }), e =>
      statusIs(e, 409) ? t('admin.overview.error.conflict')
        : forbidden(e) ? t('admin.overview.error.forbidden')
          : refused(e) ? t('admin.overview.error.refused')
            : t('admin.overview.error.other', { code: e.code }))
      .then(ok => { if (ok) { setSaved(true); announce(t('admin.overview.saved')); } });
  };

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t('admin.overview.title')}</h2>
      <form className="dw-admin-form" noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
        <TextField id={fieldId} label={t('admin.overview.name')} value={name}
          onChange={v => { setName(v); setSaved(false); setLocal(null); action.reset(); }} hint={t('admin.overview.hint')}
          error={error ?? undefined} required autoComplete="off" spellCheck={false} />
        <div className="dw-settings-actions">
          <Button type="submit" variant="accent" aria-disabled={action.busy || undefined}>
            {action.busy ? t('admin.overview.saving') : t('admin.overview.save')}
          </Button>
          {saved ? <p>{t('admin.overview.saved')}</p> : null}
        </div>
      </form>
    </section>
  );
}
