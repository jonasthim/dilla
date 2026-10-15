// Flow 09: the Roles tab of Server settings. Rows of Buttons in the Channels tab's pattern; the editor is RoleEditorFlow.
import { useEffect, useId, useRef, useState } from 'react';
import { Button, ConfirmDialog } from '@dilla/ui';
import type { RoleSummary } from '@dilla/client-core';
import { useCore } from '../../core/context.tsx';
import { errorOf } from '../../core/errors.ts';
import { useSlice } from '../../core/use-slice.ts';
import { t } from '../../strings/index.ts';
import { RoleEditorFlow } from './RoleEditorFlow.tsx';
import { useRun, type SectionProps } from './shared.ts';

type Target = { kind: 'new' } | { kind: 'edit' | 'delete'; id: string } | null;

/** Highest position first; @everyone (the position-0 role) is always last. */
export function orderRoles(all: readonly RoleSummary[], everyoneId: string): RoleSummary[] {
  const rest = all.filter(r => r.id !== everyoneId).sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1));
  return [...rest, ...all.filter(r => r.id === everyoneId)];
}

/**
 * Roles tab: every role with edit, move up, move down and delete, `@everyone` last with edit only. A row at or above my
 * highest role (when I am not the owner) is locked and offers nothing. The up button is missing on the top movable row,
 * the down button on the lowest; focus follows a moved row to its button. Every gate is advisory: the instance decides.
 */
