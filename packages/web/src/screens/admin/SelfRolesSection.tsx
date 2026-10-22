// Server Settings → Self-service roles: managers approve eligible roles; members opt into approved roles.
import { useEffect, useId, useRef, useState } from 'react';
import type { RoleSummary } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { errorOf, type UiError } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { PERM } from '@dilla/client-core';
import { type SectionProps } from './shared.ts';

type SelfRole = { id: string; name: string; position: number; selfSelected: boolean };
const requestId = (): string => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const SELF_ROLE_BITS = PERM.viewChannel | PERM.sendMessages | PERM.attachFiles | PERM.addReactions | PERM.readHistory
  | PERM.connect | PERM.speak | PERM.video | PERM.screenShare;

function errorMessage(error: UiError): string {
  if (error.code === 'E_FORBIDDEN' || error.status === 403) return t('admin.bot.error.forbidden');
  if (error.status === 409 || error.code === 'E_CONFLICT') return t('admin.bot.error.conflict');
  return t('admin.bot.error.other', { code: error.code });
}

export function SelfRolesSection({ communityId, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const [selfRoles, setSelfRoles] = useState<SelfRole[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const read = ++generation.current;
    setSelfRoles([]); setLoadedFor(null); setError(null);
    void client.call({ m: 'listSelfRoles', communityId }).then(value => {
      if (read !== generation.current) return;
      setSelfRoles(Array.isArray(value) ? value as SelfRole[] : []); setLoadedFor(communityId);
    }).catch((e: unknown) => {
      if (read !== generation.current) return;
      setError(errorMessage(errorOf(e))); setLoadedFor(communityId);
    });
    const revision = generation;
    return () => { revision.current++; };
  }, [client, communityId]);

  const configure = (roleIds: string[]) => {
    if (busy || loadedFor !== communityId || !access?.manageRoles) return;
    const read = generation.current;
    setBusy(true); setError(null);
    void client.call({ m: 'configureSelfRoles', communityId, requestId: requestId(), roleIds }).then(() => {
      if (read !== generation.current) return;
      const selected = new Set(roleIds);
      setSelfRoles(current => [
        ...current.filter(row => selected.has(row.id)),
        ...(roles ?? []).filter(role => selected.has(role.id) && !current.some(row => row.id === role.id))
          .map(role => ({ id: role.id, name: role.name, position: role.position, selfSelected: false })),
      ]);
      announce(t('admin.bot.selfRoles.saved'));
    }).catch((e: unknown) => { if (read === generation.current) setError(errorMessage(errorOf(e))); })
      .finally(() => { if (read === generation.current) setBusy(false); });
  };

  const select = (roleId: string, enabled: boolean) => {
    if (busy || loadedFor !== communityId) return;
    const read = generation.current;
    setBusy(true); setError(null);
    void client.call({ m: 'selectSelfRole', communityId, roleId, requestId: requestId(), enabled }).then(() => {
      if (read === generation.current) setSelfRoles(current => current.map(row => row.id === roleId ? { ...row, selfSelected: enabled } : row));
    }).catch((e: unknown) => { if (read === generation.current) setError(errorMessage(errorOf(e))); })
      .finally(() => { if (read === generation.current) setBusy(false); });
  };

  const candidates: RoleSummary[] = (roles ?? []).filter(role => role.position > 0 && (role.allow & ~SELF_ROLE_BITS) === 0
    && (role.deny & ~SELF_ROLE_BITS) === 0 && (access?.owner === true || role.position < (access?.top ?? 0)));
  const approved = new Set(selfRoles.map(row => row.id));

  return <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
    <h2 id={`${base}-title`} tabIndex={-1}>{t('admin.bot.selfRoles.title')}</h2>
    {loadedFor !== communityId ? <p aria-busy="true">{t('admin.bot.loading')}</p> : null}
    {loadedFor === communityId && access?.manageRoles ? <fieldset disabled={busy}>
      <legend>{t('admin.bot.selfRoles.configure')}</legend>
      {candidates.map(role => <label key={role.id}><input type="checkbox" checked={approved.has(role.id)}
        onChange={event => configure(event.currentTarget.checked ? [...approved, role.id] : [...approved].filter(id => id !== role.id))} /> {role.name}</label>)}
    </fieldset> : null}
    {loadedFor === communityId && selfRoles.length > 0 ? <fieldset disabled={busy}>
      <legend>{t('admin.bot.selfRoles.select')}</legend>
      {selfRoles.map(role => <label key={role.id}><input type="checkbox" checked={role.selfSelected}
        onChange={event => select(role.id, event.currentTarget.checked)} /> {role.name}</label>)}
    </fieldset> : null}
    {loadedFor === communityId && error === null && selfRoles.length === 0 ? <p>{t('admin.bot.selfRoles.empty')}</p> : null}
    {error === null ? null : <p role="alert">{error}</p>}
  </section>;
}
