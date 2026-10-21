import { useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Select, SettingsFooter, SettingsRow, TextField } from '@dilla/ui';
import { useCore } from '../../core/context.tsx';
import { useSlice } from '../../core/use-slice.ts';
import { t, type StringKey } from '../../strings/index.ts';
import { SERVER_NAME_MAX_BYTES, nameProblem } from '../Create.tsx';
import { GifsSettings } from './GifsSettings.tsx';
import { FooterSlot, forbidden, refused, statusIs, useRun, type SectionProps } from './shared.ts';

/** Overview: rename the server. The name is checked as the instance checks it; a 409 means someone changed it meanwhile. */
export function OverviewSection({ communityId, serverName, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const fieldId = `${base}-name`;
  const [name, setName] = useState(serverName);
  const [saved, setSaved] = useState(false);
  // A refusal found before asking the server, and how many refusals of either kind were shown.
  const [local, setLocal] = useState<{ message: string; n: number } | null>(null);
  const footerEl = useContext(FooterSlot);
  const action = useRun();
  const afk = useSlice(`afk:${communityId}`);
  const channels = useSlice(`channels:${communityId}`);
  // web3.9: the AFK channel is built in, so the setting is only the inactive timeout. `afkBase` is the stored one.
  const [afkTimeout, setAFKTimeout] = useState(300);
  const [afkBase, setAFKBase] = useState<number | null>(null);
  const [afkLoadError, setAFKLoadError] = useState(false);
  const afkEdited = useRef(false);
  const failedStep = useRef<'name' | 'afk'>('name');
  useEffect(() => {
    let cancelled = false;
    void client.call({ m: 'getAFKSettings', communityId }).then(value => {
      if (cancelled) return;
      if (typeof value !== 'object' || value === null || !('timeoutSeconds' in value) || typeof value.timeoutSeconds !== 'number') {
        throw new Error('invalid AFK settings');
      }
      setAFKBase(value.timeoutSeconds);
      if (!afkEdited.current) setAFKTimeout(value.timeoutSeconds);
      setAFKLoadError(false);
    }).catch(() => { if (!cancelled) setAFKLoadError(true); });
    return () => { cancelled = true; };
  }, [client, communityId, afk]);
  const afkName = (channels ?? []).find(ch => ch.id === afk?.channelId)?.name ?? 'AFK';
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
    const timeoutChanged = afkBase !== null && afkTimeout !== afkBase;
    const problem = nameProblem(name, SERVER_NAME_MAX_BYTES);
    if (problem !== null) {
      const key = problem === 'empty' ? 'admin.overview.error.empty' : problem === 'long' ? 'admin.overview.error.long' : 'admin.overview.error.refused';
      setLocal(l => ({ message: t(key), n: (l?.n ?? 0) + 1 }));
      return;
    }
    setLocal(null);
    // One save: the name, then the timeout, which is sent only when it changed.
    void action.run(async () => {
      failedStep.current = 'name';
      await client.call({ m: 'renameCommunity', communityId, name: name.trim() });
      if (timeoutChanged) { failedStep.current = 'afk'; await client.call({ m: 'setAFK', communityId, timeoutSeconds: afkTimeout }); }
    }, e => failedStep.current === 'afk' ? t('admin.afk.error', { code: e.code })
      : statusIs(e, 409) ? t('admin.overview.error.conflict')
        : forbidden(e) ? t('admin.overview.error.forbidden')
          : refused(e) ? t('admin.overview.error.refused')
            : t('admin.overview.error.other', { code: e.code }))
      .then(ok => { if (ok) { afkEdited.current = false; setSaved(true); } });
  };

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t('admin.overview.title')}</h2>
      {/* One save bar for the section (R17), drawn into the frame's footer; the button submits this form from there. */}
      <form id={`${base}-form`} className="dw-overview-form" noValidate onSubmit={e => { e.preventDefault(); submit(); }}>
        <SettingsRow id={`${base}-name-row`} label={t('admin.overview.name')} hint={t('admin.overview.hint')}>
          <div className="dw-overview-field">
            <TextField id={fieldId} label={t('admin.overview.name')} value={name}
              onChange={v => { setName(v); setSaved(false); setLocal(null); action.reset(); }}
              error={error ?? undefined} required autoComplete="off" spellCheck={false} />
          </div>
        </SettingsRow>
        <SettingsRow id={`${base}-afk-row`} label={t('afk.timeout.label')} hint={t('afk.timeout.hint', { channel: afkName })}>
          <Select label={t('afk.timeout.label')} value={String(afkTimeout)} disabled={afkBase === null || action.busy}
            options={[1, 5, 15, 30, 60].map(n => ({ value: String(n * 60), label: t(`afk.timeout.${n * 60}` as StringKey) }))}
            onChange={value => { afkEdited.current = true; setAFKTimeout(Number(value)); setSaved(false); action.reset(); }} />
          {afkLoadError ? <p role="alert">{t('admin.afk.loadError')}</p> : null}
        </SettingsRow>
      </form>
      {/* E8: the Giphy key has its own save and remove, so it sits outside the one save bar. */}
      <GifsSettings communityId={communityId} announce={announce} />
      {footerEl === null ? null : createPortal(
        <SettingsFooter status={saved ? t('admin.overview.saved') : undefined}>
          <Button type="submit" form={`${base}-form`} variant="accent" aria-disabled={action.busy || undefined}>
            {action.busy ? t('admin.overview.saving') : t('admin.overview.save')}
          </Button>
        </SettingsFooter>, footerEl)}
    </section>
  );
}