export function RolesSection({ communityId, announce }: SectionProps): React.JSX.Element {
  const client = useCore();
  const base = useId();
  const roles = useSlice(`roles:${communityId}`);
  const access = useSlice(`permissions:${communityId}`);
  const everyoneId = access?.everyoneId ?? '';
  const ordered = roles === undefined ? [] : orderRoles(roles, everyoneId);
  const locked = (r: RoleSummary): boolean => access?.owner !== true && r.position >= (access?.top ?? 0);
  const movable = ordered.filter(r => r.id !== everyoneId && !locked(r));
  const [target, setTarget] = useState<Target>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveAttempt, setMoveAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const moving = useRef(false);
  const actions = useRef<HTMLDivElement>(null);
  const refocus = useRef<{ id: string; direction: 'up' | 'down' } | null>(null);
  const focusNew = useRef(false);
  const focusNewButton = () => actions.current?.querySelector('button')?.focus();

  const live = target !== null && target.kind === 'delete' ? roles?.find(r => r.id === target.id) : undefined;
  // A role that vanishes while its confirm is open (deleted elsewhere) closes the confirm.
  const stale = target !== null && target.kind === 'delete' && roles !== undefined && live === undefined;
  useEffect(() => { if (stale) { focusNew.current = true; setTarget(null); } }, [stale]);
  // After a move the row sits elsewhere: its button gets focus back; if it can no longer move that way, the other one.
  useEffect(() => {
    const want = refocus.current;
    if (want === null) return;
    refocus.current = null;
    const pick = (d: string) => document.querySelector<HTMLButtonElement>(`[data-move="${want.id}:${d}"]`);
    (pick(want.direction) ?? pick(want.direction === 'up' ? 'down' : 'up'))?.focus();
  }, [roles]);
  // After a delete the opener row is gone: focus goes to the new role button.
  useEffect(() => {
    if (target !== null || !focusNew.current) return;
    focusNew.current = false;
    focusNewButton();
  }, [target]);

  const move = (r: RoleSummary, direction: 'up' | 'down') => {
    if (moving.current) return;
    moving.current = true;
    setMoveError(null);
    refocus.current = { id: r.id, direction };
    client.call({ m: 'moveRole', communityId, roleId: r.id, direction }).then(() => {
      refocus.current = null;
      announce(t('roles.moved', { name: r.name }));
    }).catch((e: unknown) => {
      refocus.current = null;
      setMoveError(t('roles.error.move', { name: r.name, code: errorOf(e).code }));
      setMoveAttempt(a => a + 1);
    }).finally(() => { moving.current = false; });
  };
  // The worker reads the roles when a server is selected and publishes nothing on a failed read; selecting it again retries.
  const retry = () => {
    setLoadError(null);
    client.call({ m: 'selectCommunity', communityId }).catch((e: unknown) => setLoadError(t('roles.error.load', { code: errorOf(e).code })));
  };
  // A section opened before the roles arrived reads them once itself; only a failed read offers "try again".
  const absent = roles === undefined;
  useEffect(() => { if (absent) retry(); }, [absent]); // eslint-disable-line react-hooks/exhaustive-deps

  const controls = (r: RoleSummary) => {
    const at = movable.findIndex(x => x.id === r.id);
    return (
      <span className="dw-admin-controls">
        <Button variant="ghost" aria-label={t('roles.editLabel', { name: r.name })} onClick={() => setTarget({ kind: 'edit', id: r.id })}>{t('roles.edit')}</Button>
        {r.id === everyoneId ? null : <>
          {at > 0 ? <Button variant="ghost" data-move={`${r.id}:up`} aria-label={t('roles.upLabel', { name: r.name })} onClick={() => move(r, 'up')}>{t('roles.up')}</Button> : null}
          {at < movable.length - 1 ? <Button variant="ghost" data-move={`${r.id}:down`} aria-label={t('roles.downLabel', { name: r.name })} onClick={() => move(r, 'down')}>{t('roles.down')}</Button> : null}
          <Button variant="ghost" aria-label={t('roles.deleteLabel', { name: r.name })} onClick={() => setTarget({ kind: 'delete', id: r.id })}>{t('roles.delete')}</Button>
        </>}
      </span>
    );
  };

  return (
    <section className="dw-settings-section" aria-labelledby={`${base}-title`}>
      <h2 id={`${base}-title`} tabIndex={-1}>{t('roles.title')}</h2>
      <p>{t('roles.body')}</p>
      <div className="dw-settings-actions" ref={actions}>
        <Button onClick={() => setTarget({ kind: 'new' })}>{t('roles.new')}</Button>
      </div>
      {moveError !== null ? <p key={moveAttempt} role="alert" className="dw-admin-error">{moveError}</p> : null}
      {roles === undefined ? (
        <div className="dw-settings-actions">
          <p aria-busy="true">{t('roles.loading')}</p>
          {loadError !== null ? <>
            <p role="alert" className="dw-admin-error">{loadError}</p>
            <Button variant="ghost" onClick={retry}>{t('roles.retry')}</Button>
          </> : null}
        </div>
      ) : (
        <ul aria-label={t('roles.title')} className="dw-admin-rows dw-role-rows">
          {ordered.map(r => {
            const everyone = r.id === everyoneId;
            const detail = [t(r.members === 1 ? 'roles.row.one' : 'roles.row.other', { count: r.members }), ...(locked(r) ? [t('roles.locked')] : [])];
            return (
              <li key={r.id} className="dw-admin-row">
                <span className="dw-role-text">
                  <span className="dw-admin-name">{everyone ? t('roles.everyone') : r.name}</span>
                  <span className="dw-role-detail">{detail.join(' · ')}</span>
                  {everyone ? <span className="dw-role-detail">{t('roles.everyoneHint')}</span> : null}
                </span>
                {locked(r) ? null : controls(r)}
              </li>
            );
          })}
        </ul>
      )}
      {target?.kind === 'new' || target?.kind === 'edit'
        ? <RoleEditorFlow communityId={communityId} roleId={target.kind === 'edit' ? target.id : null}
          announce={announce} onClose={() => setTarget(null)} />
        : null}
      <DeleteRole communityId={communityId} role={target?.kind === 'delete' ? live ?? null : null} announce={announce}
        onDone={() => { focusNew.current = true; setTarget(null); }} onClose={() => setTarget(null)} />
    </section>
  );
}

function DeleteRole({ communityId, role, announce, onDone, onClose }: {
  communityId: string; role: RoleSummary | null; announce: (m: string) => void; onDone: () => void; onClose: () => void;
}): React.JSX.Element {
  const client = useCore();
  const action = useRun();
  // Keep the last title while closing, so the dialog does not flash empty.
  const last = useRef<RoleSummary | null>(null);
  if (role !== null) last.current = role;
  const name = (role ?? last.current)?.name ?? '';
  return (
    <ConfirmDialog open={role !== null} title={t('roles.deleteTitle', { name })} body={t('roles.deleteBody')}
      confirmLabel={t('roles.deleteConfirm')} busyLabel={t('roles.deleteBusy')} cancelLabel={t('roles.editor.cancel')}
      busy={action.busy} error={action.error} attempt={action.attempt}
      onConfirm={() => {
        if (role === null) return;
        void action.run(() => client.call({ m: 'deleteRole', communityId, roleId: role.id }), e => t('roles.error.delete', { name: role.name, code: e.code }))
          .then(ok => { if (ok) { announce(t('roles.deleted', { name: role.name })); onDone(); } });
      }}
      onClose={() => { if (!action.busy) { action.reset(); onClose(); } }} />
  );
}
