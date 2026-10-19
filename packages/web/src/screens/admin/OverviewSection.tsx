import { useEffect, useId, useRef, useState } from 'react';
import { Button, Select, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
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
  const afk = useSlice(`afk:${communityId}`);
  const channels = useSlice(`channels:${communityId}`);
  const [afkChannel, setAFKChannel] = useState('');
  const [afkTimeout, setAFKTimeout] = useState(300);
  const [afkDirty, setAFKDirty] = useState(false);
  const [afkLoaded, setAFKLoaded] = useState(false);
  const [afkLoadError, setAFKLoadError] = useState(false);
  const afkAction = useRun();
  useEffect(() => {
    if (afkDirty) return;
    let cancelled = false;
    setAFKLoaded(false);
    void client.call({ m: 'getAFKSettings', communityId }).then(value => {
      if (cancelled) return;
      if (typeof value !== 'object' || value === null || !('channelId' in value) || !('timeoutSeconds' in value) ||
        !(value.channelId === null || typeof value.channelId === 'string') || typeof value.timeoutSeconds !== 'number') {
        throw new Error('invalid AFK settings');
      }
      setAFKChannel(value.channelId ?? '');
      setAFKTimeout(value.timeoutSeconds);
      setAFKLoaded(true);
      setAFKLoadError(false);
    }).catch(() => { if (!cancelled) { setAFKLoadError(true); setAFKLoaded(false); } });
    return () => { cancelled = true; };
  }, [client, communityId, afk, afkDirty]);
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
      <div className="dw-admin-form" aria-busy={!afkLoaded}>
        <h3>{t('admin.afk.title')}</h3>
        <p>{t('admin.afk.hint')}</p>
        <Select label={t('admin.afk.channel')} value={afkChannel} disabled={!afkLoaded || afkAction.busy}
          options={[{ value: '', label: t('admin.afk.disabled') }, ...(channels ?? []).filter(ch => ch.kind === 1)
            .map(ch => ({ value: ch.id, label: ch.name })),
          ...(afkChannel && !(channels ?? []).some(ch => ch.id === afkChannel) ?
            [{ value: afkChannel, label: t('admin.afk.restricted') }] : [])]}
          onChange={value => { setAFKChannel(value); setAFKDirty(true); afkAction.reset(); }} />
        <Select label={t('admin.afk.timeout')} value={String(afkTimeout)} disabled={!afkLoaded || afkAction.busy}
          options={[1, 5, 15, 30, 60].map(n => ({ value: String(n * 60), label: t('admin.afk.minutes', { n }) }))}
          onChange={value => { setAFKTimeout(Number(value)); setAFKDirty(true); afkAction.reset(); }} />
        <div className="dw-settings-actions">
          <Button variant="accent" disabled={!afkDirty || afkAction.busy || !afkLoaded}
            onClick={() => { void afkAction.run(() => client.call({ m: 'setAFK', communityId, channelId: afkChannel || null,
              timeoutSeconds: afkTimeout }), e => t('admin.afk.error', { code: e.code })).then(ok => {
              if (ok) { setAFKDirty(false); announce(t('admin.afk.saved')); }
            }); }}>{t('admin.afk.save')}</Button>
          {afkAction.error ? <p role="alert">{afkAction.error}</p> : null}
          {afkLoadError ? <p role="alert">{t('admin.afk.loadError')}</p> : null}
        </div>
      </div>
    </section>
  );
}
